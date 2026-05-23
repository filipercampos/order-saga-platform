# 7. EKS compute: EC2 node group for order and inventory, Fargate for payment and notification

- Status: Accepted
- Date: 2026-05-23

## Context

The platform runs on a shared EKS cluster (provided by the platform stack) that has a managed EC2 node group (Graviton, on-demand) and supports Fargate profiles. Each service has a different load shape and risk profile:

| Service | Load shape | Latency sensitivity | Special needs |
|---|---|---|---|
| order (API + orchestrator) | Steady, follows traffic, public API | High (customer waits on POST) | Talks to Postgres and DocumentDB |
| order-history-projector | Steady, bursty during replays | Low | DocumentDB |
| inventory | Every order hits it; row locks | High (on the saga critical path) | None |
| payment | Every order; bounded by the ledger | Medium | Holds ledger M2M credentials |
| notification | Spiky (follows confirmations), low baseline | None | None |

## Decision

**EC2 managed node group: order, order-history-projector, inventory.**

- Steady utilisation makes reserved/savings-plan EC2 capacity cheaper than per-pod Fargate pricing.
- HPA scale-out lands on warm nodes in seconds. A new Fargate pod needs its own micro-VM, which typically takes longer to start.
- The ADOT collector and Fluent Bit run once per node as DaemonSets.
- Graviton (`kubernetes.io/arch: arm64`); the image is multi-arch Node.js with no native modules.

**Fargate profile (`compute: fargate` label): payment, notification.**

- **payment**: Fargate gives each pod its own isolation boundary (a micro-VM, no kernel shared with other tenants' pods). This is the only service holding credentials that can move money (the ledger client secret). Isolation narrows the blast radius of a container escape on a shared node. Its throughput is bounded by the ledger, not by how fast pods start.
- **notification**: low baseline, bursty, no latency SLO. Paying per pod-second beats keeping node headroom for it.
- Fargate pods cannot use DaemonSets, so the chart adds an ADOT collector **sidecar** when `observability.collectorSidecar.enabled=true`. Logs go through Fargate's built-in Fluent Bit log router.

Placement is a single chart value (`compute: ec2|fargate`). The Fargate profile in `infra/workloads.yaml` selects `namespace=order-saga, compute=fargate`, so moving a service is a values change, not a chart change.

## Alternatives considered

- **Everything on Fargate.** Simplest node management. But more expensive for the steady services, slower scale-out for the hot path, and a sidecar per pod for telemetry.
- **Everything on EC2 with a dedicated, tainted node group for payment.** Gives similar isolation from other workloads, but payment pods still share a kernel with each other and need their own capacity planning. That is reasonable if Fargate limits (no GPUs, no privileged containers, max 16 vCPU / 120 GiB per pod) ever bite; they do not today.
- **Karpenter with spot for the projector.** A good fit (the projector is interruptible and replayable). It is deferred until the platform stack adopts Karpenter.

## Consequences

- Two telemetry paths (DaemonSet vs sidecar) to keep configured consistently.
- Fargate pods need explicit, realistic resource requests (billing is per requested vCPU/GiB) and cannot use `hostNetwork` or node-level debugging tools.
- IRSA works the same on both. Every service has its own IAM role scoped to its own topics and queues (`infra/workloads.yaml`).
