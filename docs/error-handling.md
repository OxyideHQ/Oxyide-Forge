# Oxyide Error Handling Contract

> **Status:** Normative for API error responses (; hardened).
> **Audience:** API consumers and Forge contributors.

## Canonical Envelope

Every application-originated API error returns **exactly** this shape with
`Content-Type: application/problem+json` (RFC 7807-compatible):

```json
{
 "type": "https://docs.oxyide.com/errors/auth-invalid-token",
 "title": "Unauthorized",
 "status": 401,
 "detail": "Authentication credentials were not provided or are invalid.",
 "code": "AUTH_INVALID_TOKEN",
 "instance": "/requests/req-1"
}
```

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | Stable problem-type URI: `https://docs.oxyide.com/errors/<kebab-case-code>`. Never an exception name. Naming rule for future codes: kebab-case of the `SCREAMING_SNAKE` code, same base URI. |
| `title` | yes | Short stable summary. Safe developer-authored text only. |
| `status` | yes | HTTP status actually sent. Always agrees with the response status (single send site enforces this). |
| `detail` | yes | Safe human-readable **string**. Never: stacks, SQL, Prisma internals, paths, secrets, tokens, env values, request bodies, query strings, authorization vocabulary, or non-string values. |
| `code` | yes | Stable machine-readable application code (Oxyide extension, not RFC-required). Clients branch on `code`, never on message text. |
| `instance` | yes | Occurrence identifier: `/requests/<fastify-request-id>` (opaque counter, no PII; correlates with server logs). Fallback `/requests/unknown` (defensive; Fastify always sets an ID). No separate `requestId` field exists (one correlation mechanism, not two). The same ID is emitted as the `X-Request-ID` response header on every in-pipeline response: header, `instance` suffix, and log `reqId` always agree. |

No other fields appear. Approved extensions: none today.

## Serialization Boundary (Authoritative)

The mapper is a hard trust boundary, not a formatter. Two rules make it
hold, and both are enforced in `src/shared/errors/error-mapper.ts`:

- **Validation before publication.** An `AppError` becomes a public body
 only when all four public fields pass a check: `code` must be a value
 declared in the `ErrorCodes` registry, `statusCode` must be an HTTP
 *error* status (integer 400–599), and `title`/`detail` must be
 non-empty strings. Anything else — an unregistered code, a 2xx/3xx/NaN
 status, an object `detail`, an empty title — fails closed to the generic
 500 `INTERNAL_ERROR` body. Registry membership is what makes `code` and
 the derived `type` URI server-controlled rather than merely
 convention-controlled.
- **Totality.** Classification cannot throw. Thrown values are untrusted
 and may carry throwing getters or `Proxy` traps; `mapError` returns the
 sanitized internal model if any read raises. The global handler wraps
 classification and send in a guard so no path can hand a response back
 to Fastify, which would serialize the raw message itself.

Consequences that are part of the contract:

| Input | Public result |
|---|---|
| Unregistered `AppError` code | 500 `INTERNAL_ERROR` |
| `AppError` status outside 400–599 (incl. `NaN`, 2xx, 3xx, ≥600) | 500 `INTERNAL_ERROR` |
| Non-string or empty `AppError` title/detail | 500 `INTERNAL_ERROR` |
| Status outside 400–599 on a plain object | 500 `INTERNAL_ERROR` (no `BAD_REQUEST` echo of the status) |
| Throwing getter / `Proxy` / circular / primitive / `null` throw | 500 `INTERNAL_ERROR` |

Nothing is spread, cloned, stringified, or reflected from a thrown value.
The body is assembled field by field from validated primitives, so a
circular reference or an enumerable secret has no path to the wire.
Errors never truncate their detail: values are rejected at the boundary
rather than shortened, so no published string is a silent mutation.

## 403 Detail Vocabulary

Every authorization denial publishes one stable detail —
`You do not have permission to perform this action.` It names no role, no
permission identifier, no policy, no route, and no subject-existence
fact. The precise denial reason (including the caller's role and the
required permission or role) is recorded in the server-side authorization
decision event, where it stays operator-only. This closes the residual: role and permission vocabulary is internal, and a 403 no longer
tells a caller which role it holds or which permission was missing.

## Mapping Matrices

### Prisma (centralized in `mapError`, `instanceof` + code allowlist — never message/SQL/stack parsing)

| Condition | Public code | Status | Public detail | Logging |
|---|---|---:|---|---|
| P2002 escaping to the boundary (register email already converges via `AppError`) | `CONFLICT` | 409 | `A resource with the same unique value already exists.` (no model/table/constraint/values) | none (expected) |
| P2024 pool/timeout infrastructure failure | `INTERNAL_ERROR` | 500 | generic (no URLs/hosts/pool config/SQL/stack) | error with full `{err}` |
| P2025 escaping the repository null/false idiom | `NOT_FOUND` | 404 | `The requested resource was not found.` | none (expected) |
| Unknown Prisma classes / hostile `meta` | `INTERNAL_ERROR` | 500 | generic | error with full `{err}` |

