# ADR 008: Authentication Session Architecture (Target)

> **Status:** Accepted; rotation + replay-driven family invalidation implemented in, general revocation primitives + logout revocation implemented in (public session-management endpoints remain future)
> **Date:** 2026-09-28
> **Implemented:** (persistence, issuance, refresh endpoint), (atomic consumption, successor issuance, replay response), (instance/session/all-session revocation, logout revocation)
> **Decision makers:** Engineering
> **Supersedes:** None
> **Amends:** ADR-001 (extends, does not alter current stateless contract)
> **Related:** ADR-006 (transaction ownership), `docs/auth.md`, baseline, `/me`

## Context

audited and extended a stateless JWT model (`src/modules/auth/services/auth.service.ts`, `src/modules/auth/services/token.service.ts`, `src/plugins/auth.plugin.ts`):

- Access tokens are HS256 JWTs, 15-minute TTL, claims exactly `{ sub, iat, exp }`.
- `AuthContext` (`src/types/auth-context.ts`) carries verified identity only — no roles, sessions, or token material.
- `GET /api/v1/auth/me` resolves current state via `usersService.findById`, but long-lived state remains unrevocable: logout (`src/modules/auth/routes/auth.routes.ts:135`) clears a cookie only, and deleted-user JWTs stay cryptographically valid until expiry.

The starter must grow persistent, revocable, rotating sessions without architectural debt. answers *how*; + implement. No code, schema, or behavior changes in this ADR.

## Decision

Adopt the target model below. Language is deliberate: **"Current"** = shipped; **"Target"** = designed here, implemented in later milestones.

```text
CURRENT:
 User → Credential → Stateless JWT → AuthContext → API

TARGET:
 User → Session → Refresh-token lifecycle → Short-lived Access Token → AuthContext → API
```

PostgreSQL is the persistent source of truth for revocation and session state. The client is never the source of truth. Raw refresh tokens never become database state. All session transactions are service-owned. Auth never imports the Users repository.

## Terminology

- **Access Token (Current, preserved):** short-lived JWT used to authenticate API requests. Stateless, signed, not revocable before expiry.
- **Refresh Token (Target):** long-lived opaque bearer credential used to obtain a new access token and continue a session. High-entropy random bytes; only its one-way hash persists.
- **Session (Target):** persistent server-side authentication context belonging to one User. The revocation boundary; survives restarts; holds lifecycle metadata, never plaintext tokens.
- **Token Family (Target):** the lineage of refresh-token instances issued for one session through rotation. The unit of replay response.
- **Token Instance (Target):** one refresh credential in a family chain. Single-use: consumed exactly once on rotation.
- **Revocation (Target):** server-side invalidation of an instance, a family/session, or all of a user's sessions.

"Token", "session", "refresh token", and "JWT" are not interchangeable in any + design or review.

## Authoritative State

| Holder | Knows | Does not know |
|---|---|---|
| JWT (access) | identity (`sub`) + `iat`/`exp` | roles, sessions, revocation, mutable user state |
| PostgreSQL (Target) | current User state, session state, refresh-token lifecycle state | plaintext refresh tokens |
| AuthContext | verified request identity `{ sub, iat, exp }` | everything else |
| Client | its access credential + its refresh credential (per transport) | other sessions, hashes, server state |

Mutable authorization and session state never enter the JWT. This preserves ADR-001 and keeps `/me` semantics intact.

## Access-Token Contract (Current, unchanged)

HS256 via `@fastify/jwt` (`src/plugins/auth.plugin.ts`, `src/modules/auth/services/token.service.ts:30-39`), TTL 900s (`src/config/index.ts:25`), claims exactly `{ sub, iat, exp }`. Evaluated and **rejected** for:

- `sid`/`jti` (session/token ID): unnecessary — sessions are resolved at refresh time, not per request; would leak internal IDs into client-visible tokens and require a per-request session check that defeats stateless access.
- `iss`/`aud`: unnecessary — single issuer, no multi-audience deployment.
- `role`/permissions/scopes: rejected — authorization stays server-side (ADR-001/002); embedding roles invites stale-privilege bugs.
- `typ`: unnecessary — only one token type exists on the wire today.

