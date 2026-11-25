# ADR 011: Authentication Security Notifications (Best-Effort Post-Commit)

> **Status:** Accepted
> **Date:** 2026-09-29
> **Implemented:**
> **Decision makers:** Engineering
> **Supersedes:** None
> **Amends:** None
> **Related:** ADR-008 (session architecture), ADR-009 (throttle storage), ADR-010 (lockout policy), `docs/auth.md` § Security Notifications

## Context

left an explicit bounded `lockedUntil` state with no user signal: a victim locked out by чужой guessing learns nothing. revokes all sessions on password reset with no confirmation signal. Both are high-value, low-frequency security events. Naïve notification ("email on every failed login") would hand attackers a victim-inbox spam primitive and duplicate infrastructure (queues, workers, outbox tables) the product does not otherwise need.

## Decision

Notify for exactly two events — **account locked** and **password reset succeeded** — via a dedicated **`SecurityNotificationMailer`** port with explicit typed methods, delivered **awaited post-commit** and **best-effort**:

- The lockout notice fires only when the atomic transition reports `transitionedToLocked` for THIS caller. Already-locked retries, pre-threshold failures, and unknown emails never notify.
- The reset notice fires only after a fully validated successful `completeReset` plus the post-commit recovery clears.
- Delivery failure is caught at the owning service boundary, logged with safe fields (`event`, `type`, `userId`, `errorName` — never email, message, or payload), and never alters the primary result: the 401/429 stands, the committed password change is never rolled back.
- Content is static text with no links, no tokens, no counts, no timestamps, and a policy-derived human duration ("30 minutes"). The recipient is always the canonical `User.email`.
- No new table, queue, worker, retry, endpoint, preference, provider, secret, or config. The default transport is NoOp (same posture as the /ports); routes stay unwired until a provider implements the interface.

**Rationale:**

1. **Two events, explicitly:** lockout and credential change are the only implemented state transitions that are both security-meaningful and non-attacker-controlled at notify time. Every other candidate (failed login, throttle, backoff, refresh, logout, verification, revoke-all) is either attacker-triggerable per-request (spam), a normal user action (noise), or an onboarding event (not an alert). The matrix in `docs/auth.md` records each rejection.
2. **Transition result, not pre-check:** `recordLoginFailure` returns `{ transitionedToLocked }` from inside the same transaction that sets the marker, so concurrent threshold-crossers converge on exactly one notice without a second lock state or a racy read-then-send.
3. **Awaited (choice A) over fire-and-observe (B):** awaiting keeps the promise lifecycle explicit and testable (`12.1` — no floating promises) and matches the existing post-commit mailer pattern. The latency cost lands only on threshold-crossing and reset-success requests, never on the hot login path. Fire-and-observe would need an unhandled-rejection strategy with no test seam.
4. **No outbox (choice C rejected):** durable delivery would require a notification table, dispatcher, retry policy, cleanup, and observability for two low-frequency emails. The accepted tradeoff is documented honestly: security state is authoritative; a crash between commit and send loses the notice. A future outbox can implement the same port without touching callers.
5. **No generic abstraction:** explicit methods (`sendAccountLocked`, `sendPasswordResetSucceeded`) make an unsupported event unrepresentable. A `NotificationService`/event-bus would invite non-security use and a new bypass surface.
6. **No error-name/message logging beyond class:** provider errors can echo recipients and payloads, so only `errorName` is recorded with the internal `userId`.

## Consequences

- `recordLoginFailure` returns a result object (backward compatible for callers that ignore it); `login` and `resetPassword` accept optional notification dependencies defaulting to NoOp.
- Mailer failure gains a distinct, safe log event (`security.notification.delivery_failed`) separate from authentication failures.
- auditing has explicit notified transitions to correlate; durable delivery and provider integration stay deferred.

## Alternatives Considered

1. **Notify on every failed login** — rejected: attacker-controlled inbox spam.
2. **Fire-and-observe send** — rejected per above (lifecycle + testability).
3. **Transactional outbox + worker** — rejected per above (unjustified infrastructure for two emails; deferred as future path).
4. **Generic notification service/bus with preferences** — rejected: scope creep into a notification platform; security alerts stay mandatory.
5. **Including reset/verify links or timestamps in notices** — rejected: token-adjacent content and state leakage with no consumer need.
6. **Suppressing notices for suspended accounts** — rejected: adds a policy read to the failure path for no product requirement; the notice goes to the canonical address whenever the transition occurs.
