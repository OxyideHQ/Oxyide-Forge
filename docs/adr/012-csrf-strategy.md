# ADR 012: CSRF Strategy — No Synchronizer Tokens

> **Status:** Accepted
> **Date:** 2026-10-01
> **Implemented:**
> **Decision makers:** Engineering
> **Supersedes:** None
> **Amends:** None
> **Related:** `docs/auth.md` §6 (CSRF Boundary), `src/plugins/cookie.plugin.ts`, `src/plugins/auth.plugin.ts`,

## Context

must settle the CSRF posture: the application sets authentication cookies for browser clients (dev/test) while production runs bearer-only behind an explicit kill-switch. The question is whether cookie-based state-changing requests need synchronizer (CSRF) tokens, Origin validation, or another per-request defense — or whether the transport architecture already removes the attack.

## Decision

**No CSRF synchronizer tokens.** The CSRF defense is structural, in three layers:

1. **Production has no automatically-attached credential.** `config.auth.cookie.enabled` is false when `NODE_ENV=production`: the cookie plugin registers nothing, login sets no `Set-Cookie`, and `authenticate` treats cookie-only requests as unauthenticated. Bearer tokens are supplied explicitly per request by application code — a malicious website cannot cause a victim's browser to attach them. There is nothing for CSRF to ride in production.
2. **Dev/test cookies are `SameSite=Strict`** (; was `Lax`). Strict cookies are never sent on cross-site requests — not even top-level GET navigations. Combined with `HttpOnly` (no JS readable credential for an XSS to steal and replay), host-only (no `Domain`), and path-scoping (`/` for access, `/api/v1/auth/refresh` for refresh), the browser itself refuses to attach the credential cross-origin.
3. **Exactly one credential mechanism per request** (`api-conventions §15.2`, enforced in `authenticate`): bearer + cookie together → 401. An attacker cannot stack a stolen bearer onto a cookied session or vice versa.

The production cookie kill-switch is retained as deliberate defense-in-depth policy, not as a TODO: enabling production cookies remains a future session-architecture decision (post-) that must re-prove this ADR's premises first.

## Rationale

1. **CSRF requires ambient authority.** The attack is a malicious site causing the browser to *automatically* attach credentials to a state-changing request. Bearer tokens are never ambient; production therefore has no CSRF attack surface by construction, not by token.
2. **Strict beats tokens for this shape.** A synchronizer token would need issuance, storage, binding, and per-request validation machinery plus its own leakage analysis — for a dev/test-only transport where the browser already withholds the credential cross-origin. The token would be checklist theater over a structural guarantee.
3. **Lax was insufficient to claim completeness** (it still sends top-level GET), hence Strict: the API has no legitimate cross-site navigation flow, and same-site XHR (the only browser-client pattern) is unaffected. Verified by the cookie attribute matrix (`auth.routes.test.ts`, `auth.integration.test.ts`, `cookie.plugin.test.ts`).
4. **No Origin/Referer validation added:** attacker-controlled, absent on same-origin navigations and privacy-stripped clients; as a *primary* defense it is weaker than Strict, and as a *secondary* defense it adds parsing risk without a threat it uniquely covers here. CORS (exact-allowlist, credentials never) is explicitly NOT a CSRF control — it governs response readability, not request authorization — and the docs preserve that distinction.

**Why not alternatives:**

- **Synchronizer / double-submit tokens** — rejected: machinery without a threat; storage/binding/leakage risks exceed the residual (nil in prod, browser-enforced in dev/test).
- **Origin-header enforcement** — rejected: weaker-than-Strict primary, redundant secondary; spoofable-but-irrelevant here since no decision trusts it.
- **Re-enabling production cookies with tokens** — rejected: session-architecture decision explicitly deferred; the kill-switch stays.
- **`__Host-` prefix** — rejected: requires `Path=/`, incompatible with the scoped refresh path; host-only + Strict already capture the benefit.

## Consequences

- No CSRF token endpoints, headers, or validation code exist — by decision, with proofs (attribute matrix, exact-one-mechanism, prod-disabled tests).
- If production cookies are ever enabled, this ADR MUST be revisited: per-request token validation (or equivalent) becomes required, and the kill-switch removal must re-prove ambient-credential safety.
- `docs/auth.md` §6 records the boundary; 's token/prefix/signing items remain owned by the future session-architecture milestone, not.