No JWT implementation change in. If a future milestone demonstrates a concrete invalidation/observability need for `jti`, it must return with rationale rather than assuming it.

## Refresh-Token Design (Target)

Opaque 256-bit credential: 32 bytes from `node:crypto.randomBytes`, base64url-encoded for transport. **JWT refresh tokens are rejected** — a self-contained refresh token cannot be revoked without consulting state, which defeats the purpose of introducing state.

- **Generation:** CSPRNG only, at issuance, inside the owning service (never in routes or repositories).
- **Hashing:** SHA-256 hex digest persisted; compared with a constant-time equality check after indexed hash lookup. SHA-256 (not bcrypt) is chosen because refresh validation is a high-volume keyed lookup, not a low-volume password check: bcrypt's cost factor makes indexed lookup infeasible (no deterministic index key without storing a pepper scheme), while SHA-256 gives O(1) unique-index lookup with negligible collision risk (256-bit preimage space). A keyed HMAC pepper is deferred as future hardening — it requires a second-secret rotation story that does not need to ship safely.
- **Lookup:** `WHERE tokenHash = ?` on a UNIQUE index; then expiry/consumption/revocation checks in the same transaction.
- **Raw-token handling:** exists only at issuance (server → client transport) and at presentation (client → server). Never persisted, never logged, never in error messages, snapshots, or non-issuance responses.
- **Expiration:** two bounds, both configured (exact durations are the product decision, not hardcoded here): absolute session lifetime and idle lifetime, enforced in PostgreSQL comparisons.
- **Rotation:** one-time use (see below). **Revocation:** instance/session/all-sessions (see below). **Replay:** family revocation (see below).

## Session Design (Target, minimum fields)

Per-session row (Auth-owned, names/rfc to be fixed in the schema proposal):

- `id` (UUID PK): identity for revocation targeting. Written once; read by refresh/revoke/logout. Not security-sensitive alone. PK index.
- `userId` (FK → User): ownership. Written once; read by revoke-all and audits. Indexed (`(userId, revokedAt)`).
- `createdAt` / `updatedAt`: lifecycle metadata. Written by service; read by audits/cleanup. Not sensitive.
- `expiresAt`: absolute session bound. Written at creation; read on every refresh. Indexed for cleanup scans.
- `revokedAt` (nullable): revocation marker. Written by logout/replay/revoke-all/password events; read on every refresh. The row is retained until expiry for replay detection.
- `lastUsedAt` (nullable): idle-expiry basis. Written on each rotation; read on refresh. Mutable, non-sensitive.

Per-instance row (one per issued refresh token):

- `id` (UUID PK), `sessionId` (FK), `tokenHash` (UNIQUE, indexed lookup key), `createdAt`, `expiresAt`, `consumedAt` (nullable — set atomically on rotation), `supersededBy` (nullable FK to the replacement instance, for audit lineage).

No device fingerprinting, IP tracking, or user-agent profiling is collected: has no requirement for it, and invasive fields expand PII exposure without a consumer.

## Rotation Model (Target)

```text
Refresh Token A → validate (session active, instance live, unexpired)
 → atomically: mark A consumed + create instance B + update session.lastUsedAt
 → issue Refresh Token B + new access JWT
```

A is never valid after successful rotation. Validation, consumption, and issuance occur in **one service-owned transaction** (ADR-006). Repositories accept `tx` and never open it.

## Replay Detection (Target, mandatory)

Presenting an already-consumed instance token is treated as a **compromise signal**, not a benign retry:

1. Reject the request with the generic external `401` (no revocation reason leaked).
2. Revoke the **entire session/family** server-side (set `revokedAt`; all live instances for the session become invalid).
3. Log internally with session/instance IDs for future security-notification milestones (no notification sent in — no email/queue infrastructure exists).

