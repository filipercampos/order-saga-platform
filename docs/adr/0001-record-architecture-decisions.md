# 1. Record architecture decisions

- Status: Accepted
- Date: 2026-04-04

## Context

This platform is four services that cooperate through asynchronous messages. Most of the interesting behaviour (what happens on a timeout, on a duplicate, on a poison message) is not visible in any single file. Those decisions must be explicit and reviewable.

## Decision

Use Architecture Decision Records (Michael Nygard format) in `docs/adr/`, numbered sequentially. An accepted ADR is never rewritten; it is superseded by a new one.

The repository is a single monorepo with one `package.json`:

- `apps/<service>` — one deployable per bounded context (order, inventory, payment, notification) plus a ledger stub used locally and in tests.
- `libs/<lib>` — shared technical code (contracts, messaging, outbox/inbox, observability, platform, resilience). Libraries never import from `apps/`; services never import from each other (enforced by ESLint `no-restricted-imports`).

## Alternatives considered

- **npm workspaces with one package per lib.** Gives independent versioning, but every lib then needs its own build step and published types. With one team and one release train, a single lockfile and TypeScript path aliases are simpler; the lint rule keeps the boundaries.
- **Polyrepo.** Contract changes would need coordinated releases across five repositories for no benefit at this size.

## Consequences

- One CI pipeline, one dependency upgrade per library across all services.
- Services share code only through `libs/`, never through tables or imports of each other.
- If services ever need independent release cadences, libs can be extracted into packages without changing import paths (`@saga/*`).