Rationale notes: no 503 here — no Retry-After policy exists, so no application error path emits 503 (owns that policy; operators distinguish via logs). The single exception is the readiness probe, which returns a bare `503 {}` outside this mapper entirely — see `api-conventions.md` §6.2. No per-constraint codes (constraint names are database-specific text; owns broader 409 policy). Repositories keep the P2025→null/false idiom and stay HTTP-free.

### Fastify / framework (centralized in `mapError`, matched by stable `code` — never message strings)

| Condition | Public code | Status | Public detail | Logging |
|---|---|---:|---|---|
| Schema validation (`FST_ERR_VALIDATION`) | `VALIDATION_FAILED` | 400 | framework message (proven value-free: deterministic AJV templates over closed schema vocabulary) | none |
| Malformed / empty JSON body | `MALFORMED_JSON` | 400 | static (payload never reflected) | none |
| Body over limit | `BODY_TOO_LARGE` | 413 | static | none |
| Unsupported media type | `UNSUPPORTED_MEDIA_TYPE` | 415 | generic (content-type value never reflected) | none |
| Other sub-500 status-carrying errors | `BAD_REQUEST` | preserved | generic | none |
| Non-status / 5xx-shaped | `INTERNAL_ERROR` | 500 | generic | error |

Pre-pipeline router errors (`FST_ERR_BAD_URL`, `FST_ERR_MAX_PARAM_LENGTH`) never reach the mapper (proven bypass — no clean interception without patching router internals); they keep safe native bodies. Documented boundary, not a second contract.

## Status Policy (Final)

One status → one stable meaning. Decided from the route-by-route inventory (17 endpoints), not from generic REST conventions:

- **404** — unknown route (generic `NOT_FOUND`); authorized-but-missing resource (`USERS_NOT_FOUND`, `ROLES_NOT_FOUND`); P2025 escaping the repository null/false idiom (generic `NOT_FOUND`). NEVER a 401 stale-subject decision (→ 401) or a 403 denial. No list endpoints exist, so no empty-collection rule is needed.
- **409** — exactly one producer: duplicate registration (`USERS_EMAIL_TAKEN`, schema → policy → existence ordering preserved; concurrent race converges via P2002 catch). Any future/escaped unique violation → generic `CONFLICT` (no model/table/constraint/value disclosure). No state machines, versioning, or other unique constraints exist — no generic conflict framework invented.
- **422 — NOT adopted (deliberate).** Zero product requirement; all validation failures (syntactic, semantic, policy-bound) are correctly 400 client-correctable input errors under the contract stable since. Adoption would churn dozens of stable responses for zero benefit. `api-conventions` reserves 422 for explicitly-documented business-rule failures, of which none exist. Proven by sweep: representative invalid inputs across all body-bearing endpoints never emit 422.
- **Preserved boundaries** — 400 malformed/schema/policy · 401 unauthenticated (never 404) · 403 denied (never 404) · 413 body limit · 414/400-bad-URL pre-pipeline native · 415 media type · 429 throttled/locked (never account-revealing) · 500 sanitized (P2024 included, no 503 from any application error path — the only 503 is `/health/ready`, which bypasses this mapper and returns an empty body).

## Coverage Boundary (Explicit)

Canonical envelope covers: `AppError` failures (validation policy, auth, authorization, conflicts, throttling, password policy), mapped Prisma errors (P2002/P2024/P2025-escaped/unknown), mapped framework errors (validation, malformed/empty JSON, body limit, media type, BAD_REQUEST fallback), the unknown-route 404 (`NOT_FOUND`), and sanitized 500s (`INTERNAL_ERROR`). Pre-pipeline router errors keep safe native bodies (proven bypass — documented boundary).

### Externally reachable error matrix

Every externally reachable error status, its producer, and whether any internal value reaches the wire:

| Status | Producer | Public code | Internal value influencing the body? | Content-Type |
|---:|---|---|---|---|
| 400 | Schema validation | `VALIDATION_FAILED` | Framework message; proven value-free (deterministic AJV templates over closed schema vocabulary) | `application/problem+json` |
| 400 | Malformed/empty JSON | `MALFORMED_JSON` | No — static | `application/problem+json` |
| 400 | Service/policy validation | domain codes | No — static developer-authored detail | `application/problem+json` |
| 400 | Generic status-carrying error | `BAD_REQUEST` | No — static | `application/problem+json` |
| 401 | Missing/invalid/expired credentials | `AUTH_INVALID_TOKEN`, `AUTH_TOKEN_EXPIRED`, `AUTH_INVALID_CREDENTIALS` | No — static | `application/problem+json` |
| 403 | Authorization/policy denial | `AUTH_FORBIDDEN` | No — one generic detail | `application/problem+json` |
| 404 | Authorized-but-missing resource | `USERS_NOT_FOUND`, `ROLES_NOT_FOUND` | No — static | `application/problem+json` |
| 404 | P2025 escaped | `NOT_FOUND` | No — generic | `application/problem+json` |
| 404 | Unknown route | `NOT_FOUND` | No — static | `application/problem+json` |
| 409 | Duplicate registration / escaped P2002 | `USERS_EMAIL_TAKEN`, `CONFLICT` | No — no model/table/constraint/value | `application/problem+json` |
| 413 | Body over transport limit | `BODY_TOO_LARGE` | No — static; oversized payload never reflected | `application/problem+json` |
| 415 | Unsupported media type | `UNSUPPORTED_MEDIA_TYPE` | No — content-type value never reflected | `application/problem+json` |
| 429 | Throttle / lockout | `AUTH_TOO_MANY_ATTEMPTS` | No — account-existence neutral | `application/problem+json` |
| 500 | Unknown error, P2024, unknown Prisma, invalid public fields | `INTERNAL_ERROR` | No — fixed body | `application/problem+json` |
| 414 | Pre-pipeline over-long route param | framework native | No request body | framework native (`application/json`) |
| 400 | Pre-pipeline malformed URL | framework native | No request body | framework native (`application/json`) |