Rationale: a consumed token should be unknowable to anyone but the legitimate holder (who now holds B) and an attacker who copied A. Failing closed on the whole family bounds theft; rejecting only A would leave a stolen B usable. This decision is directly implementable in.6/.

## Concurrency Model (Target)

Concurrent `refresh(A)` requests must not fork the family. Required invariant, enforced by the database (not by application locks):

> Refresh validation + consumption + successor creation for one instance is atomic; at most one unconsumed live instance exists per session at any commit point.

Mechanism for: single transaction with a row-level lock on the session (or the live instance row) plus the UNIQUE `tokenHash` lookup; the loser observes A as consumed and receives replay treatment. No in-memory locks, no Redis coordination.

## Revocation Levels (Target, distinct)

1. **Instance:** consumption on rotation. Used by: refresh.
2. **Family/session:** `revokedAt` set; all instances die. Used by: logout (current session), replay detection, per-session admin revoke.
3. **All user sessions:** all active sessions for `userId` revoked. Used by: revoke-all, password change, password reset.

These levels are never collapsed in code or docs: a function revoking "a token" must name which level it revokes.

## Logout (Target vs Current)

- **Current** (`src/modules/auth/routes/auth.routes.ts:135`): unauthenticated, clears `accessToken` cookie when enabled, else no-op, `204`. No revocation exists.
- **Target:** authenticated logout revokes the **current session/family** server-side and instructs credential removal client-side (cookie clear + discard bearer/refresh material). The short-lived access JWT remains cryptographically valid until its ≤15-minute expiry — an explicit, accepted tradeoff. A global JWT blacklist is **rejected**: it converts every authenticated request into a stateful lookup, reintroduces the shared-state cost the access token exists to avoid, and buys at most 15 minutes of narrowed window.

## Password / Reset / Verification / Status (Target interactions)

- **Password change:** revoke **all** sessions for the user, require reauthentication, establish a fresh session on success. Access tokens drain naturally (≤15 min).
- **Password reset (high-risk):** same as change, strictly: all sessions revoked, no "keep current session" exception (the requesting session is unauthenticated by definition).
- **Email verification (decision, closing the open product question):** no session effect — verification creates, revokes, and consumes nothing session-related — and no verification-gated login policy. Unverified users authenticate exactly like verified users; `emailVerifiedAt` is proof-of-control state only.
- **User status** (existing values only: `active`, plus repository-observed `inactive`/`suspended`, plus deleted): refresh consults **both** session state and current User state (consistent with `/me` reading live state). Non-`active` or absent users fail refresh as revoked; existing access JWTs drain to expiry. No new statuses are introduced.

## Cookie Architecture (Target decision: Option D)

implements transport; fixes the decision. **Chosen: D — bearer access token + HttpOnly refresh cookie as a transport option.**

- Core session/refresh model stays **client-agnostic** (CLI, mobile, server-to-server use refresh-in-body or equivalent non-cookie transport; cookies are never required for the model to work).
- Browsers receive the refresh credential as `HttpOnly` + `Secure` (prod) + `SameSite=lax` + scoped-path cookie; the short-lived access token stays bearer-first to avoid CSRF-amplifying every API call into a cookie-authenticated one.
- Rejected: A (access-in-cookie — maximizes CSRF surface on every request), B/C variants that force all clients through cookies or duplicate credentials across transports (browser-specific, hostile to CLI/mobile).
- Production cookie enablement stays gated on the CSRF milestone (ADR-001 §CSRF gate, `src/plugins/cookie.plugin.ts:19-24`); must not weaken it.

## Module & Transaction Ownership (Target)

- **Auth owns** session and refresh lifecycle: session service, refresh service, session/refresh repositories under `src/modules/auth/`. **Users owns** User data. Auth resolves users exclusively through `usersService` (ARCH-ENF-001 already enforces the repository boundary and covers future session repositories placed under Auth).
- **Services own** refresh/revoke/revoke-all transactions (`prisma.$transaction`, ADR-006); repositories accept `tx?: Prisma.TransactionClient` and never open transactions (ARCH-ENF-002 already enforces this).
- No shared/generic "session repository" outside Auth; no transaction-context framework (architecture §10 Future).

