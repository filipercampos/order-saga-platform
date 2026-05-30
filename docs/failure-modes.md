# Failure modes

What happens when each component fails, what the customer sees, and how the system recovers. "Tested" points to the test that exercises it, where one exists.

| # | Failure | Effect | Detection | Recovery | Tested |
|---|---|---|---|---|---|
| 1 | Order service crashes after commit, before publishing | Commands/events sit in `outbox` | Outbox age (relay logs; `OrderHistoryAgeAlarm` downstream) | Relay on any replica publishes on restart; saga deadlines still apply | outbox atomicity is structural (same tx) |
| 2 | Relay publishes, crashes before marking row | Same message published twice | — | SNS FIFO dedup (5 min, by event id); inbox afterwards | `delivery.int-spec` "delivered twice" |
| 3 | Consumer crashes mid-handler | Transaction rolls back; message reappears after visibility timeout | `MessagesConsumed{Outcome=retry}` | Redelivery; inbox makes the retry safe | `sqs-consumer.spec` |
| 4 | Consumer crashes after commit, before delete | Message redelivered | — | Inbox detects duplicate, handler skipped, message deleted | `delivery.int-spec` |
| 5 | Malformed / unknown message | Would block a FIFO group or loop | `MessagesConsumed{Outcome=poison}`, DLQ alarm | Visibility 0 → `maxReceiveCount` reached in seconds → DLQ; runbook | `delivery.int-spec` "poison" |
| 6 | Inventory down | `ReserveStock` waits in queue | Queue age alarm | Resumes on recovery; after 30 s saga releases (tombstone) and cancels | `saga-machine.spec` (reserve timeout) |
| 7 | Ledger slow / timing out | Charge outcome unknown | Ledger retry logs, `LedgerCircuitTransition` | Payment retries with same Idempotency-Key; saga timeout → refund resolves the charge and reverses it | `saga.int-spec` "payment timeout" |
| 8 | Ledger down (5xx) | Charges fail fast once the circuit opens | `LedgerCircuitTransition{To=open}` | Messages back off in SQS; circuit half-opens after 30 s; saga deadlines refund/release if prolonged | `ledger-client.spec` |
| 9 | Ledger declines (422) | Business outcome, not an outage | `PaymentDeclined{Reason}` | Saga releases stock, order cancelled | `saga.int-spec` "payment declined" |
| 10 | Ledger refuses a reversal | Refund cannot complete | Poison → DLQ alarm; saga `FAILED` after retries | Runbook "refund rejected"; operator retry | `saga-machine.spec` (FAILED + operator retry) |
| 11 | Compensation retries exhausted | Saga `FAILED`, order shows `FAILED` | Error log `saga failed, needs operator` | Runbook "stuck sagas" | `saga-machine.spec` |
| 12 | Release arrives before reserve | Would leak stock | — | FIFO ordering prevents it; tombstone rejects a late reserve anyway | `saga-machine.spec`, inventory tombstone code |
| 13 | Refund arrives before charge | Would charge a cancelled order | — | FIFO ordering; payment tombstone (`CANCELLED`) declines a late charge | payment tombstone code |
| 14 | Duplicate reply at orchestrator | Would double-transition | — | Inbox + state guard (reply ignored when not expected) | `delivery.int-spec` "duplicated reply" |
| 15 | Two replicas scan the same timed-out saga | Double compensation | — | `FOR UPDATE SKIP LOCKED` + row lock + version check | structural |
| 16 | DocumentDB down | List/history endpoints 5xx; readiness fails | Readiness probe, projector errors | Projector messages wait in SQS (10 receives, then DLQ); write path unaffected | — |
| 17 | Projection bug / schema change | Wrong read model | Support reports, sampling | Fix, then `npm run projection:replay` | `delivery.int-spec` "rebuilds the read model" |
| 18 | Events projected out of order | Status could regress | — | `orderVersion` guard; timeline append is order-independent | `delivery.int-spec` "out-of-order" |
| 19 | Same `Idempotency-Key` reused with a different body | Ambiguous intent | `422 idempotency_key_reused` | Client generates a new key | `saga.int-spec` |
| 20 | Postgres failover (Multi-AZ) | ~1-2 min of write errors | Readiness, 5xx alarms | Pool reconnects; in-flight messages retried by SQS; outbox resumes | — |
| 21 | Cognito JWKS unreachable | New tokens cannot be verified (cached keys still work) | 401 rate | `aws-jwt-verify` caches JWKS; recovers automatically | `auth.guard.spec` |

## Known gaps

- Notification sends after commit. A crash between send and the `SENT` update leaves the row `PENDING`; no sweeper resends it yet. The send call carries the notification id, so a provider-side idempotency token could close the gap.
- A charge whose idempotency key has expired in the ledger (beyond the ledger's key retention) and whose result is unknown cannot be resolved by replay: the ledger answers `409 duplicate_reference`, and payment treats it as a rejection. The ledger's daily reconciliation is the backstop (runbook "unknown charge").
