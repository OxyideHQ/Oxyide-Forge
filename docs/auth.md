# OXYIDE Authentication Contract

> **Status:** Approved
> **Scope:** Current authentication architecture and HTTP contract
> **Implementation status:** Implemented in V1. Sections marked **Current** describe shipped behavior.

This document is the dedicated authentication contract. It is consistent with `docs/architecture.md` and `docs/api-conventions.md`. **Current** means shipped in this starter. **Future** means explicitly deferred and must not be implemented until its milestone starts.

## 1. Current Authentication

Access tokens are JWTs signed with HS256. The signing secret comes from the required, validated configuration variable `JWT_SECRET`. Access-token TTL is 15 minutes, or 900 seconds.

`@fastify/jwt` is the single approved JWT implementation. The authentication plugin owns registration and configuration. The authentication service must not introduce a second JWT implementation.

### Supported Transports

Two transports feed one canonical verification pipeline (`src/plugins/auth.plugin.ts` `authenticate`):

- `Authorization: Bearer <JWT>` — always available, including production.
- `accessToken` cookie — available when the cookie plugin is registered (development/test; blocked in production until CSRF exists, see §6).

Exactly one mechanism per request: a request presenting both is rejected with `401 AUTH_INVALID_TOKEN` (consistent with `docs/api-conventions.md` §15.2). Transport never changes authentication semantics — both paths produce the same `AuthContext` or the same `401`.

### Authentication Context

Successful authentication populates the request `auth` context with the verified access-token claims. The context must expose exactly these verified claims:

```typescript
{
 sub: string;
 iat: number;
 exp: number;
}
```

The `sub` claim identifies the authenticated user. Do not introduce `userId` alongside `sub`, nested user objects, roles, permissions, scopes, session IDs, or refresh-token information. Loading the User domain entity is a separate database operation and must not be performed by authentication middleware.

Approved authentication dependencies are:

- `@fastify/jwt`
- `@fastify/cookie`
- `bcrypt`

No other authentication dependency is approved.

## 2. Passwords

Passwords are hashed with bcrypt using cost/work factor 12.

- Passwords are never logged.
- `passwordHash` never leaves the authentication boundary.
- Passwords, password hashes, access tokens, and cookies are not included in logs or error responses.

### Password Requirements

- Minimum length: 12 characters.
- Maximum length: 72 UTF-8 bytes on password-setting paths (registration, password reset), enforced by the canonical policy `validatePasswordForSetting` in `src/modules/auth/services/password.service.ts`. Route schemas keep `maxLength: 72` characters as the outer gate; the service validator is authoritative for the byte property schemas cannot express. Bcrypt silently truncates beyond 72 bytes, so longer inputs would lose entropy with prefix-sharing passwords verifying identically (F-2) — the byte bound closes that class: over-byte input is rejected before any hashing.
- Login stays unbounded (no policy check) so previously created longer passwords keep verifying exactly as before, through the identical one-bcrypt path — no timing or enumeration delta.
- Passwords are exact UTF-8 input on every path: no trimming, no Unicode normalization, no case folding — not on register, reset, or login. Whitespace (including leading/trailing), control characters, and null bytes are preserved. Composed and decomposed Unicode forms are distinct passwords.
- No additional complexity rules beyond the length requirements.
- Setting-path violations are rejected with `400 AUTH_INVALID_PASSWORD` (value-free detail naming the bound); schema violations keep Fastify's built-in 400 shape. The structured `VALIDATION_FAILED` / `TOO_SHORT` error contract remains future (consistent with `docs/api-conventions.md` §5.4).

## 3. Current Models

Only `User`, `Credential`, `Session`, `RefreshToken`, `PasswordResetToken`, `EmailVerificationToken`, and `LoginThrottle` are current authentication models.

### User

- `id`: String primary key
- `email`: unique, normalized String
- `displayName`: optional String
- `status`: enum or String, default `active`
- `role`: String, default `'user'`
- `lockedUntil`: nullable DateTime — temporary lockout marker (`NULL` = unlocked). Never exposed in `PublicUser`.
- `createdAt`
- `updatedAt`

### Credential

- `id`: String primary key
- `userId`: unique foreign key to `User`
- `passwordHash`
- `createdAt`
- `updatedAt`

The relationship is `User 1:1 Credential`.

### Session

- `id`: String primary key
- `userId`: foreign key to `User` (`ON DELETE RESTRICT` — user deletion removes owned sessions first, in the same transaction)
- `expiresAt`: absolute session bound (see §12)
- `revokedAt`: nullable family-invalidation marker, set on replay (see §12)
- `createdAt`
- `updatedAt`

### RefreshToken

- `id`: String primary key
- `sessionId`: foreign key to `Session` (`ON DELETE RESTRICT`)
- `tokenHash`: unique SHA-256 hex digest of the raw credential (see §12)
- `expiresAt`: absolute credential bound, equal to the session bound at issuance
- `consumedAt`: nullable single-use marker, set on rotation (see §12)
- `supersededBy`: nullable self-FK to the successor instance (`ON DELETE SET NULL`, unique — one predecessor per successor), audit lineage (see §12)
- `createdAt`
- `updatedAt`

The relationship is `User 1:N Session 1:N RefreshToken`. A session's instances are its token family (no separate family identifier — `sessionId` is the family key).

### PasswordResetToken

- `id`: String primary key
- `userId`: foreign key to `User` (`ON DELETE RESTRICT` — user deletion removes owned reset tokens first, in the same transaction)
- `tokenHash`: unique SHA-256 hex digest of the raw recovery credential (see §14)
- `expiresAt`: absolute credential bound, 1 hour from issuance
- `consumedAt`: nullable single-use marker, set on completion (see §14)
- `createdAt`
- `updatedAt`

The relationship is `User 1:N PasswordResetToken`. Reset credentials form no family and never rotate: each issuance supersedes previous active tokens, and completion consumes exactly once.

### LoginThrottle

- `key`: String primary key — namespaced, versioned SHA-256 of a login security dimension (account email or source IP). Raw emails and IPs never persist.
- `failureCount`: integer, incremented atomically via conditional `updateMany`.
- `windowStartedAt`: when the current fixed window began.
- `expiresAt`: absolute window bound; expired rows are recycled on the next failure.
- `createdAt` / `updatedAt`

One row per key. No foreign keys to `User` — throttle state is identity-free by design. Indexed on `expiresAt` for opportunistic cleanup.

Do not add `Role`, MFA, or other models in this milestone.

