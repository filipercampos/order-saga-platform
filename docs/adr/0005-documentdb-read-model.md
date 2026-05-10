# 5. Order-history read model in DocumentDB, rebuilt from an event archive

- Status: Accepted
- Date: 2026-05-10

## Context

Customers want "my orders" with a timeline: placed, stock reserved at what price, charged, refunded, cancelled and why. That data is spread over three databases owned by three services. Joining across services at query time would couple the order API's availability to inventory and payment. Running this read path against the saga tables would mix a write-optimised schema with read-heavy, document-shaped queries.

## Decision

**CQRS read model**: the order service runs a projector that consumes `order-events`, `inventory-events` and `payment-events` (queue `order-history`) and maintains one document per order in **Amazon DocumentDB 5.0** (MongoDB 5.0 locally).

- **Archive first, then project.** Every event is stored once in `event_archive` (`_id = eventId`) and then applied to `order_history`. Both writes are idempotent, so redelivery converges to the same document.
- **Out-of-order tolerant.** Events from three topics arrive in any order. The timeline is append-only and guarded by `timeline.eventId $ne <id>`. Status fields only move forward using the `orderVersion` the orchestrator stamps on every `OrderStatusChanged` (`version < incoming`).
- **Replay.** `npm run projection:replay` rebuilds `order_history_rebuild` from the archive, ordered by `occurredAt`, then swaps it in with `renameCollection(dropTarget: true)`. That covers schema changes, projection bugs and a lost cluster (as long as the archive survives; see consequences).
- **Read-your-writes stays on Postgres.** `GET /orders/:id` reads the write model and is strongly consistent. `GET /orders` and `GET /orders/:id/history` read the projection and return `X-Read-Model: eventually-consistent`.

## DocumentDB compatibility: what we use and what we avoid

DocumentDB implements the MongoDB API on a different storage engine and does not support everything MongoDB 5.0 does. Check the AWS "Functional differences" and "Supported MongoDB APIs" pages before using any new operator. This projection **uses only**:

- single-document `insertOne` / `updateOne` with `$set`, `$push`, `upsert`;
- equality, `$ne`, `$lt`, `$exists`, `$or` filters, `sort`, `limit`, projections;
- single-field and compound indexes; `renameCollection`; `ping`.

**Deliberately avoided** (not supported, or supported with differences that would bite):

| Feature | Status in DocumentDB 5.0 (per AWS docs at the time of writing) | What we do instead |
|---|---|---|
| Retryable writes (`retryWrites=true`, the driver default) | Not supported | Client sets `retryWrites: false`; idempotent writes make app-level retries safe |
| `$where`, `mapReduce`, server-side JavaScript | Not supported | Plain filters only |
| Collation / case-insensitive indexes | Not supported | Not needed (ids and enums) |
| Wildcard indexes (`$**`) | Not supported | Explicit indexes |
| `$merge` / `$out` to build collections | Not available or limited | Rebuild with application code + `renameCollection` |
| Change streams | Must be enabled per collection, limited retention | Not used; SQS feeds the projector |
| Multi-document transactions | Supported with limits (time and size) | Not used; each write is single-document and idempotent |
| `$text` search | Limited (5.0+) | Not used; search belongs in OpenSearch if ever needed |
| `$lookup` with complex pipelines, `$graphLookup` | Limited / differs | Denormalised documents; no joins |

The local `mongo:5.0` container does not enforce these restrictions. The rule is enforced by keeping all Mongo access in `apps/order/src/history/` and reviewing it against this list.

## Alternatives considered

- **Postgres read replica + views.** No new database. But the timeline needs inventory and payment data the order database does not have; it would still need a projector, writing to tables shaped like documents.
- **DynamoDB.** Cheaper at rest and serverless. It fits "get by id" and "list by customer" (GSI), but the timeline array with idempotent appends needs conditional expressions per event, and ad-hoc support queries are awkward. DocumentDB was chosen because the team already operates the MongoDB API elsewhere. This is the weakest part of the decision, and DynamoDB is a reasonable alternative.
- **Query the services at read time (API composition).** Every list call would fan out to three services, and an outage of any one breaks "my orders".

## Consequences

- The read model lags the write model by the relay poll interval plus SQS and projector latency (measured locally, see README). The UI must tolerate a just-placed order missing from the list for a moment.
- `event_archive` grows with every event. It is the replay source, so it must be backed up (DocumentDB snapshots). The production upgrade path is an SNS → Firehose → S3 archive, which does not depend on the projector having seen the event.
- DocumentDB costs money even when idle (one instance minimum), which is the main cost of this design in non-production environments.
