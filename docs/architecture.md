# Architecture

## System context (C4 level 1)

```mermaid
flowchart LR
  customer([Customer<br/>web / mobile app])
  ops([Operator])
  cognito[Amazon Cognito<br/>user pool]
  platform[[Order saga platform]]
  ledger[[ledger-service<br/>double-entry ledger]]
  ses[Amazon SES]

  customer -- "authorization code + PKCE" --> cognito
  customer -- "HTTPS + access token" --> platform
  ops -- "client credentials token" --> platform
  platform -- "POST /transactions<br/>Idempotency-Key, M2M token" --> ledger
  platform -- "emails" --> ses
```

## Containers (C4 level 2)

```mermaid
flowchart TB
  subgraph eks[EKS cluster - namespace order-saga]
    subgraph ec2[EC2 node group - Graviton]
      order[order-service<br/>API + saga orchestrator<br/>+ outbox relay + timeout scanner]
      projector[order-history-projector<br/>same image, projector only]
      inventory[inventory-service]
    end
    subgraph fargate[Fargate profile]
      payment[payment-service<br/>ledger client: timeout, retry, breaker]
      notification[notification-service]
    end
  end

  subgraph rds[RDS PostgreSQL - one database + role per service]
    ordersdb[(orders<br/>orders, sagas, saga_transitions,<br/>outbox, inbox)]
    invdb[(inventory<br/>products, reservations,<br/>outbox, inbox)]
    paydb[(payments<br/>wallets, payments,<br/>outbox, inbox)]
    notifdb[(notifications<br/>notifications, inbox)]
  end
  docdb[(DocumentDB 5.0<br/>order_history, event_archive)]

  subgraph bus[SNS / SQS]
    cmds{{saga-commands.fifo}}
    oev{{order-events}}
    iev{{inventory-events}}
    pev{{payment-events}}
    qinv[/inventory-commands.fifo + DLQ/]
    qpay[/payment-commands.fifo + DLQ/]
    qrep[/order-saga-replies + DLQ/]
    qhist[/order-history + DLQ/]
    qnot[/notification-order-events + DLQ/]
  end

  order --> ordersdb
  inventory --> invdb
  payment --> paydb
  notification --> notifdb
  projector --> docdb
  order -. "GET /orders, /history" .-> docdb

  order -- outbox --> cmds
  order -- outbox --> oev
  inventory -- outbox --> iev
  payment -- outbox --> pev

  cmds -- "target=inventory" --> qinv --> inventory
  cmds -- "target=payment" --> qpay --> payment
  iev --> qrep
  pev --> qrep
  qrep --> order
  oev --> qhist
  iev --> qhist
  pev --> qhist
  qhist --> projector
  oev -- "type in Confirmed/Cancelled" --> qnot --> notification
  payment -- HTTPS --> ledger[[ledger-service]]
```

## Code layout

```
apps/
  order/          API, saga (pure state machine + persistence), read model (Mongo), admin API
  inventory/      stock reservations (ordered row locks, tombstones)
  payment/        ledger client (resilience), charge/refund handlers, wallets
  notification/   notification intents + sender
  ledger-stub/    in-memory ledger-service contract for compose and tests
libs/
  contracts/      envelope + zod message catalogue (the only shared "API")
  messaging/      topology, SNS publisher, SQS consumer, provisioning, DLQ redrive
  outbox/         outbox (enqueue, relay) and inbox (processOnce)
  observability/  pino logger, EMF metrics, health probes
  tracing/        OpenTelemetry bootstrap (imported first)
  platform/       env parsing, Kysely + migrations, auth guard/verifiers, M2M tokens, workers
  resilience/     retry with full jitter, circuit breaker
tools/            provision, migrate, dlq-redrive, e2e-latency
infra/            CloudFormation: messaging, data, identity, workloads
deploy/helm/      one chart, values per service
```

Rules enforced by lint: libs never import apps; apps never import each other. The only thing services share is `libs/contracts`.

## Observability

- **Logs:** pino JSON with `service`, HTTP `reqId` (propagated `x-request-id`) and, inside message handlers, `correlationId` (= order id), `messageType` and `eventId` from AsyncLocalStorage. `grep <orderId>` across all services reconstructs a saga.
- **Traces:** OpenTelemetry auto-instrumentation (HTTP, Express, pg, AWS SDK, MongoDB). Trace context is stored with each outbox row and sent as SNS message attributes; consumers continue the trace, so one trace spans API → orchestrator → participants.
- **Metrics (CloudWatch EMF):** `SagaTransition{To}`, `MessagesConsumed{Outcome=processed|retry|poison}`, `PaymentCharged`, `PaymentDeclined{Reason}`, `PaymentRefunded`, `LedgerCircuitTransition{To}`; SQS `ApproximateAgeOfOldestMessage` and DLQ depth alarms from CloudFormation.
- **Probes:** `/health/live` (process only), `/health/ready` (Postgres, plus DocumentDB for order; flips to 503 on shutdown before workers stop).