## 4. Current Endpoints

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET /api/v1/auth/me
POST /api/v1/auth/refresh
POST /api/v1/auth/password-reset/request
POST /api/v1/auth/password-reset/confirm
POST /api/v1/auth/sessions/revoke-all
```

> Exploring interactively? The Swagger UI at `/docs` prefills every auth
> request body with a runnable example (valid per the endpoint's validation
> rules — tokens excepted, which must come from a real email). The examples
> are presentation-only: validation schemas are unchanged, and placeholder
> secrets are never real credentials.

### Registration

```text
POST /api/v1/auth/register
```

#### Request

Content-Type: `application/json`

```json
{
 "email": "string (required)",
 "password": "string (required, minimum 12 characters)",
 "displayName": "string (optional)"
}
```

#### Email Handling

- Trim leading and trailing whitespace.
- Normalize to lowercase.
- Uniqueness is enforced on the normalized email.

#### displayName

- Optional.
- Preserve the documented `String` type.
- If provided, store as-is after validation (no additional trim beyond what the route schema enforces).

#### Duplicate Email

- Return `409 Conflict`.
- Error code: `USERS_EMAIL_TAKEN`.
- Do not reveal whether the email already exists or any other detail.

#### Successful Registration

- Return `201 Created`.
- Response body is the public User representation (see §10).
- Registration does NOT implicitly authenticate the user. No access token is issued. No cookie is set. Authentication is a separate operation.

#### Transaction Requirement

Registration creating `User` + `Credential` MUST occur inside one database transaction. The service layer owns the transaction boundary.

If either `User` or `Credential` creation fails:
- The entire registration operation rolls back.
- No partially-created account remains.

#### Error Responses

| Condition | Status | Code |
|---|---|---|
| Invalid request body (validation) | `400` | Fastify built-in error shape (`FST_ERR_VALIDATION`); structured `VALIDATION_FAILED` contract is future |
| Password too short | `400` | Fastify built-in error shape; structured `VALIDATION_FAILED` (field: `password`, code: `TOO_SHORT`) contract is future |
| Password over 72 UTF-8 bytes (canonical policy) | `400` | `AUTH_INVALID_PASSWORD` (value-free detail) |
| Duplicate normalized email | `409` | `USERS_EMAIL_TAKEN` |

### Login

```text
POST /api/v1/auth/login
```

#### Request

Content-Type: `application/json`

```json
{
 "email": "string (required)",
 "password": "string (required)"
}
```

#### Email Normalization

Same normalization rule as registration: trim whitespace, normalize to lowercase.

#### Credential Lookup

1. Normalize the email.
2. Locate `User` by normalized email (the lookup itself reveals nothing: found and missing accounts follow the same path below).
3. Evaluate account lockout: a live lock rejects with `429` before throttle enforcement, backoff, credential lookup, or password verification. An expired lock is recovered atomically.
4. Enforce login throttling and apply the backoff delay.
5. Obtain the associated `Credential` via the one-to-one relationship.
6. Verify the password against `passwordHash` using the password service.
7. If the `User` does not exist, the password does not match, or the account is not `active` (suspended/inactive accounts authenticate identically to wrong passwords — FIND-05), record the failure (locking the account atomically when the threshold is crossed) and return `401`. When THIS failure performs the lock transition, one post-commit account-locked notice is attempted best-effort without changing the `401`. On success, revalidate the account is still unlocked before issuing any credential.

Do not reveal whether the email or password was individually incorrect. The error message and code must be identical for both cases. Timing is equalized too: every evaluated login spends exactly one bcrypt-12 (unknown emails and missing credentials verify against a fixed dummy hash that can never authenticate — F-1), so the `401` latency cannot distinguish unknown accounts from wrong passwords. Locked and throttled accounts share the generic `429` contract below, so lock state never becomes an account-existence oracle.

#### Successful Login

- Return `200 OK`.

**Browser clients:**
- Server sets the `accessToken` cookie (see §5).
- Server sets the `refreshToken` cookie (see §12).
- A `Session` and its initial `RefreshToken` instance are persisted in one service-owned transaction before any cookie is set; if persistence fails, login fails with no partial state and no credential delivered.
- Response body contains the public User representation (see §10).

**Non-browser clients:**
- Server does NOT set a cookie (no refresh transport exists for non-cookie clients — see §12).
- Response body contains the access token:

```json
{
 "accessToken": "string"
}
```

Do not return `password`, `passwordHash`, or the `Credential` object. Do not include roles, permissions, scopes, session IDs, or refresh tokens. The raw refresh credential is delivered only in the `refreshToken` cookie — never in any JSON body.

#### Error Responses

| Condition | Status | Code |
|---|---|---|
| Invalid request body (validation) | `400` | Fastify built-in error shape (`FST_ERR_VALIDATION`); structured `VALIDATION_FAILED` contract is future |
| Invalid credentials (email or password) | `401` | `AUTH_INVALID_CREDENTIALS` |
| Login throttled (threshold exceeded) | `429` | `AUTH_TOO_MANY_ATTEMPTS` |
| Account locked (lockout active) | `429` | `AUTH_TOO_MANY_ATTEMPTS` (byte-identical to throttling — see § Lockout below) |

#### Login Throttling

Login throttling is fixed-window frequency control over two independent dimensions, backed by PostgreSQL (`LoginThrottle` table). It is **not** account lockout — state expires naturally and no unlock flow exists (owns lockout).

**Policy:**

| Dimension | Key | Threshold | Window |
|---|---|---|---|
| Account | SHA-256 of normalized email | 5 failures | 15 minutes |
| Source | SHA-256 of client IP | 30 failures | 15 minutes |

**Enforcement order:** the user lookup runs first (lock state lives on the `User` row), then the lock gate, then the throttle check — all before credential lookup and password verification. A throttled attempt returns `429` without performing bcrypt work and without revealing whether the account exists.

**Failure recording:** only evaluated authentication outcomes are recorded — unknown email and wrong password increment both dimensions identically. Schema-invalid requests (`400`) never reach the throttle logic. Infrastructure failures propagate (fail closed) and are never recorded.

**Success reset:** a successful login clears account-scoped throttle state. Source-scoped state is left to expire naturally — one correct guess must not erase abuse protection for the originating client.

**Enumeration resistance:** enforcement reads throttle rows before any user lookup, and failure recording is identical for unknown emails and wrong passwords. Observable behavior (status, body, throttle transitions) cannot distinguish the two.

**Key format:** `auth:login:v1:account:<sha256>` and `auth:login:v1:ip:<sha256>`. Raw emails and IPs never reach the persistence layer. Empty source addresses collapse to a single `unresolved` bucket.

**Source IP:** Fastify's socket-derived `request.ip`. No forwarded header is consulted — with no trusted-proxy configuration, `X-Forwarded-For` is client-controlled and must never select the throttle key.

**429 response:**

```json
{
 "type": "https://docs.oxyide.com/errors/auth-too-many-attempts",
 "title": "Too many login attempts. Please try again later.",
 "status": 429,
 "detail": "Too many login attempts. Please try again later.",
 "code": "AUTH_TOO_MANY_ATTEMPTS"
}
```

No `Retry-After` header: the fixed-window expiry is per-key and the response does not reveal which dimension triggered, so a single safe value cannot be computed.

**Storage:** PostgreSQL `LoginThrottle` table (`key`, `failureCount`, `windowStartedAt`, `expiresAt`). Atomic increments via conditional `updateMany`; expired rows are recycled on the next failure (opportunistic cleanup, no background worker). Multi-instance safe — all instances share the same PostgreSQL state.

**Infrastructure failure:** fail closed. A throttle-store outage propagates to the sanitized `500` contract; login never bypasses the control and never masks an outage as an authentication outcome.

#### Brute-Force Protection

layers bounded exponential backoff over the throttle, reusing the same `LoginThrottle` state — no new table, no migration. Repeated failures become progressively more expensive without ever becoming permanent. It is **not** account lockout — all state expires naturally and no unlock flow exists (owns lockout).

**Policy (`config.auth.bruteForce`, hardcoded like all auth constants):**

| Parameter | Value | Rationale |
|---|---|---|
| `baseDelayMs` | 250 | Comparable to one bcrypt-12 operation (~250ms); each escalated attempt roughly doubles attacker cost |
| `maxDelayMs` | 2000 | Bounded at 2s: uneconomic for guessing, too short to weaponize into denial of service, too short to accumulate pending timers |
| `escalationStart` | 1 | The first ever attempt is never delayed; the configured cap is exactly reachable before the threshold rejects |

**Escalation formula** (pure function `calculateBruteForceDelay`, integer bit-shift arithmetic, no floating point):

```text
failureCount < escalationStart → 0ms
otherwise: delay = min(baseDelayMs × 2^(failureCount - escalationStart), maxDelayMs)
```

Reachable delays before the account threshold (429 at 5 failures) rejects: `0, 250, 500, 1000, 2000`ms for failureCount `0–4`. Non-finite, negative, and fractional inputs are guarded (return 0 or floor, never NaN/Infinity/negative).

**Enforcement order:** validate → normalize → user lookup → lock gate → throttle check (429 preserved unchanged) → async delay → credential lookup → password verification → record failure / reset on success. The delay is derived from pre-user-lookup account failure state and applied before any authentication work.

**Delay implementation:** `setTimeout`-based async `delay` — never blocks the Node.js event loop (proven: health checks stay responsive during a delayed login). No worker threads, no queues, no transactions held across the sleep. Throttle updates remain single-statement atomic operations.

**Dimensions:** backoff derives from the **account** dimension only. A heavily-abused source does not escalate any account's delay — otherwise an attacker could penalize arbitrary victims by spraying from one IP. The source dimension keeps the threshold (30/15min) instead.

**Enumeration resistance:** the delay is a pure function of pre-lookup `failureCount`, and failure recording is identical for unknown emails and wrong passwords — so an unknown email and a known email with a wrong password receive the same delay at equal failureCount. No account-existence oracle (proven by parity tests at state and response level).

**Success reset:** a successful login clears account-scoped throttle state (hence its progressive delay). Source-scoped state is left to expire — one correct guess must not erase abuse protection for the originating client.

**DoS analysis:** the 2s cap bounds per-request timer cost; the 429 thresholds still stop excessive volume (account 5/15min, source 30/15min); throttled requests skip both delay and bcrypt. An attacker targeting `victim@example.com` can impose at most a 2s delay per attempt on that account's logins — temporary, self-expiring, and cleared entirely by one successful login.

**No-lockout boundary:** no `lockedAt`/`lockedUntil`/`isLocked` columns, no unlock endpoint, no notifications, no CAPTCHA. Maximum state (`maxDelayMs`) still recovers via window expiry or successful login.

#### Account Lockout Policy

adds temporary, bounded, account-scoped lockout on `User.lockedUntil` (`NULL` = unlocked), reusing the throttle state for failure counting — no new throttle table, no migration beyond one nullable column, no Redis. The "no lockout columns" statement above describes the pre-tree; what follows supersedes it.

**Policy (`config.auth.accountLockout`, hardcoded like all auth constants):**

| Parameter | Value | Rationale |
|---|---|---|
| `failureThreshold` | 5 | Equals the account threshold — the only reachable value, since the throttle caps the live-window count at 5. Lower would lock legitimate users for ordinary typos |
| `lockoutDurationSeconds` | 1800 (30 min) | Fixed and non-extending: at most one bounded window of denial per attack, with password-reset recovery |

**State machine:**

```text
UNLOCKED (lockedUntil NULL)
 | repeated invalid credentials (count reaches 5 in a live window)
 v
