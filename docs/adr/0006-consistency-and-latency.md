# 6. Consistency and latency trade-offs: eventual by design, explicit deadlines

- Status: Accepted
- Date: 2026-05-29

## Context

An order now spans three services and two kinds of databases, connected by asynchronous messages. We have to decide what a client sees, when, and how long the system waits before it gives up and compensates.

## Decision

### What is consistent, and when

| Question | Answered by | Consistency |
|---|---|---|
| Was my order accepted? | `POST /orders` → `202` with `orderId` | Immediate: the order row, saga row and first command commit together |
| What is my order's status? | `GET /orders/:id` (Postgres) | Strong for the order service's own state; reflects replies as soon as they are processed |
| My order list / timeline | `GET /orders`, `GET /orders/:id/history` (DocumentDB) | Eventual; `X-Read-Model: eventually-consistent` header |
| Is stock really reserved? | inventory DB | Strong inside inventory; the order learns about it asynchronously |
| Was money taken? | ledger | Strong inside the ledger; payment and order learn asynchronously; a refund may reverse it |

We accept that for a short window an order can be `PENDING` while stock is already reserved, or `CANCELLING` while the charge is already reversed. These are **semantic** inconsistencies (intermediate states the business understands), not data corruption. Each service is always internally consistent.

### Latency budget

Every saga step crosses outbox poll → SNS → SQS long poll → handler transaction. The happy path is 4 hops (ReserveStock, StockReserved, ChargePayment, PaymentCharged) plus the ledger call. With `OUTBOX_POLL_INTERVAL_MS=200`, each hop adds on average about half a poll interval of relay delay plus broker time.

Measured locally (README, "Measured numbers"): place → `CONFIRMED` p50 594 ms, p95 715 ms over 100 sequential orders on Docker Desktop with LocalStack. Real SNS/SQS latency differs from LocalStack; treat these numbers as a relative baseline, not a production SLO.

Levers if this is too slow: lower the poll interval (more idle queries), `LISTEN/NOTIFY` to wake the relay on commit, or CDC on the outbox.

### Deadlines (saga timeouts)

| State | Default | Reasoning |
|---|---|---|
| `RESERVING_STOCK` | 30 s | Inventory handler is one short transaction; 30 s covers several SQS redeliveries (backoff) before giving up |
| `CHARGING_PAYMENT` | 90 s | Must exceed the payment consumer's own retry horizon: ledger client up to ~8 s per delivery, visibility backoff between deliveries. Timing out too early turns a slow ledger into needless refunds |
| compensation steps | 30 s, doubling (cap 16×), 8 attempts | Compensations must eventually succeed; after ~1 h of retries the saga goes `FAILED` and pages a human |

A timeout never assumes the remote step did not happen. `RESERVING_STOCK` timeout → release (idempotent, tombstone if nothing was reserved). `CHARGING_PAYMENT` timeout → refund, which first **resolves** the unknown charge by replaying it with the same Idempotency-Key, then reverses it if it exists. This can briefly post a charge followed by its reversal, which is visible in the ledger but nets to zero. We accepted that in exchange for never leaving money taken for a cancelled order.

## Alternatives considered

- **Synchronous orchestration over HTTP** (order calls inventory then payment in the request). Lower latency in the happy path. But the customer's request then holds three services hostage, and a timeout leaves an unknown state with no durable record of what to compensate.
- **Two-phase commit / XA across services.** It is not available across RDS databases and an external ledger, and it couples availability of all participants.
- **Shorter charge timeout (e.g. 10 s).** Faster cancellation of stuck orders, but more refunds of charges that were merely slow.

## Consequences

- Clients must treat `202` as "accepted, outcome pending" and poll or wait for the notification.
- Support tooling must explain intermediate states (`CANCELLING`) and show the timeline.
- Every deadline is configuration (`SAGA_*_TIMEOUT_MS`). Changing them requires re-checking the payment retry horizon and the SQS visibility timeouts (ADR 0003).