## Error & Side-Channel Contract (Target)

External responses stay generic (`401`, existing `AUTH_INVALID_TOKEN` / `AUTH_TOKEN_EXPIRED` where semantics genuinely match); internal causes (consumed vs revoked vs expired vs replay) are distinguished in server logs only. Refresh/session endpoints must not reveal session existence, token lineage, hashes, IDs, or revocation reasons. No new error codes are created in — /add codes only if a genuinely new client-actionable meaning exists (per api-conventions §2.3 stability). Login timing/throttling side channels remain –scope.

## Indexing, Expiration, Cleanup, Backup, Multi-Instance, Failures

- **Indexes (required queries, no migration now):** instance `tokenHash` UNIQUE (presentation lookup); session `(userId, revokedAt)` (revoke-all + active-session listing); instance `sessionId` (family operations); `expiresAt` (cleanup scans). Write cost is one indexed insert per rotation — the expected steady-state write rate.
- **Expiration vs cleanup:** logical expiry is authoritative at refresh time; physical row cleanup is a deferred, scheduler-free operation that must never delete unexpired or recently-revoked rows needed for replay detection (retention window bounded by max refresh TTL, product to confirm — no invented durations here).
- **Backup/recovery:** sessions ride the normal PostgreSQL backup. Restoring a stale backup can resurrect revoked sessions; recovery procedure (runbook note) must include a revoke-all/forced-reauth step after any point-in-time restore. No backup infrastructure is modified.
- **Multi-instance:** PostgreSQL-backed only. In-memory session Maps, process-local revocation lists, and Redis-as-truth are prohibited (Redis remains optional cache, never the revocation source).
- **Failures:** DB-unavailable during refresh → generic 500, state unchanged, safe to retry; consumed/revoked/expired → generic 401, state unchanged except replay-triggered family revocation; transaction rollback → no partial family fork; restarts → state re-read from PostgreSQL; stale access tokens drain to expiry; stale refresh tokens fail closed.

## Threat Model (summary; full table in the audit report)

Stolen access (≤15-min window, mitigated by short TTL + no sensitive claims) · stolen refresh (bounded by rotation + revocation + hash storage) · replay (family revocation) · concurrent refresh (atomicity invariant) · DB compromise (hashes only, no plaintext) · dump exposure (same) · log leakage (raw-token prohibition) · XSS (HttpOnly refresh cookie + short bearer window) · CSRF (cookie gate + bearer-first access) · logout race (server revocation wins; access drains) · reset compromise (revoke-all) · fixation (fresh CSPRNG instance per login/rotation, never client-supplied) · substitution (hash-bound session linkage) · deletion (user-state check at refresh) · stale-restore (revoke-all on recovery). Residual risk in each case is documented as draining windows and deferred hardening (pepper, notifications, lockout), each mapped to its future milestone.

## Consequences

- /can implement transport + schema without revisiting rotation, replay, revocation, ownership, or transaction questions.
- Short-lived access tokens remain unrevocable by design (≤15-min residual window) — accepted explicitly, not overlooked.
- No implementation, migration, dependency, or behavior change ships with this decision.

## Alternatives Considered

1. **JWT refresh tokens** — rejected: unrevocable without state; reintroduces the exact problem sessions solve.
2. **bcrypt-hashed refresh storage** — rejected: lookup-cost mismatch (§Refresh-Token Design).
3. **Global access-token blacklist** — rejected: per-request state lookup cost for ≤15-min gain (§Logout).
4. **Session ID in access claims** — rejected: leaks internals, adds per-request checks, no demonstrated need (§Access-Token Contract).
5. **Cookie-only auth core** — rejected: browser-specific, hostile to CLI/mobile/server clients (§Cookie Architecture).
6. **In-memory/Redis session truth** — rejected: breaks multi-instance and contradicts Redis-optional architecture.