LOCKED (lockedUntil = now + 30min)
 | lockedUntil <= now (request-driven conditional clear)
 v
UNLOCKED
```

**Enforcement order:** validate → normalize → user lookup → lock gate → throttle check → backoff delay → credential lookup → bcrypt → record (+ atomic lock transition) / revalidate + reset + issue. The lock gate fires before throttle enforcement because a live lock is stronger; both reject with the byte-identical 429 below.

**429 response:** locked accounts return the existing `AUTH_TOO_MANY_ATTEMPTS` envelope — same status, code, message, headers (no `Retry-After`). Internal lockout is never exposed: a locked known account is indistinguishable from an unknown or throttled one at equal treatment. No new error code exists deliberately.

**No bcrypt, no delay, no recording while locked:** a live lock rejects immediately. Attempts made while locked change nothing, so attacker traffic can never extend the lockout — victim denial is strictly bounded at one duration. The backoff delay is skipped for locked accounts (sleeping then rejecting would waste resources); the resulting fast-429 timing matches the unknown-account profile, which also skips bcrypt.

**Atomic failure-to-lock transition:** the account-dimension increment and the lockout marker commit in one service-owned transaction (conditional lock-set: only when no live lock exists). Concurrent threshold-crossers converge; a live lock keeps its original expiry. No transaction is ever held across backoff delay or bcrypt.

**Success semantics:** after password verification, the account is re-read — a lock committed mid-flight blocks issuance (fail closed, no session). Otherwise an expired lock is recovered via conditional clear (a lost race re-reads once; a fresh lock survives), account throttle state is reset, and issuance proceeds normally. Clearing is expiry-conditional so a stale success can never erase a newer lock.

**Expiry and recovery:** request-driven conditional clear, no background worker. Because the lockout duration (30 min) exceeds the throttle window (15 min), post-lockout throttle state is always already expired — recovery is inherently clean, with the next failure starting at count 1. Successful password reset also clears the lock marker and the account throttle row (the presenter proved control of the recovery channel; there is deliberately no unlock endpoint). Source-scoped throttle state is left to expire per.

**Session/refresh/JWT boundary:** lockout blocks new password authentication only. Existing sessions keep working, refresh keeps rotating (it checks user status, still `active`), and issued access JWTs drain to their ≤15-minute expiry. No blacklist, no session revocation on lock — revoking sessions on failed logins would let attackers sign victims out, and ADR-008 reserves revocation for deliberate user/security events. Password reset still revokes all sessions per.

**Refresh, verification, revoke-all, /me:** unchanged and independent. Email verification never touches lockout state; revoke-all never touches lockout state; refresh never consults it.

**Victim-lockout tradeoff:** an attacker who knows `victim@example.com` can force at most one 30-minute lock per attack window (vs 15-minute throttle windows today), cannot extend it with further traffic, and cannot lock via IP spray (lockout is strictly account-scoped: per-account failure counts only). The victim recovers via expiry or password reset at any time. Permanent blocking is structurally impossible: every lock carries an expiry, every transition is conditional, no code path sets a lock without a bound.

**Infrastructure failure:** fail closed. Lock reads, increments, transitions, and clears all propagate; a lockout-store outage yields the sanitized `500`, never a bypass and never a masked authentication outcome.

**Notifications:** the transition result (`transitionedToLocked`) is returned to the login flow, which attempts one post-commit account-locked notice on a true transition only (see § Security Notifications). Already-locked retries and pre-threshold failures never notify.

**Storage:** `User.lockedUntil TIMESTAMP(3) NULL`, added by additive migration `20260929112728_add_user_locked_until`. Existing rows read `NULL` = unlocked. No new index (every access is via the unique-email lookup; a global locked-user listing is not a V1 feature). No history table, no audit rows (owns notifications; owns auditing).

### Logout

```text
POST /api/v1/auth/logout
```

#### Authentication

Logout does NOT require a valid bearer token. When the request carries a refresh credential, its family is revoked server-side (see Revocation below); otherwise logout only clears cookies. Bearer-only callers carry no session identifier by design — access JWTs intentionally contain no `sessionId` (ADR-008) — so server-side revocation is only possible when the refresh credential is presented. An unauthenticated client may call this endpoint to clear any stale cookie. Absent, unknown, expired, consumed, or already-revoked credentials all yield the same `204` — identification is best-effort with no existence oracle. A database failure during revocation propagates to the sanitized `500` contract instead of a false `204`.

#### Cookie Behavior

- Clear the `accessToken` cookie.
- Clear the `refreshToken` cookie using its own scoped path (`/api/v1/auth/refresh`).
- Use the same cookie paths and configuration as the cookies defined in §5 and §12 to ensure the browser removes them.

#### Revocation Behavior

Logout revokes the session/family identified by the presented refresh credential (`Session.revokedAt` set); other sessions of the same user are unaffected. Already-issued access JWTs are NOT revoked and drain to their ≤15-minute expiry (no blacklist — see §12).

#### Bearer Token Behavior

Logout does NOT revoke stateless bearer access tokens. The access JWT in a cleared cookie likewise remains cryptographically valid until its ≤15-minute expiry.

#### Successful Response

- Return `204 No Content`.
- Empty response body.

#### Error Responses

- Database failure during session revocation → sanitized `500` (never a false `204`).
- All credential states otherwise succeed with `204` (clears cookies if present, no-op otherwise).

### Revoke All Sessions

```text
POST /api/v1/auth/sessions/revoke-all
```

Revokes every live session owned by the authenticated user. This is the public form of the session-domain primitive established in; unlike logout (which revokes the single credential-identified family), it operates at user scope.

#### Authentication

Bearer or `accessToken`-cookie authentication is **required** (`requireAuth` preHandler). Identity comes exclusively from `AuthContext.sub` — no `userId`, email, or session identifier is read from the path, query, body, or headers, so cross-user targeting is structurally impossible.

#### Request

No body is required or interpreted; query strings and body parameters are ignored. The operation needs only the authenticated principal.

#### Successful Response

- Return `204 No Content` with an empty body — for zero, one, or many sessions, first call or repeat.
- No session count, session ID, timestamp, or device metadata is returned.
- Both auth cookies are cleared with their existing names/paths/attributes (a browser retaining a valid ≤15-minute access JWT is the only client-side mitigation available — see below).

#### Revocation Semantics

- Every `Session` row with `Session.userId = AuthContext.sub` transitions to `revokedAt != NULL` in one set-based conditional update; already-revoked rows keep their original timestamps. All refresh credentials of those families fail validation afterwards; rows are retained, never deleted.
- Already-issued access JWTs are NOT revoked and drain to their ≤15-minute expiry (no blacklist).
- A subsequent login creates a new independent session; revoked sessions never reactivate.

#### Concurrency

- Refresh racing revoke-all: either the refresh commits first (then revocation lands after) or revocation commits first (then refresh fails) — final state is always fully revoked with no usable successor.
- Login racing revoke-all: a session created after revocation completes stays live and independent; pre-existing sessions are revoked either way.
- Logout racing revoke-all: both succeed; final state fully revoked.

#### Error Responses

- Missing/invalid access authentication → `401` via the existing hook contract (service never reached).
- Database failure → sanitized `500` (never a false `204`).

### Current User

```text
GET /api/v1/auth/me
```

Returns the current persisted user represented by the authenticated identity.

#### Authentication

Bearer or `accessToken`-cookie authentication is **required** (`requireAuth` preHandler). No roles or
permissions are required; every authenticated user may read only their own
record. The endpoint accepts no body, query parameters, or path parameters,
and no request-supplied identity is trusted.

#### Identity vs State

- **Identity source:** `AuthContext` (`request.auth.sub`), populated by the
 existing authentication hook from the verified JWT. The JWT is never
 re-parsed in the route.
- **Current state source:** the PostgreSQL `User` record, loaded through
 `usersService.findById`. Role, status, and profile changes — and account
 deletion — are reflected here. Token claims are never treated as current
 user state.

#### Successful Response

- Return `200 OK` with the public User representation (see §10).
- The response never contains `passwordHash`, `Credential`, tokens, or
 secrets.

#### Stale Subject

A valid JWT whose subject no longer exists fails as an authentication
error, not a fabricated user:

- Return `401 Unauthorized`.
- Error code: `AUTH_INVALID_TOKEN`.
- No user is created, no token is refreshed, nothing is revoked (revocation arrives in a later milestone).

### Password Reset Request

```text
POST /api/v1/auth/password-reset/request
```

Starts password recovery. Unauthenticated; no credential of any kind is required or honored.

#### Request

Content-Type: `application/json`

```json
{
 "email": "string (required)"
}
```

Email handling is identical to registration/login: trim whitespace, normalize to lowercase, same validation shape.

#### Successful Response

- Return `204 No Content`, always with an empty body — for known active accounts, unknown emails, and non-active accounts alike.
- No account existence, delivery status, or token state is revealed by status, body, or timing beyond the inherent database-lookup cost (timing hardening is deferred to throttling milestones).
- For an active account: the previous active recovery credential (if any) is superseded and a new credential is persisted, then a recovery message is addressed through the mailer port (see §14).

#### Error Responses

| Condition | Status | Code |
|---|---|---|
| Invalid request body (validation) | `400` | Fastify built-in error shape (`FST_ERR_VALIDATION`); structured `VALIDATION_FAILED` contract is future |
| Email delivery failure (after persistence) | `500` | Sanitized `INTERNAL_ERROR`; the persisted credential stays usable for a retry |

### Password Reset Confirm

```text
POST /api/v1/auth/password-reset/confirm
```

Completes password recovery from a reset credential. Unauthenticated; bearer and refresh credentials are never honored here.

#### Request

Content-Type: `application/json`

```json
{
 "token": "string (required, opaque recovery credential)",
 "password": "string (required, minimum 12 characters)"
}
```

The token row is authoritative for the target user — no email or user identifier is accepted, so a credential cannot be rebound to another account. The password follows the single authoritative policy (§2): minimum 12 characters, bcrypt cost 12.

#### Successful Response

- Return `204 No Content` with an empty body.
- Exactly one atomic transition commits: credential consumed, password hash replaced, all sessions revoked. Afterwards the old password fails login, the new password works, and no pre-reset refresh credential refreshes.
- A successful reset also clears the account lockout marker (`lockedUntil`) and the account throttle row: the presenter proved control of the recovery channel, making reset the authenticated recovery path for a locked-out victim (there is deliberately no unlock endpoint). Invalid or expired tokens change nothing — only a fully validated successful reset recovers. Source-scoped throttle state is left to expire per.
- A successful reset attempts one post-commit password-change notice best-effort (see § Security Notifications). Delivery failure never rolls back the committed reset.

#### Error Responses

| Condition | Status | Code |
|---|---|---|
| Invalid request body (validation) | `400` | Fastify built-in error shape (`FST_ERR_VALIDATION`); structured `VALIDATION_FAILED` contract is future |
| Malformed, unknown, expired, consumed, orphaned, or inactive-account credential | `401` | `AUTH_INVALID_TOKEN` — one byte-identical message for all causes (`The reset token is invalid or has expired.`) |

## 5. Access-Token Cookie

| Attribute | Value |
|---|---|
| Name | `accessToken` |
| `HttpOnly` | `true` |
| `Secure` | `true` in production; `false` in development/testing |
| `SameSite` | `strict` (; was `lax` before) |
| `Path` | `/` |
| `Domain` | Unset (host-only; never shared across sibling subdomains) |
| `Max-Age` | `900`, derived from `config.auth.accessTokenTtlSeconds` (never exceeds JWT lifetime) |

### Consumption

The cookie is a supported authentication transport, not write-only: the `authenticate` hook reads `request.cookies.accessToken` when no bearer header is present and verifies it through the single shared JWT pipeline. Invalid, expired, forged, empty, or subject-less cookie values fail with the existing `401` contract (`AUTH_INVALID_TOKEN`, `AUTH_TOKEN_EXPIRED` for expiry), indistinguishable from bearer failures. A request carrying both cookie and bearer credentials is rejected (`401`).

### Transitional Status

This access-token cookie is transitional relative to the Option-D target (bearer access + HttpOnly *refresh* cookie): the refresh credential arrives in under a separate cookie name, so no rename or collision is introduced here. The cookie name `accessToken` is retained unchanged.

## 6. CSRF Boundary

CSRF synchronizer tokens are **deliberately not introduced** — the defense is structural. See ADR-012 for the full decision record.

Current posture, verified against the tree:

- Cookie authentication is dev/test-only: `src/plugins/cookie.plugin.ts` skips registration when `NODE_ENV=production`, login sets no cookie there, and the hook treats cookie-only requests as unauthenticated — production is bearer-only. Bearer tokens are supplied explicitly per request by application code, so a malicious website cannot cause a browser to attach them: there is no ambient production credential for CSRF to ride.
- Dev/test cookies are `SameSite=Strict` (; was `lax`): never sent cross-site, not even on top-level GET. Combined with `HttpOnly`, host-only (no `Domain`), and path-scoping, the browser withholds the credential cross-origin by construction.
- Exactly one credential mechanism per request (`api-conventions` §15.2): bearer + cookie together → `401`.
- CORS (: exact-allowlist, credentials never) governs cross-origin response *readability*, not request authorization — it is explicitly not a CSRF control, and must never be confused with one.
- The production cookie kill-switch is retained as deliberate defense-in-depth policy. Enabling production cookies is a future session-architecture decision that must re-prove ADR-012's premises (per-request token validation becomes required then). does not weaken the gate.

Production cookie-based authentication MUST NOT be enabled until the CSRF milestone is implemented. In production the cookie plugin is skipped, login returns a bearer token even for browser `Accept` headers, and logout is a no-op for cookies. Development and testing may use the cookie mechanism. This requirement does not weaken the engineering security requirement for production. Bearer authentication remains the supported production mechanism.

## 7. Authorization

Authorization is implemented in `src/modules/authorization` (permissions, static roles with role-to-permission mapping, authorization service, guards, and policies) and enforced on routes via `preHandler` guards and policy checks. See `docs/authorization.md` and `docs/architecture.md` §13. Multiple roles per user, role administration, permission caching, and authorization audit logging are **Future**.

## 8. Deferred Features

The following are explicitly deferred:

- Public session-management endpoints beyond revoke-all (the revoke-all endpoint exists; per-session listing/administration stays future — see §12)
- Password-change flow (no change-password endpoint exists; reset reuses the password policy and bcrypt config directly)
- Production email delivery (recovery messages go through the mailer port; default transport delivers nothing — see §14; security notices go through their own port with the same posture — see §15)
- MFA
- Account lockout administration (temporary lockout itself is current — see §4; there is no unlock endpoint and none is planned for V1)
- Suspicious-login detection
- Breached-password checks
- Durable notification delivery (transactional outbox, worker, retry) and provider-specific email integration (delivery is best-effort post-commit — see §15)

## 9. Minimum Current Tests

The authentication milestone must cover:

- Registration success
- Duplicate email rejection
- Invalid credentials
- Successful login
- JWT generation and verification
- Cookie behavior
- Logout cookie clearing
- Refresh issuance, rotation, replay detection, refresh endpoint, and refresh-cookie behavior (see §12)
- Revocation at instance, session, and all-session levels plus logout revocation (see §12)
- Public revoke-all endpoint, cross-user isolation, races, and durability (see §4)
- Password-reset request/confirm, enumeration resistance, atomic completion, and concurrency (see §14)
- Missing or invalid authentication returns `401`
- Password hashing behavior
- Redaction expectations for passwords, `passwordHash`, and tokens
- Login throttling: exact thresholds, normalization, enumeration resistance, multi-instance, concurrency, expiration, fail-closed outage (see §4)
- Brute-force backoff: pure delay function (bounds, determinism, overflow), progressive escalation, shared cross-instance escalation, non-blocking delay, success reset, temporary-lockout boundary (see §4)
- Account lockout: threshold/duration policy, atomic transition, no-extension under attack, expiry recovery, concurrency and multi-instance coherence, enumeration parity, reset recovery, refresh/session/JWT independence (see §4)
- Security notifications: transition-only lockout notice (one per lock, concurrency/multi-instance deduplicated), post-commit reset-success notice, best-effort delivery that never alters auth outcomes, template safety with no secret/internal leakage (see §15)
- Security verification hardening: equalized 401 timing via dummy-hash bcrypt for unknown/missing credentials, 72-character password maximum on creation paths, stale-code and stale-doc reconciliation

## 10. Public User Representation

The public User response is the only representation returned by authentication endpoints. It is used in registration and login responses.

### Fields

```typescript
type PublicUser = {
 id: string;
 email: string;
 displayName: string | null;
 status: string;
 role: string;
 createdAt: string; // ISO 8601 UTC
 updatedAt: string; // ISO 8601 UTC
};
```

### Rules

- Use only currently approved User fields: `id`, `email`, `displayName`, `status`, `role`, `createdAt`, `updatedAt`.
- Never expose `passwordHash`, `Credential`, or any internal authentication data.
- Do not add additional fields not listed above.
- All timestamps are ISO 8601 UTC strings with millisecond precision (consistent with `docs/api-conventions.md` §14).
- The `email` field is the normalized email (trimmed, lowercase).
- The `displayName` field is `null` if not provided during registration.
- The `role` field is the user's role name (e.g., `"user"`, `"admin"`).

## 11. Session & Refresh Token Architecture (Target — designed in, foundation implemented in)

> **Read carefully:** §1–§10 and §12 describe **Current** shipped behavior. This section describes the **Target** architecture from ADR-008. implemented the persistence foundation, issuance, and refresh endpoint; implemented rotation, replay detection, and replay-driven family invalidation; implements general revocation primitives and logout revocation (marked below). Public session-management endpoints and password hooks remain future.

### Current (shipped)

- Stateless HS256 JWT access tokens, 15-minute TTL, claims `{ sub, iat, exp }`.
- Bearer authentication; `AuthContext` carries verified identity only.
- `GET /api/v1/auth/me` resolves current User state from PostgreSQL.
- Logout clears the `accessToken` and `refreshToken` cookies when enabled and is otherwise a no-op (`204`); bearer JWTs are not revoked. Refresh-family revocation happens on logout presentation and on replay (see §12).

### Target (designed)

- **Access token:** unchanged — short-lived, stateless, bearer-first. No new claims.
- **Refresh token:** opaque 256-bit CSPRNG credential; only its SHA-256 hash persists (UNIQUE lookup). Raw tokens are never stored, logged, or returned except in the issuance cookie. JWT refresh tokens are rejected. *(Issuance + persistence implemented in; see §12.)*
- **Session:** persistent Auth-owned server state per user (`userId`, `expiresAt`, `revokedAt` plus per-instance `tokenHash`, `consumedAt`, `supersededBy`). No plaintext tokens, no device fingerprinting. Idle tracking (`lastUsedAt`) arrives only if a future milestone writes activity state. *(Foundation implemented in, rotation state in; see §12.)*
- **Rotation:** one-time use; validate → atomically consume A + create B + issue new access token, all in one service-owned transaction. A never survives rotation. *(Implemented in; see §12.)*
- **Replay:** presenting a consumed token revokes the entire session/family (fail closed), returns a generic `401`, and logs internally for future notifications. *(Implemented in; see §12. General logout/revoke-all revocation stays future.)*
- **Concurrency:** at most one live unconsumed instance per session; concurrent `refresh(A)` is serialized by the database, the loser receives replay treatment. *(Implemented in; see §12. Clients must single-flight refresh calls.)*
- **Revocation:** three distinct levels — instance (rotation), session/family (logout, replay), all user sessions (revoke-all, password change/reset). *(Implemented in.6/; the all-sessions level is publicly exposed by `POST /api/v1/auth/sessions/revoke-all` in — see §12.)*
- **Logout (target):** revoke the current session server-side and clear client credentials; access JWTs drain to expiry (≤15 min). No global JWT blacklist. *(Implemented in; see §12.)*
- **Password change/reset (future /):** revoke all sessions, require reauthentication. **Email verification:** no session effect unless product requirements state otherwise (open decision). **User status:** refresh consults live User state; non-`active`/absent users fail closed.
- **Transport:** bearer access + cookie transport for the access JWT (implemented, dev/test-only behind the CSRF gate); HttpOnly *refresh* cookie arrives with the refresh credential in under a separate name (client-agnostic core; CLI/mobile/server clients never require cookies). Production cookies stay gated on CSRF.
- **Ownership:** Auth owns session/refresh services and repositories; Users owns User data; Auth reaches users only via `usersService`. Transactions are service-owned per ADR-006; PostgreSQL is the multi-instance source of truth (no in-memory stores, no Redis truth).
- **Errors:** generic external `401`s (`AUTH_INVALID_TOKEN`/`AUTH_TOKEN_EXPIRED` where semantics match); internal causes distinguished in logs only. No new error codes in.

Full rationale, threat model, indexing, expiration/cleanup, backup/recovery, and the dependency map are in `docs/adr/008-authentication-session-architecture.md` .

## 12. Refresh Tokens (Current — rotation)

### Credential

- Opaque 256-bit credential: 32 bytes from `node:crypto.randomBytes`, base64url-encoded (43 characters) for cookie transport.
- Never a JWT, password, bcrypt hash, UUID, timestamp, database ID, user ID, or email.
- The raw credential exists in memory only: generation → hashing → persistence → cookie delivery (issuance), or cookie → hashing → lookup (refresh). It never enters logs, database records, error messages, metrics, request context, or JSON bodies.

### Hash Storage

- Persisted representation: SHA-256 hex digest (64 lowercase hex characters) in `RefreshToken.tokenHash`, UNIQUE indexed.
- Deterministic: the same raw credential always yields the same hash, enabling `WHERE tokenHash = ?` indexed lookup. No application-side secret comparison exists — the unique-index equality is the comparison.
- SHA-256 (not bcrypt/argon2): refresh validation is a high-volume keyed lookup of a high-entropy random credential, not a low-volume human-password check. A keyed-HMAC pepper is deferred hardening (it needs a second-secret rotation story).

### Lifetime

- Single absolute bound: `config.auth.refreshTokenTtlSeconds` = 7 days (604800 seconds), hardcoded like the other auth constants. No idle expiration (nothing writes activity state).
- Rationale: 7 days bounds the usable lifetime of any credential; rotation narrows the window further by killing the presented instance on every success. Server-side `expiresAt` is authoritative; cookie `Max-Age` is transport only and never trusted.

### Refresh Cookie

| Attribute | Value |
|---|---|
| Name | `refreshToken` (distinct from `accessToken`; never dual-purposed) |
| `HttpOnly` | `true` |
| `Secure` | `true` in production; `false` in development/testing |
| `SameSite` | `strict` (; was `lax` before) |
| `Path` | `/api/v1/auth/refresh` (scoped so the long-lived credential is not attached to every API request; logout clears with this same path) |
| `Domain` | Unset (host-only) |
| `Max-Age` | Remaining session lifetime (`successorExpiresAt - now`, capped by the TTL), never a fresh TTL |

Issued on browser login only (the existing browser/API-client split is preserved); gated by the same production cookie gate as (no refresh credential leaves the server in production until CSRF exists). Non-cookie clients have no refresh transport — a body-based transport may arrive later without model changes.

### Refresh Endpoint

```text
POST /api/v1/auth/refresh
```

- `POST`, no `requireAuth` bearer hook (requiring an access token would defeat refresh), no body parameters. The ONLY accepted credential is the `refreshToken` cookie — bearer tokens and the `accessToken` cookie are never honored.
- Flow: extract cookie → SHA-256 → indexed lookup → pre-validate (expiry, live family, active user) → one service-owned transaction (re-validate, atomically consume, create successor, link lineage) → sign access JWT after commit → replacement cookies. See Rotation below.
- Success: `200 OK` with `{ "accessToken": "..." }` (same shape as non-browser login), plus a replacement `refreshToken` cookie and a renewed `accessToken` cookie (HttpOnly browser clients cannot read the JSON body into their cookies). No `WWW-Authenticate` header: the Bearer challenge does not apply to the cookie credential (matches existing route-level `401` convention).
- Every credential failure — missing, empty, malformed, unknown, expired, orphaned session, revoked family, inactive or deleted user, consumed credential — returns one byte-identical `401 AUTH_INVALID_TOKEN` (`The refresh credential is invalid or has expired.`). Distinguishing causes would leak credential existence. Unexpected database errors propagate to the sanitized `500` contract; outages never masquerade as `401`.

### Token State Machine

```text
ACTIVE (consumedAt NULL, unexpired, family live)
 -- atomic conditional consume (exactly one winner) --> CONSUMED (+ successor linked)
