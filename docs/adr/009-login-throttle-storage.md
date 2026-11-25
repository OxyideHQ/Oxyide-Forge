# ADR 009: Login Throttle Storage (PostgreSQL)

> **Status:** Accepted
> **Date:** 2026-09-29
> **Implemented:**
> **Decision makers:** Engineering
> **Supersedes:** None
> **Amends:** None
> **Related:** ADR-008 (session architecture), `docs/auth.md` §Login Throttling, `docs/architecture.md` §11

## Context

requires login throttling that is multi-instance safe, atomic, bounded, and enumeration-resistant. The repository has an optional Redis foundation (`src/platform/cache/`) and PostgreSQL as the primary datastore. The throttle state must be shared across all application instances.

## Decision

Use **PostgreSQL** for login throttle state. Do not use Redis.

**Rationale:**

1. **PostgreSQL is already the authoritative store** for all authentication state (sessions, refresh tokens, credentials). Adding a second store for throttle state introduces operational complexity without benefit.
2. **Redis is optional infrastructure** in this architecture (ADR-008, `docs/architecture.md` §11). Making it a hard dependency for login throttling would violate the "no unnecessary infrastructure" principle.
3. **Atomic increments are achievable in PostgreSQL** via conditional `UPDATE... WHERE key = ? AND expires_at > NOW` with `failureCount = failureCount + 1`. This is a single-statement atomic operation — no read-then-write race.
4. **The throttle write rate is low** (one increment per failed login). PostgreSQL handles this without contention concerns.
5. **TTL/expiration is handled opportunistically**: expired rows are deleted on the next failure for any key (bounded cleanup, no background worker). The `expiresAt` index keeps the scan cheap.

**Why not Redis:**

- Redis is optional; making it required for a security control is architecturally inconsistent.
- The existing Redis cache service (`cache.service.ts`) provides only `get`/`set`/`del`/`exists` — no atomic increment. Adding `INCR` + `EXPIRE` would require extending the cache service, which is scope creep for.
- PostgreSQL's conditional `updateMany` provides the same atomicity guarantee with zero new infrastructure.

**Why not process memory:**

- Process-local state is invisible to other instances. A multi-instance deployment would have independent throttle counters, making the control bypassable by distributing attempts across instances. This is explicitly forbidden by the requirements.

## Consequences

- Login throttling works in single-instance and multi-instance deployments with no additional infrastructure.
- The `LoginThrottle` table is small (one row per active throttle key) and self-cleaning.
- No Redis dependency is introduced. The Redis foundation remains optional cache infrastructure.
- If general rate limiting is needed in the future (+), it may use Redis — but that is a separate decision.

## Alternatives Considered

1. **Redis with INCR + EXPIRE** — rejected: makes optional infrastructure required for a security control; existing cache service lacks atomic increment.
2. **Process-local Map** — rejected: multi-instance bypass; explicitly forbidden.
3. **PostgreSQL with SELECT-then-UPDATE** — rejected: read-then-write race under concurrency; conditional `updateMany` is strictly better.
