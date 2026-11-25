# ADR 007: Database Connection Policy

> **Status:** Accepted
> **Date:** 2026-09-27
> **Decision makers:** Engineering
> **Supersedes:** None

## Context

left connection configuration, pooling, and TLS as PARTIAL: `DATABASE_URL`
was centralized and validated, but pool size, acquisition/establishment
timeouts, and production TLS had no contract. Operators could silently
misconfigure the database layer (unbounded waits, plaintext production traffic,
meaningless zero values) with no startup feedback.

Empirical verification against the installed Prisma 6.12.0 established the
mechanism ground truth this decision rests on:

- `connection_limit` bounds pooled connections per instance (a limit of 1 was
 observed to serialize concurrent queries); `pool_timeout` bounds acquisition
 waits in seconds (a contended pool fails deterministically with `P2024`
 after the configured timeout); `connect_timeout` bounds establishment in
 seconds (an unreachable host fails after the configured timeout).
- Non-integer, zero, negative, and duplicated pool/timeout values fail only on
 first query, not at startup — too late for a clear operator signal.
- `sslmode=require` initiates TLS (verified by handshake failure against a
 plaintext server); `sslmode=disable` skips it. All other modes
 (`verify-ca`, `verify-full`, `prefer`, `allow`, unknown values) and unknown
 parameters are silently ignored — there is no client-side idle timeout knob.
- Connection-establishment failures surface as
 `PrismaClientInitializationError` without a machine-readable code; only
 host/port appear in the message, never credentials.

## Decision

Connection behavior is configured through `DATABASE_URL` query parameters —
the native Prisma/PostgreSQL mechanism. No parallel environment variables and
no connection-manager abstraction are introduced.

1. `connection_limit`, `pool_timeout`, and `connect_timeout`, when present,
 must each be a positive integer (≥ 1) appearing at most once. Rejected
 otherwise, at startup, by `env.schema.ts`.
2. `sslmode`, when present, must be exactly `require` or `disable`. Anything
 else is rejected at startup because accepting it would promise behavior
 Prisma silently does not provide.
3. Production (`NODE_ENV=production`) requires `sslmode=require`, enforced by
 startup validation. Development and test accept absent or `disable`.
4. Omitted parameters fall back to Prisma defaults (documented in
 `docs/deployment.md`); no upper bound is imposed — capacity budgeting is
 the operator's documented responsibility (`instances × connection_limit`
 must leave headroom under PostgreSQL `max_connections`).
5. Errors and logs never carry connection credentials; targets are identified
 by host/port/database name only.

## Consequences

### Positive

- Invalid or insecure connection configuration fails at startup with a
 readable, credential-safe message instead of a late runtime surprise.
- No new dependencies, abstractions, or infrastructure (no PgBouncer, no pool
 library — assessed as unnecessary for this architecture, see below).
- The contract is fully covered by unit tests (bounds, SSL matrix, redaction)
 and integration tests (pool honoring, P2024 exhaustion, bounded
 establishment, TLS enforcement).

### Negative

- Operators who relied on `verify-ca`/`verify-full` being meaningful (they
 never were, under this client) must switch to `sslmode=require`.
- Certificate verification beyond transport encryption remains an operator
 TLS-trust decision outside this repository; no CA bundle is shipped.

### Risks

- Prisma-documented defaults (pool sizing formula, 10s/5s timeouts) are taken
 from Prisma's documentation, not measured here; if Prisma changes them, the
 deployment guide must be revisited.
- A future Prisma major version may honor currently-ignored parameters; the
 allowlist and this ADR must then be re-verified, not assumed.

## Alternatives Considered

- **Separate `DB_POOL_SIZE`/`DB_*_TIMEOUT` variables** — rejected: duplicates
 the native URL mechanism and can drift from it; §20 prefers URL parameters.
- **Connection-manager/pool-manager abstraction** — rejected: one shared
 `PrismaClient` with validated URL parameters needs no wrapper.
- **PgBouncer sidecar** — rejected for now: single modest pool, no
 session-state usage in the codebase (verified by search), interactive
 transactions only in two service-owned boundaries. Compatible path
 documented (`pgbouncer=true` transaction mode, direct migrations) if scale
 ever demands it.
- **Requiring `verify-full` in production** — rejected: unenforceable through
 this client (silently ignored); `require` is the strongest honestly
 enforceable mode.

## Related

- `src/config/env.schema.ts` (validation), `src/config/index.test.ts` (bounds/SSL/redaction tests)
- `prisma/connection.integration.test.ts` (mechanism proofs)
- `docs/architecture.md` §10, `docs/deployment.md` (Connection management)
- `docs/engineering-standards.md` §14.5–§14.7