```

- `ACTIVE + expiresAt <= now` → invalid (no state change, never replay).
- `consumedAt != NULL` presented again → replay (family invalidation, see below).
- `revokedAt != NULL` (family dead) → invalid, idempotent no-op.
- Database state is authoritative; cookie expiry is transport only.

### Rotation

Each successful refresh consumes the presented credential exactly once and issues a successor: validate → `UPDATE RefreshToken SET consumedAt WHERE id AND consumedAt IS NULL AND unexpired` (affected-row count decides the single winner; concurrent losers serialize on the row lock via READ COMMITTED re-evaluation — no raw SQL required) → create successor in the same family (`sessionId` unchanged) → link `old.supersededBy = new.id` → commit → sign JWT → set cookies. No nested transactions; JWT signing and cookie delivery happen only after commit, so a failed transaction emits nothing and leaves the old credential ACTIVE (safe retry).

- Successor is a fresh 256-bit CSPRNG credential (never the old token, never a hash mutation); only its hash persists.
- Successor expiry = the session's absolute expiry (rotation never slides the lifetime). The replacement cookie `Max-Age` tracks remaining lifetime.
- Successor `Max-Age` and flags match §Refresh Cookie above; the access cookie is renewed with the login flags.

### Replay Detection and Family Response

A consumed credential presented again is a security event, not a retry: the whole family is invalidated (`Session.revokedAt` set, idempotently, in the same transaction) and the request fails closed with the generic `401`. Every remaining live instance of the family then fails refresh — family-level response, proven by test. Consumed + already-dead family replays change nothing. Expired, unknown, or malformed presentations are never replay and write nothing. Per ADR-008, a concurrent loser "receives replay treatment": clients MUST NOT issue concurrent refreshes (single-flight) — concurrent use is indistinguishable from theft and fails closed, killing the family including the winner's just-issued successor.

### Concurrency

At most one unconsumed live instance per session at any commit point, enforced by the database conditional transition (not application locks, not Redis). Genuinely overlapping refreshes were proven to yield exactly one rotation, one successor, and one safe failure.

### Failure Behavior

- Lookup/validation failure → `401`, no transaction, no state change.
- Lost race, unconsumed row → `401`, no state change, no family action.
- Lost race, consumed row → `401` + family invalidation (replay).
- Successor-persistence failure (e.g. hash collision) → rollback → old credential stays ACTIVE → sanitized `500`; the client retries with the still-valid old credential.
- JWT-signing failure post-commit → `500` with no cookie; rotation stands, client re-logs-in. (`createAccessToken` only throws on empty subject, unreachable here.)

### Revocation

Three levels, never collapsed in code or docs:

1. **Token instance** (`RefreshToken.revokedAt`): revoking one instance blocks it without touching its family. Idempotent; consumed/expired instances are safe to mark; unknown IDs report false. A revoked instance fails refresh like any invalid credential. No production flow uses instance-only revocation yet — it is the tested domain primitive for session-management and security flows (+).
2. **Session/family** (`Session.revokedAt`): revoking one session kills every credential in the family — active, successor, and consumed alike. Logout, replay, and per-session revocation use this level. A revoked session stays revoked; nothing clears the marker.
3. **All user sessions** (set-based `UPDATE... WHERE userId AND revokedAt IS NULL`): one statement, no row loading, no loops. Returns the transitioned count; zero-session users and repeats report zero safely. Future password change/reset flows call this (ADR-008); no such caller exists in.

Revocation is state, never deletion: historical rows remain for forensics and replay classification. Single-statement revocations need no transaction; composed operations stay service-owned.

### Refresh Validity With Revocation

Lookup → instance revoked? → consumed? → expired? → session exists? → session revoked? → session expired? → user valid? → rotate. The consume predicate additionally requires `revokedAt IS NULL`, so a revocation racing rotation can never be lost: either the consume wins first (then revocation lands after) or revocation wins first (then the consume finds no row). Revoked-then-presented credentials are invalid, never replay — revocation is not consumption.

### Logout Revocation

Logout identifies the family from the presented refresh credential (any state: live, consumed, expired, revoked) and revokes it, then clears both cookies — always `204` unless persistence fails (`500`). Other sessions survive; access JWTs drain (no blacklist). Logout with no/unknown credential only clears cookies. Deliberate revocation is idempotent, so double-logout is safe.

### Limitations (explicit)

- General revoke-all and password hooks exist as tested service primitives; revoke-all is publicly exposed (`POST /api/v1/auth/sessions/revoke-all`), password hooks await their flows. Per-session listing/administration arrives in.9+.
- Expired/consumed/revoked rows remain in the database until a future cleanup milestone; all three states are enforced on every refresh regardless.
- The refresh cookie is dev/test-only behind the production CSRF gate (see §6); production has no refresh transport until then.

### Session Ownership and Cleanup

- Auth owns `Session`/`RefreshToken` persistence (services + repositories under `src/modules/auth/`); Users owns `User`. Cross-module access uses service boundaries only.
- User deletion removes owned sessions and their instances first, in the same service-owned transaction (`ON DELETE RESTRICT` ordering, mirroring credential cleanup).

## 13. Session Lifecycle (Current)

Session persistence was introduced in; completes the lifecycle contract without new models, migrations, or endpoints.

### Definition

A Session is the durable server-side authentication context: one authenticated browser/client session with a bounded lifetime, containing refresh credentials and revocation state. It is not a JWT, cookie, cache entry, or in-memory object. The session is the token-family boundary — every `RefreshToken` row carries its `sessionId`, and rotation never leaves the session that issued the presented credential.

### Derived Status

Status is derived from timestamps, never persisted redundantly (no status enum exists):

- `active`: `revokedAt IS NULL AND expiresAt > now`
- `revoked`: `revokedAt IS NOT NULL`
- `expired`: `revokedAt IS NULL AND expiresAt <= now`

A refresh credential is usable only if its instance is active (exists, unrevoked, unconsumed, unexpired) and its session is active (exists, unrevoked, unexpired) and its user exists with `status: 'active'`. All failures render the identical generic `401`.

### Creation

Browser login creates one `Session` plus its initial `RefreshToken` instance in a single service-owned transaction — both persist or neither does. No partial session, no orphan instance, no session without its initial credential.

### Lifetime

Absolute and non-sliding: `Session.expiresAt` is fixed at creation (7-day bound) and never extended. Rotation preserves `sessionId`, `createdAt`, and `expiresAt`; the successor inherits the session expiry and its cookie `Max-Age` tracks remaining lifetime. Effective credential expiry is the minimum of instance and session expiry (equal by construction).

### Persistence and Durability

Sessions live in PostgreSQL and survive request completion, application restart, client reconstruction, and horizontal scaling — proven by integration tests that rebuild the application instance and reconnect fresh clients against the same database. No in-memory maps, no Redis, no per-instance caches; every read observes committed database state.

### Revocation, Expiration, Logout, Replay

Revocation (instance, family, all-sessions) and logout revocation mark state and retain rows; expiration is time-based state requiring no background job — expired rows stay stored with `revokedAt = NULL` and remain unusable. Logout and replay preserve rows; user deletion removes them in documented `RESTRICT` order. Revoked sessions never reactivate. Cleanup/retention of expired rows belongs to a future maintenance milestone; no scheduler exists.

### Access-Token Limitation

Session operations never recall issued access JWTs, which drain to their ≤15-minute expiry. No blacklist exists.

### Future Session Management

Listing, identifying, and per-session administration build on the existing primitives (`findById`, `revokeSession`, `revokeAllSessionsForUser`) in.9+. Session IDs stay internal until that milestone defines their exposure contract. No metadata (user-agent, IP, device) is collected — unjustified PII without a consumer.

### Reconciliation

audited session invalidation against the roadmap, ADR-008, and the /implementation and found no missing behavior that the architecture permits: all three revocation levels exist as tested Auth-owned primitives, logout revokes the credential-identified family, replay and durability hold, and no public session-management endpoint is required by any authoritative document. Logout therefore IS current-session invalidation for cookie clients; bearer-only callers cannot identify a session by design (see Authentication above), and per-session administration with ownership checks belongs to the future management milestone. added no production code — only the logout-durability independence test alongside this note.

## 14. Password Reset (Current)

Recovery is a separate credential domain from sessions: reset credentials never rotate, form no families, and never touch `Session.revokedAt`. There is no change-password endpoint in this milestone; reset reuses the single password policy (§2: minimum 12 characters) and bcrypt cost 12 directly.

### Credential

- Opaque 256-bit credential: 32 bytes from `node:crypto.randomBytes`, base64url-encoded (43 characters). Never a JWT, refresh token, UUID, timestamp, user ID, or email.
- The raw credential exists in memory only: generation → hashing → persistence → email delivery (issuance), or presentation → hashing → lookup (completion). It never enters logs, database records, error messages, metrics, request context, or JSON bodies.

### Hash Storage

- SHA-256 hex digest (64 lowercase hex characters) in `PasswordResetToken.tokenHash`, UNIQUE indexed. Deterministic lookup `WHERE tokenHash = ?`; no application-side comparison. SHA-256 (not bcrypt) because the credential is high-entropy random, matching the refresh-token rationale.

### Lifetime

- Single absolute bound: `config.auth.passwordResetTtlSeconds` = 1 hour (3600 seconds), hardcoded like the other auth constants. Conservative because recovery grants password replacement: shorter than the 7-day refresh bound, long enough for email delivery plus user action. Server-side `expiresAt` is authoritative.

### Issuance Policy

- Newest-only: each request supersedes previous active credentials in the same transaction that creates the new one, so at most one usable token exists per user. Only `active` accounts receive credentials — unknown, missing, suspended, or inactive accounts resolve to the identical silent success, and recovery can never reactivate an account.

### Completion Contract

- `consume + password update + revoke-all-sessions` commit as ONE atomic security transition. Any failure rolls everything back: the token stays usable, the old password stays valid, sessions keep their state — the client retries safely.
- Exactly one concurrent confirmer can win the conditional consume; losers fail with the generic message. No second password update, no partial revocation.
- The token row owns the target user; the password is hashed (bcrypt-12) before the transaction opens; user status is re-validated against suspension/deletion races as far as the module boundary permits (accepted residual: an admin suspension landing inside the millisecond commit window still revokes all sessions — only the password landing is unstoppable, and the account stays suspended).

### Session and Access-Token Effects

- Success revokes ALL sessions of the user (`revokeAllSessionsForUser` in-transaction); rows retained. Pre-reset refresh credentials fail afterwards; a new login creates a fresh session.
- Already-issued access JWTs drain naturally (no blacklist), exactly like login/logout semantics.

### Email Delivery

- Recovery messages go through the `PasswordResetMailer` port (`to`, `resetUrl`). Since **** that port is served by an adapter over the frozen `EmailProvider` (`src/modules/auth/email/`), which is backed by the NoOp transport or, when SMTP is configured, the SMTP transport. No queue, outbox, worker, or retry exists; one call is one delivery attempt.
- The link is built from validated centralized config (`APP_BASE_URL`, production-enforced `https://`, never request Host/Origin): `{baseUrl}/reset-password?token={opaque}`. The raw token is delivered only inside that link.
- Sending happens strictly after commit — the transaction is never held open for network I/O. If delivery throws, the error propagates (sanitized `500`) while the persisted credential stays usable for a retry. Throttling of abusive requests and post-reset notifications belong to their owning milestones .

