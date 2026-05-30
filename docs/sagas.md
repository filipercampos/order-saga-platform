# Saga paths

Sequence diagrams for every path of the order saga. Every arrow between services is
`outbox → SNS → SQS → inbox` (ADR 0004). The diagrams show the message, not that plumbing.
Commands travel on `saga-commands.fifo` (one FIFO group per order); replies on
`inventory-events` / `payment-events`.

State machine: [ADR 0002](adr/0002-orchestrated-saga.md). Integration tests that run each
path against real Postgres, MongoDB and LocalStack: [`test/saga.int-spec.ts`](../test/saga.int-spec.ts).

## 1. Happy path

```mermaid
sequenceDiagram
  autonumber
  actor C as Customer
  participant O as order (orchestrator)
  participant I as inventory
  participant P as payment
  participant L as ledger API
  participant N as notification
  C->>O: POST /orders (JWT, Idempotency-Key)
  O->>O: tx: order + saga(RESERVING_STOCK) + outbox[OrderPlaced, ReserveStock]
  O-->>C: 202 {orderId, PENDING}
  O->>I: ReserveStock
  I->>I: tx: lock products (sku order), decrement, reservation RESERVED, outbox[StockReserved]
  I->>O: StockReserved {lines, total}
  O->>O: tx: saga CHARGING_PAYMENT, outbox[ChargePayment]
  O->>P: ChargePayment {amount}
  P->>L: POST /transactions (Idempotency-Key charge-<orderId>)
  L-->>P: 201 {id}
  P->>P: tx: payment CHARGED + inbox + outbox[PaymentCharged]
  P->>O: PaymentCharged
  O->>O: tx: saga CONFIRMED, outbox[OrderConfirmed, CommitStock]
  O->>I: CommitStock (reserved -> sold)
  O->>N: OrderConfirmed
  N->>N: tx: inbox + notification PENDING, then send, SENT
```

## 2. Out of stock (no compensation needed)

```mermaid
sequenceDiagram
  autonumber
  participant O as order
  participant I as inventory
  participant N as notification
  O->>I: ReserveStock
  I->>I: tx: available < quantity -> reservation REJECTED, outbox[StockReservationRejected]
  I->>O: StockReservationRejected {reason: out_of_stock, sku}
  O->>O: tx: saga CANCELLED (stock_out_of_stock), outbox[OrderCancelled]
  O->>N: OrderCancelled
```

## 3. Payment declined → release stock

```mermaid
sequenceDiagram
  autonumber
  participant O as order
  participant I as inventory
  participant P as payment
  participant L as ledger API
  O->>I: ReserveStock
  I->>O: StockReserved
  O->>P: ChargePayment
  P->>L: POST /transactions
  L-->>P: 422 insufficient_funds
  Note over P: business decline: no retry, circuit breaker not affected
  P->>O: PaymentDeclined {insufficient_funds}
  O->>O: saga RELEASING_STOCK (deadline 30 s)
  O->>I: ReleaseStock
  I->>I: tx: restore available, reservation RELEASED
  I->>O: StockReleased {restocked: true}
  O->>O: saga CANCELLED (payment_insufficient_funds), OrderCancelled
```

## 4. Payment timeout → refund (resolving an unknown charge) → release stock

The ledger committed the charge but answered after the client timeout. Payment never
learned the outcome, and the order's `CHARGING_PAYMENT` deadline expired.

```mermaid
sequenceDiagram
  autonumber
  participant O as order
  participant I as inventory
  participant P as payment
  participant L as ledger API
  O->>P: ChargePayment
  P->>L: POST /transactions (charge-<orderId>)
  Note over L: commits, responds too late
  P--xL: client timeout, retry with same key (still slow)
  Note over P: LedgerUnavailable -> message not deleted, SQS redelivers with backoff
  Note over O: deadline (90 s) expires
  O->>O: saga REFUNDING_PAYMENT, outbox[RefundPayment]
  Note over P: FIFO: RefundPayment waits until ChargePayment is deleted or dead-lettered
  P->>L: POST /transactions (same key) - replay tells us the charge exists
  L-->>P: 201 {id} (idempotent replay)
  P->>O: PaymentCharged (ignored: saga is REFUNDING_PAYMENT)
  O->>P: RefundPayment
  P->>L: POST /transactions/{id}/reversals (refund-<orderId>)
  L-->>P: 201 {reversal id}
  P->>O: PaymentRefunded {refunded: true}
  O->>I: ReleaseStock
  I->>O: StockReleased
  O->>O: saga CANCELLED (payment_timeout)
```

If the charge had **not** reached the ledger, the refund's replay would post it and then
immediately reverse it (net zero, both visible in the ledger). If the ledger declines the
replay, the refund answers `refunded: false`.

## 5. Reservation timeout → release (tombstone)

```mermaid
sequenceDiagram
  autonumber
  participant O as order
  participant I as inventory
  O->>I: ReserveStock
  Note over I: inventory down / backlog
  Note over O: deadline (30 s) expires
  O->>O: saga RELEASING_STOCK (stock_timeout), outbox[ReleaseStock]
  alt ReserveStock processed first (FIFO order)
    I->>I: reserve, then release restores stock
  else release arrives with no reservation
    I->>I: write RELEASED tombstone
    Note over I: a later ReserveStock for this order is rejected (already_released)
  end
  I->>O: StockReleased
  O->>O: saga CANCELLED (stock_timeout)
```

## 6. Compensation keeps failing → FAILED → operator retry

```mermaid
sequenceDiagram
  autonumber
  actor Ops as Operator
  participant O as order
  participant P as payment
  O->>P: RefundPayment
  Note over P: ledger refuses reversal -> poison -> DLQ (alarm)
  loop every deadline, 30 s doubling (cap 16x), 8 attempts
    O->>P: RefundPayment (retry)
  end
  O->>O: saga FAILED (resumeState REFUNDING_PAYMENT), error log + alarm
  Ops->>Ops: fix cause (runbook), redrive DLQ if useful
  Ops->>O: POST /internal/sagas/{id}/retry (M2M, orders/admin)
  O->>P: RefundPayment
  P->>O: PaymentRefunded
  O->>O: RELEASING_STOCK -> CANCELLED
```