Pre-pipeline router rejections are the only non-problem+json errors and
carry no request ID; that boundary is unchanged and documented (/preserve it). No 422 or 503 behavior exists in the error mapper by decision. The lone 503 in the system is the readiness probe's empty-bodied failure response, which never reaches this mapper.

## Request ID Correlation

- Canonical ID: Fastify's server-generated request ID (opaque per-process counter, no PII/secrets). No `requestIdHeader` is configured — client-supplied `X-Request-ID`/`request-id` values are never adopted, reflected, or logged as identifiers.
- Response contract: `X-Request-ID: <id>` on every in-pipeline response (success and error, including health). Pre-pipeline router rejections carry none (framework boundary, documented).
- Correlation triple: response header == Problem Details `instance` suffix (`/requests/<id>`) == log `reqId`. Proven per response by triangulation tests, including under concurrency.
- The ID is correlation metadata only: it never influences authentication, authorization, throttling, cookies, CORS, TLS, or any security decision.

## Error Logging Policy (Authoritative)

Client receives sanitized Problem Details; operators receive the policy below. The two surfaces are intentionally different.

### Expected vs unexpected

- **Expected client errors are never ERROR-logged**: schema/policy validation 400s, 401s, 403s (policy decisions become security *events*, not error logs), 404s, 409s, 429s, framework 4xx, malformed/oversized/media-type. Rationale: routine client behavior is not a server fault; absence keeps volume safe.
- **Unexpected failures log EXACTLY ONE authoritative error line**: unknown exceptions, Prisma infrastructure/unknown failures, 5xx framework shapes — via the global handler's single `request.log.error({err})` site. Services, repositories, and the mapper never log (verified — no duplication by construction).
- **Security events keep controlled levels** (unchanged contracts): authz-deny → warn, privileged-override allow → info, stale-subject → warn, delivery-failure → error with class-name only. Correlation via `request.log` reqId.

### Severity policy

- DEBUG: unused in production (nothing debug-only exists).
- INFO: lifecycle started/connected/disconnected, privileged-override allows (established).
- WARN: shutdown signals, redis-unconfigured/cookie-gate notices, authz denials, stale subjects, throttle/lockout enforcement paths (throttle state itself is silent; decisions surface as security events where designed).
- ERROR: unexpected 5xx (one authoritative line), shutdown/disconnect/redis-connect failures, delivery failures (class-name only).
- FATAL: unused (process exit codes signal termination; never for requests).

### What error logs contain (and never contain)

Operator error lines carry: `reqId`, allowlisted error shape (`type/message/stack/code` via the centralized serializer), event vocabulary for security events. They NEVER carry: passwords, hashes, tokens, headers, cookies, bodies, query strings, SQL, connection strings, emails, displayNames, user-agents. Stacks appear in operator logs only (never in responses). No volume limiter exists by design: expected errors are silent at ERROR level (absence is the control); ERROR fires only on genuine faults; denial-volume limiting remains future (note preserved).

### Startup / process failures

No request ID exists there and none is fabricated: startup fatal errors log via the shared-factory fallback logger; shutdown/disconnect errors log at their sites. No shutdown-semantics change.

## Developer Rules

- Services/guards/plugins throw `AppError` (or framework errors); they NEVER construct response bodies (enforced by ARCH-ENF-015).
- `AppError` message/title/detail are safe static strings — never interpolate secrets, tokens, user input, or error causes. Never throw a non-registered code or a non-error status; the mapper will discard the whole representation.
- Authorization denials use the centralized `AUTH_FORBIDDEN_DETAIL` constant. Service denial reasons are operator-only and never become a public `detail`.
- Only `src/shared/errors/error-mapper.ts` builds public error bodies (plus the global handler that sends them).
- Unknown failures MUST map to the generic 500 body; never reflect `error.message`.
- Logging an error is not a serialization step. The `err` Pino serializer reduces non-`Error` throws to a fixed marker so the redaction walk cannot raise inside the error handler.