**Delivery guarantees (frozen — read this as an exclusion list, not a promise list).** Forge V1 guarantees: the credential state is committed before any delivery is attempted; the message carries a working one-time link; the transport raises only the neutral `EmailDeliveryError`; and a delivery failure never rolls back committed authentication state. Forge V1 does **not** guarantee delivery, and has **no** retry, queue, outbox, worker, delay, bounce handling, delivery/open/click tracking, or preference centre. A process crash between commit and send loses that one message, and the user recovers through the existing resend/recovery flows. Security notices are additionally best-effort: a failure is logged safely and never turns a successful sign-in into an error or alters a lockout.

### Error Semantics

- One byte-identical `401 AUTH_INVALID_TOKEN` (`The reset token is invalid or has expired.`) for malformed, unknown, expired, consumed, superseded, orphaned, and inactive-account credentials. No new error codes.
- Request validation failures are `400` via Fastify schemas. Unexpected database errors propagate to the sanitized `500` contract.

### Email Templates (FROZEN, verified in)

- Copy and markup live **only** in `src/shared/email/templates/`. Authentication passes facts to a template — the finished one-time URL, the policy-derived lockout duration, the event kind — and never rendered content. The subject/body seams (`compose*`) are gone.
- Inventory: `EMAIL_VERIFICATION`, `PASSWORD_RESET`, `SECURITY_NOTIFICATION` — the three flows, and no others. A closed `EMAIL_TEMPLATE_KEYS` tuple plus a total renderer map make the vocabulary exhaustive at compile time; `renderEmailTemplate` is the single dispatch and throws on an unknown key or an unknown notice kind.
- Each template returns `subject`, plain `text`, and `html`. Plain text is rendered from the same content model as the HTML (never by stripping tags), so both forms always carry the same message.
- Wording and subjects are preserved verbatim from.3/. The decision that a service assembles its own notice body is superseded: presentation had two owners, and a template may own only half a message. The security-notification port DTOs are therefore narrower than before — `{ to, lockoutDurationText }` and `{ to }` — and every safety property (no compromise claim, no attacker, no link, no token, no counter, no timestamp, policy-derived duration) is now asserted against the rendered message.
- Templates are pure: no I/O, no configuration, no clock, no randomness, no request context, no transport knowledge (ARCH-ENF-016). All dynamic values pass one deterministic HTML escaper. The layout is table-based, inline-styled and colour-free — Forge defines no brand palette — with no script, iframe, image, tracking pixel, or remote font.
- URLs are supplied, never reconstructed: the template receives the finished link and never learns the base URL or the token's lifetime.

