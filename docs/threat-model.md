# Threat model (STRIDE)

Scope: public order API, internal service APIs, SNS/SQS messaging, payment → ledger integration, data stores (RDS, DocumentDB), EKS workloads.

Trust boundaries: internet → ALB/ingress → order-service; pods → AWS APIs (IRSA); payment → ledger API (M2M); services ↔ their own databases.

| Threat | Example | Mitigation |
|---|---|---|
| **Spoofing** | Forged JWT to place orders as another customer | Cognito access tokens verified against the pool JWKS (`aws-jwt-verify`: signature, `exp`, issuer, `token_use=access`, allowed client ids); `customerId` is always the token `sub`, never from the body |
| **Spoofing** | A pod impersonates another service on the bus | IRSA: each ServiceAccount maps to one IAM role that can publish only its own topics and consume only its own queues (`infra/workloads.yaml`); SQS queue policies only accept SNS from our topics |
| **Spoofing** | Payment's ledger credentials used by another workload | Client secret in Secrets Manager, readable only by the payment role; payment runs on Fargate (per-pod isolation, ADR 0007) |
| **Tampering** | Customer pays from someone else's wallet | Wallet mapping lives in payment, written via M2M only; the order request carries SKUs and quantities only |
| **Tampering** | Client manipulates price | Prices come from inventory at reservation time (`StockReserved.lines.unitPrice`); the order request has no price fields |
| **Tampering** | Injected/forged message on a queue | Only SNS (from our topic ARNs) can send to the queues; schema validation (zod) on every message; invalid messages go to the DLQ, never half-processed |
| **Tampering** | Replay of an old command to charge again | Inbox (event id) + business keys (one payment per order) + ledger Idempotency-Key per order |
| **Repudiation** | "I never placed that order" / "the system cancelled it on its own" | Order row stores the `Idempotency-Key` and request hash; `saga_transitions` records every state change with the triggering event id; logs carry request id and order id across services; ledger keeps the immutable money trail |
| **Information disclosure** | Customer reads another customer's order | Ownership filter on every read (`customer_id = sub`); non-owned orders return 404, not 403 (no enumeration oracle) |
| **Information disclosure** | PII leaking through events/logs | Events carry ids, never email/address (notification resolves contacts from Cognito); `authorization`/`cookie` redacted in logs; timeline detail strips customer fields |
| **Information disclosure** | Data at rest / in transit | RDS and DocumentDB encrypted at rest, TLS enforced (`rds.force_ssl`, DocumentDB `tls=enabled`); SNS (KMS) and SQS (SSE) encrypted |
| **Denial of service** | Flood of orders exhausting stock or DB | ALB + WAF rate limits (platform stack); HPA; pool `connectionTimeoutMillis` and `statement_timeout`; a bounded saga per order |
| **Denial of service** | Ledger outage cascading into payment | Per-attempt timeouts, jittered retries, circuit breaker; ledger is not a readiness dependency, so payment pods stay in service while commands wait in SQS |
| **Denial of service** | Poison message blocking a FIFO group forever | Visibility 0 for poison → DLQ after `maxReceiveCount` (seconds); only that order's group is affected |
| **Elevation of privilege** | Customer token calls internal endpoints | Internal routes require M2M scopes (`orders/admin`, `inventory/admin`, `payment/admin`) that the web client cannot request; routes without a scope policy are denied by default |
| **Elevation of privilege** | Container escape on a shared node | Non-root, read-only root FS, dropped capabilities, seccomp `RuntimeDefault`; payment on Fargate |
| **Elevation of privilege** | One service reading another's tables | One database and one role per service, `REVOKE CONNECT ... FROM PUBLIC`; credentials per service in Secrets Manager |

## Accepted risks / out of scope

- `AUTH_MODE=disabled` exists for local development and tests. Config validation refuses it when `NODE_ENV=production`.
- The orchestrator can command any participant. A compromised order-service could cancel or refund orders. It cannot move money to arbitrary accounts, because payment only charges the customer's mapped wallet to the configured merchant account.
- A malicious operator with `orders/admin` can retry sagas but cannot change their state directly. Database access is break-glass and audited (CloudTrail, RDS logs).
