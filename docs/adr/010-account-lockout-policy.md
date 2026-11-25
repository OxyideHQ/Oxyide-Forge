# ADR 010: Temporary Account Lockout Policy

> **Status:** Accepted
> **Date:** 2026-09-29
> **Implemented:**
> **Decision makers:** Engineering
> **Supersedes:** None
> **Amends:** None
> **Related:** ADR-008 (session architecture), ADR-009 (throttle storage), `docs/auth.md` § Account Lockout Policy

## Context

 (fixed-window throttling) and (bounded backoff) make guessing expensive but never refuse authentication outright. must add a stronger response — temporary account lockout — without creating permanent blocking, an account-enumeration oracle, a victim-lockout denial-of-service primitive, or new infrastructure.

## Decision

Store the lockout marker on **`User.lockedUntil`** (nullable timestamp; `NULL` = unlocked), set by an **atomic increment-and-lock transition** when account failures reach **5 within a live throttle window**, lasting a **fixed, non-extending 30 minutes**. Locked password logins return the **existing `429 AUTH_TOO_MANY_ATTEMPTS`** contract byte-identically. Existing sessions, refresh, and JWTs are **unaffected**. Recovery is **expiry-driven or via successful password reset**; there is **no unlock endpoint**.

**Rationale:**

1. **User-level, not throttle-row state:** lockout is an account property whose 30-minute lifecycle outlives the 15-minute throttle window. Tying it to `LoginThrottle` rows would couple it to window recycling and per-key expiry semantics that differ.
2. **No dedicated lock table:** one nullable column, no new indexes (every access is via the unique-email lookup), no history table. The smallest model that carries the lifecycle.
3. **Threshold equals the throttle threshold (5):** the only reachable value — the throttle caps the live-window count at 5, and a lower threshold would lock legitimate users for ordinary typos.
4. **Fixed, non-extending duration:** attempts made while locked record nothing and change nothing, so attacker traffic can delay a victim's recovery by at most one bounded window, never indefinitely. The conditional lock-set additionally never overwrites a live lock, preserving the original expiry across re-locks.
5. **429 reuse, not a new code:** at equal treatment a locked known account is indistinguishable from an unknown or throttled one. A dedicated lockout code would be an account-existence oracle.
6. **Sessions survive lockout:** revoking sessions on failed logins would let attackers sign victims out and would conflate failed-login state with the ADR-008 session lifecycle, which reserves revocation for deliberate user/security events. Password reset still revokes all sessions per.
7. **Reset (not an endpoint) recovers:** a successful reset proves control of the recovery channel, giving locked-out victims an immediate path without building an admin console explicitly excludes.

**Why not alternatives:**

- **Permanent lock / unlock endpoint / admin console** — rejected: unrecoverable state without recovery infrastructure; explicitly -excluded scope.
- **Lockout on LoginThrottle rows** — rejected: lifecycle mismatch (window recycling vs 30-minute account state); risks accidental coupling to source/IP windows.
- **Session revocation on lock** — rejected: victim-DoS amplification; contradicts ADR-008 revocation ownership.
- **Distinct 429 sub-code or 423 Locked** — rejected: enumeration oracle; new taxonomy without client-actionable need.
- **Extending lock on locked attempts** — rejected: indefinite victim-lockout DoS with zero attacker cost.

## Consequences

- Password authentication can be refused for up to 30 minutes per attack window; all other auth surfaces behave exactly as before.
- `User` gains one nullable column via additive migration; existing rows read `NULL` (unlocked).
- The failure path gains one short service-owned transaction (increment + conditional lock-set); no transaction is ever held across backoff delay or bcrypt.
- notifications have an explicit, bounded state to observe (`lockedUntil` transitions); no event system is built here.

## Alternatives Considered

1. **Separate lock table** — rejected: unjustified model + persistence complexity for one timestamp with no independent query pattern.
2. **IP-scoped locking** — rejected: lets one source lock arbitrary victims; already owns IP throttling separately.
3. **Lockout with session revocation** — rejected per above.
4. **Longer/indefinite duration** — rejected: availability risk without proportional security gain over 30 minutes + reset recovery.