### Production Transport (FROZEN, verified in)

- `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`/`SMTP_SECURITY` are validated centrally; any partial group, split credential pair, or credential-on-plaintext combination rejects at startup. `security` is explicit (`smtps` | `starttls` | `plaintext`) — there is no default, and STARTTLS is required rather than opportunistic. Certificate verification is never disabled.
- The sender is derived from `APP_BASE_URL` as `no-reply@<host>` (`defaultSenderAddress`). There is no `SMTP_FROM`: the frozen message contract requires `from`, and a second sender source would be dead configuration. A customer whose mail domain differs from their application host must align the two.
- **Auth services never learn a transport exists.** `src/modules/auth/email/auth-email-composition.ts` is the single selection point; the routes inject the composed mailers; the adapter translates a domain request into the neutral message contract and owns nothing else (no tokens, database, HTTP, retry, or template).
- Message bodies come from the shared template system: deterministic subject + plain text + escaped HTML, with the reset/verification URL supplied by the application layer. Authentication, the ports, and the transport are unaffected by copy changes.
- With no SMTP configured the composed mailers are the frozen NoOp ports themselves, so development, test, and email-free deployments behave exactly as before.

### Limitations (superseded by)

- ~~Production email delivery requires a future provider implementing the mailer port.~~ Resolved by (SMTP transport) and (wiring). Still true, and explicitly unchanged: delivery remains best-effort and at-most-once, with no retry, queue, or durable outbox — a process crash between commit and send loses the message, and a delivery failure after commit never rolls back committed credential state.
- Non-browser clients have no cookie refresh transport (pre-existing boundary, unchanged).
- No password history, expiration, lockout, or breached-password checks (deferred with the rest of account hardening).

