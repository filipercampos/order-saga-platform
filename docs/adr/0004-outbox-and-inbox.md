# 4. Transactional outbox in every producer, inbox in every consumer

- Status: Accepted
- Date: 2026-04-15 (implemented then; written up 2026-05-29)

## Context

SNS/SQS deliver **at least once**. Producers can crash between writing their database and publishing. Consumers can crash between doing their work and deleting the message. Visibility timeouts can expire while a slow handler is still running. Without care, any of these produces a lost command (a saga that never progresses) or a duplicated effect (stock reserved twice, a customer charged twice).

We want **exactly-once effects** on top of at-least-once delivery.

## Decision

### Outbox (producers: order, inventory, payment)

- Every outgoing message is a row in the service's own `outbox` table, inserted **in the same transaction** as the state change that caused it (`enqueue(trx, messages)` in `libs/outbox`).
- A relay in every replica claims rows with `FOR UPDATE SKIP LOCKED`, publishes with SNS `PublishBatch` and marks them published. Failed entries get `attempts + 1` and an exponential `next_attempt_at`. After `OUTBOX_MAX_ATTEMPTS` the row is parked and alarmed.
- **Per-group ordering survives retries and replicas.** A row is only eligible when no earlier unpublished row exists in the same `group_id` (the order id for FIFO commands). If `ReserveStock` failed to publish, `ReleaseStock` for the same order waits behind it. A second relay replica cannot overtake it either, because the earlier row is still unpublished.
- FIFO messages use the outbox `event_id` as `MessageDeduplicationId`, so a republish within SNS's 5-minute window is dropped by SNS itself. Beyond that window the inbox handles it.
- The caller's W3C trace context is stored with the row and sent as message attributes, so traces span the asynchronous hop.

### Inbox (consumers: order, inventory, payment, notification)

- `processOnce(db, {consumer, eventId}, handler)` inserts `(consumer, event_id)` into `inbox` **first**, in the same transaction as the handler's writes and its outgoing outbox rows. A duplicate hits the primary key and the handler is skipped. A concurrent duplicate blocks on the row lock until the first transaction commits (then it is a duplicate) or rolls back (then it proceeds).
- The read model uses the same idea in MongoDB: `event_archive._id = eventId`, plus idempotent `$push` guarded by `timeline.eventId $ne`.
- **External calls cannot join the transaction** (payment → ledger). Payment runs three steps: (1) record intent, (2) call the ledger with a deterministic `Idempotency-Key` (`charge-<orderId>`, `refund-<orderId>`), (3) record the outcome together with the inbox row and the reply. A crash between (2) and (3) repeats (2) with the same key, and the ledger replays the original result. A read-only `isProcessed` pre-check skips the ledger call entirely for known duplicates.
- **Business-key idempotency as a second line.** One reservation per order (primary key), one payment per order, one notification per `(order, template)`. A command re-sent with a *new* event id (an orchestrator retry) is still answered from the existing row instead of acting twice.
- **Tombstones.** A release or refund for an order with no reservation or payment writes a terminal row, so a late reserve or charge for that order is rejected instead of executed.

### Retention

- Inbox rows: at least 14 days. That covers the SQS retention (4 days) plus the DLQ retention (14 days), within which a message can be redriven.
- Published outbox rows: 7 days, for debugging and manual replay.

## Alternatives considered

- **SNS/SQS FIFO deduplication only.** It covers 5 minutes and only for the FIFO queues. It does nothing for redrive from a DLQ hours later, or for standard queues.
- **CDC (Debezium / DMS) on the outbox.** Lower latency than polling and no relay code, but a connector cluster to run. Polling at 200 ms is well within our latency budget (ADR 0006). CDC can read the same table later without changing producers.
- **Idempotent handlers without an inbox** (pure business-key checks). They work for reservations and payments, but every handler has to reinvent it, and "was this exact message already processed?" stops being answerable for debugging.

## Consequences

- Each service carries `outbox` and `inbox` tables plus a relay loop. Throughput is bounded by the relay batch size × poll rate per replica, with SKIP LOCKED scaling it horizontally.
- Messages are published after commit, typically within one poll interval. The saga's end-to-end latency is several relay hops (measured in the README).
- Consumers must never call `DeleteMessage` before their transaction commits (they don't: ack happens after the handler resolves).
