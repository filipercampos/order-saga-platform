# 3. SNS fan-out to per-consumer SQS queues (FIFO only for saga commands)

- Status: Accepted
- Date: 2026-04-07

## Context

The saga needs commands (order → inventory/payment), replies (inventory/payment → order) and domain events (order → notification, read model). Requirements:

- every consumer gets its own copy and its own retry/DLQ policy;
- per-order ordering of commands (see below);
- at-least-once delivery with dead-lettering of poison messages;
- runs locally on LocalStack; no cluster to operate.

## Options

| | SNS + SQS | EventBridge + SQS | Amazon MSK (Kafka) |
|---|---|---|---|
| Fan-out | Topic → N subscribed queues, filter policies on message attributes | Bus → rules → targets, content-based filtering on the body | Consumer groups on a topic |
| Ordering | FIFO topics + FIFO queues, per `MessageGroupId` | None (targets may receive out of order) | Per partition |
| Replay | Not native (archive via Firehose subscription → S3) | Archive + replay built in | Native (retention), the strongest option |
| DLQ / redrive | Per queue, `maxReceiveCount`, redrive to source in console/API | Per target DLQ + still need SQS for consumers | DIY (retry topics) |
| Latency | Tens of ms | Typically higher than SNS (sub-second) | Low ms |
| Ops | Serverless | Serverless | Brokers, partitions, upgrades, ~US$ hundreds/month minimum |
| Consumer model on EKS | Long-poll SQS, back-pressure for free | Same (EventBridge → SQS) | Kafka client, rebalances |

## Decision

**SNS topics fan out to one SQS queue per consumer.** Each queue has its own DLQ, redrive policy and visibility timeout. Raw message delivery is enabled so the SQS body is our envelope, and SNS message attributes (`type`, `target`, `traceparent`, `correlationId`) are preserved for filtering and tracing.

Topology (single source of truth: `libs/messaging/src/topology.ts`, mirrored in `infra/messaging.yaml`):

| Topic | Kind | Subscribed queue | Filter | Visibility | maxReceiveCount |
|---|---|---|---|---|---|
| `saga-commands.fifo` | FIFO | `inventory-commands.fifo` | `target = inventory` | 30 s | 5 |
| `saga-commands.fifo` | FIFO | `payment-commands.fifo` | `target = payment` | 60 s | 5 |
| `inventory-events` | standard | `order-saga-replies` | — | 30 s | 10 |
| `payment-events` | standard | `order-saga-replies` | — | 30 s | 10 |
| `order-events`, `inventory-events`, `payment-events` | standard | `order-history` | — | 30 s | 10 |
| `order-events` | standard | `notification-order-events` | `type ∈ {OrderConfirmed, OrderCancelled}` | 60 s | 5 |

### Why FIFO for commands (and only for commands)

Commands for the same order must not overtake each other. The dangerous case is a **compensation that overtakes the action it compensates**: the orchestrator times out waiting for `StockReserved`, sends `ReleaseStock`, while `ReserveStock` is still sitting in the queue (consumer slow, message in a visibility-timeout backoff). On a standard queue `ReleaseStock` can be processed first, then `ReserveStock` reserves stock that nobody will ever release. The same applies to `ChargePayment` / `RefundPayment`.

With `MessageGroupId = orderId`, SQS FIFO delivers one group's messages in order and **does not deliver the next one until the previous is deleted or dead-lettered**. That is exactly the guarantee we need, scoped to one order, so different orders still proceed in parallel. High-throughput FIFO mode (`DeduplicationScope=messageGroup`, `FifoThroughputLimit=perMessageGroupId`) removes the per-queue TPS ceiling.

Participants also keep **tombstones** (a release/refund for an unknown order is remembered, and a later reserve/charge for it is rejected), so correctness does not rest on ordering alone.

Replies and domain events use **standard** topics: the orchestrator guards every reply with the current state (a late or duplicated reply is ignored), and the read model orders by `orderVersion`. Paying FIFO's throughput and blocking-group cost there would buy nothing.

### Visibility timeouts

Rule of thumb: visibility ≥ 6 × p99 handler time, so a slow but healthy handler is not redelivered to a second worker mid-flight.

- Inventory: a handler is one Postgres transaction (≪ 1 s) → 30 s.
- Payment: the ledger client may spend up to `3 attempts × 2 s timeout + backoff ≈ 8 s` → 60 s. Consumers also extend visibility (heartbeat at half the timeout) for outliers.
- On failure the consumer sets visibility explicitly: exponential backoff with jitter for transient errors, `0` for poison messages so they reach `maxReceiveCount` quickly and land in the DLQ instead of blocking a FIFO group for minutes.

## Alternatives considered

- **EventBridge.** Archive/replay is attractive, but no ordering, so commands would still need SQS FIFO; we would be running two systems. Kept as the integration point with *other* domains (e.g. the ledger publishes to EventBridge; a rule could forward to `payment-events`).
- **MSK.** Best replay story and ordering, but a cluster to run for four services and a few hundred messages per second. Our replay need (rebuild one read model) is covered by archiving events in the projection store (ADR 0005).
- **Direct SQS sends (no SNS).** Simpler for commands, but adding a consumer (audit, analytics) would require changing the producer.

## Consequences

- One queue + DLQ + alarm per consumer; topology lives in code and CloudFormation.
- A poison command blocks only its own order's group until it is dead-lettered.
- Messages are at-least-once; every consumer must deduplicate (ADR 0004).
- No native replay: the read model keeps its own event archive (ADR 0005); an SNS → Firehose → S3 archive is the production upgrade path.