## 15. Security Notifications (Current)

notifies users about meaningful authentication/security events by email, preserving the –state machine exactly: no response shape changes, no new endpoints, no new error codes, no migration, no queue, no worker, no provider.

### Event Matrix

| Event | Notify? | Reason |
|---|---|---|
| Account lockout (transition) | YES | High-value, bounded, non-attacker-controlled at notify time |
| Password reset success | YES | Credential change with session revocation; confirms a sensitive action |
| Password change success | DEFERRED | No change-password endpoint exists in the tree (absent) |
| Failed login (per-attempt) | NO | Attacker-controlled inbox spam |
| Throttle / backoff / 429 | NO | Attacker-controlled; same spam primitive |
| Email verification | NO | Onboarding event, not a security alert; mail unchanged |
| Logout / refresh / `/me` | NO | Normal actions; refresh during lockout is deliberate |
| Revoke-all | NO | Authenticated self-service the user just performed; no separate signal |
| Lockout expiry | NO | Not a security event; one lockout → one notice |

### Architecture

`SecurityNotificationMailer` port (`src/modules/auth/services/security-notification.service.ts`): explicit typed methods `sendAccountLocked` / `sendPasswordResetSucceeded` with narrow `{ to, subject, textBody }` DTOs — never a User row, token, password, JWT, timestamp, or counter. Static text bodies, no HTML, no links, no template engine. Provider-neutral with a NoOp default (same posture as the /ports). Since **** the routes inject the composed mailer (`authEmailMailers.securityNotification`) together with `request.log` as the safe failure logger, so a delivery failure is recorded through the existing `security.notification.delivery_failed` event and never alters the response. Since **** the notice wording is rendered by the shared `SECURITY_NOTIFICATION` template; this port supplies only the recipient and the policy-derived duration. No `NotificationService`, bus, table, or preferences — security alerts are mandatory, not opt-in. Rationale recorded in `docs/adr/011-security-notifications.md`.

