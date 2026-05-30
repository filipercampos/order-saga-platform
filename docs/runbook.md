# Runbook

Commands assume `kubectl` context on the cluster, namespace `order-saga`, and an M2M token with `orders/admin` in `$OPS_TOKEN` (client credentials of the operations app client).

## stuck-sagas

**Signals:** orders stuck in `PENDING`/`CANCELLING` far beyond their deadlines, `saga failed, needs operator` in order-service logs, `SagaTransition{To=FAILED}` metric.

1. List sagas that are failed or overdue (reader endpoint):

   ```sql
   SELECT order_id, state, attempts, deadline_at, resume_state, updated_at
     FROM sagas
    WHERE state = 'FAILED'
       OR (deadline_at IS NOT NULL AND deadline_at < now() - interval '5 minutes')
    ORDER BY updated_at;
   ```

   Overdue but not `FAILED` means the timeout scanner is not running. Check that order-service pods are up and that `saga timeout scan failed` is absent from the logs.

2. Inspect one saga with its full transition history:

   ```bash
   curl -s -H "Authorization: Bearer $OPS_TOKEN" http://order-service/internal/sagas/<orderId> | jq
   ```

   `transitions[].trigger` shows which reply or timeout moved it, and `event_id` links to the message.

3. Find the cause in the participant that is not answering:
   - `resume_state = RELEASING_STOCK` → inventory: look for the order id in inventory logs, check `inventory-commands-dlq.fifo`.
   - `resume_state = REFUNDING_PAYMENT` → payment / ledger: see [refund-rejected](#refund-rejected).

4. Fix the cause, then resume the compensation (idempotent: safe to repeat):

   ```bash
   curl -s -X POST -H "Authorization: Bearer $OPS_TOKEN" http://order-service/internal/sagas/<orderId>/retry
   ```

   The saga re-enters its compensation step with a fresh attempt budget and re-sends the command.

Never edit `sagas.state` by hand. Doing so skips the outbox, and participants will never hear about the change.

## dlq-not-empty

**Alarm:** `saga-<env>-<queue>-dlq-not-empty`.

1. Peek without consuming (visibility returns them after 30 s):

   ```bash
   aws sqs receive-message --queue-url <dlq-url> --max-number-of-messages 10 \
     --message-attribute-names All --attribute-names All --visibility-timeout 30
   ```

2. Classify:
   - **Poison** (invalid JSON or schema, unknown type): a bug in a producer. Fix and deploy the producer. The message itself can be deleted after recording it in the incident.
   - **Transient that exhausted retries** (DB or ledger outage): safe to redrive once the dependency is healthy.
3. Redrive. Consumers are idempotent (inbox), so redriving an already-applied message is harmless:

   ```bash
   # Console "Start DLQ redrive" works for standard queues. For FIFO queues, or to move a
   # bounded number of messages while watching, use the tool (preserves message groups):
   npm run dlq:redrive -- payment-commands.fifo 10 --dry-run
   npm run dlq:redrive -- payment-commands.fifo 10
   ```

   The tool only moves as many messages as the DLQ held when it started. A message that fails again during the redrive is not picked up twice.
4. **FIFO caveat:** while a command sits in a FIFO queue's retry loop, later commands for **the same order** wait behind it. Once dead-lettered, they proceed. If a `RefundPayment` already overtook a dead-lettered `ChargePayment`, the tombstone makes the redriven charge decline harmlessly.

## refund-rejected

**Signal:** `ledger refused reversal` (poison) in payment logs; saga heading for `FAILED` in `REFUNDING_PAYMENT`.

1. `GET /internal/payments/<orderId>` on payment-service: note `ledger_transaction_id`.
2. In the ledger, check the transaction and existing reversals (`GET /transactions/<id>`). A reversal may already exist under a different key. If so, record it and mark the refund done by retrying the saga after fixing the payment row through a reviewed SQL change (`status='REFUNDED'`, `reversal_transaction_id`).
3. Otherwise escalate to the ledger team. Retry the saga when the ledger accepts the reversal.

## unknown-charge

**Signal:** payment rows stuck in `CHARGING` for more than 10 minutes:

```sql
SELECT order_id, amount, currency, updated_at FROM payments
 WHERE status = 'CHARGING' AND updated_at < now() - interval '10 minutes';
```

Normally the saga's charge timeout resolves these via refund. If the refund's replay gets `409 duplicate_reference` (the ledger idempotency key expired), match the order against the ledger by reference `order-<orderId>`. Then reverse it manually through the ledger's admin API, and close the saga with an operator retry.

## projection-rebuild

When the read model is wrong (bug fixed, schema changed) or DocumentDB was restored from an old snapshot:

1. Scale the projector down so the swap does not race with live writes: `kubectl scale deploy/order-history-projector --replicas=0`. Events keep accumulating in `order-history` (SQS).
2. Run the replay as a one-off Job with the order-service image:

   ```bash
   kubectl run projection-replay --rm -it --restart=Never \
     --image=<image> --overrides='{"spec":{"serviceAccountName":"order-service"}}' \
     --env MONGO_URL=... -- node dist/apps/order/src/history/replay-cli.js
   ```

   It prints `{events, orders, durationMs}`. Locally, 700 events / 100 orders took about 1.4 s (README).
3. Scale the projector back up. The queued events are applied idempotently on top.

## ledger-circuit-open

**Signal:** `LedgerCircuitTransition{To=open}`.

Payment stops calling the ledger for 30 s at a time and messages back off in SQS. No money moves and nothing is lost. Check the ledger service's health and alarms. If the outage outlasts `SAGA_CHARGE_TIMEOUT_MS` (90 s), affected orders are refunded and cancelled automatically. That is expected, not an incident in this system.