### Delivery Guarantee

Best-effort, at-most-once, post-commit. Security state is authoritative; notification delivery is secondary and may fail. No retries, no durable outbox: a process crash between commit and send loses the notice (accepted V1 tradeoff; a future outbox can implement the same port). Not "guaranteed", not "exactly once", not "transactional email".

### Post-Commit Semantics

- **Lockout:** failed authentication → atomic increment-and-lock transaction commits → `transitionedToLocked` returned (never inferred) → on true, one notice attempted → the existing `401` is thrown unchanged. Locked retries record nothing and therefore never re-notify; concurrent threshold-crossers converge on exactly one notice via the conditional lock-set.
- **Reset:** token consumed + password updated + sessions revoked commit → lock/throttle recovery clears run → one notice attempted → void success stands. Invalid, expired, consumed, and duplicate tokens notify nothing; concurrent confirmations yield exactly one winner and one notice. Reset-request (known, unknown, or locked) notifies nothing — that endpoint is enumeration-resistant and attacker-callable.

### Failure Behavior

A mailer throw after commit is caught at the owning service boundary, logged as `security.notification.delivery_failed` with safe fields only (`type`, internal `userId`, provider error class — never the address, message, payload, or stack), and the primary result stands: the `401`/`429` for login, success for reset. A store failure before commit propagates fail-closed with no notice attempted (no false emails, no masked outages).

### Email Security

Subjects carry no address, IP, count, or ID. Bodies state only what the transition proves (lockout proves repeated unsuccessful attempts — never "hacked"; reset proves the password changed and sessions were revoked). No failure count, no `lockedUntil`, no token/URL, no session/JWT material. The recipient is always the canonical `User.email`; request bodies and headers cannot select it. `lockedUntil` stays out of `PublicUser`, responses, logs, and metrics.

### Limitations (explicit)

- Production delivery requires a future provider implementing the port; until then notices are attempted against NoOp.
- Durable delivery (outbox, worker, retry) is deferred, not implemented.
- No notification history, preferences, digest, SMS/push, or public API.
