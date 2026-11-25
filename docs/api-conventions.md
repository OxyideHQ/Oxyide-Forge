# Oxyide Forge — API Conventions

> **Status:** Mandatory
> **Audience:** API designers, implementers, consumers, SDK authors
> **Scope:** All HTTP endpoints exposed by any OXYIDE module
> **Relationship to other docs:** This document is subordinate to `docs/architecture.md` and consistent with `docs/engineering-standards.md`. If a rule conflicts, the architecture wins and this document must be corrected.

This document defines the REST contract for OXYIDE. Every current (`auth`, `users`, `roles`, `health`) and future module MUST conform. Consistency is more important than local preference.

**V1 Baseline:** This document defines the V1 API conventions. V1 is the completed and audited foundational platform. All future development must preserve the V1 contracts unless explicitly promoted through the change management process.

Legend:

- **Current** — present in the frozen V1 starter.
- **Future** — approved extension point; not implemented yet.
- **Forbidden** — not allowed under any circumstance.

---

## 1. URL Structure

### 1.1 Base path

All API routes are mounted under a single base path:

```text
/api/v1
```

Health endpoints are the only exception and are mounted outside the versioned namespace:

```text
/health/live
/health/ready
```

**Current:** `/api/v1` prefix. `GET /health/live` and `GET /health/ready` are public infrastructure endpoints outside the versioned namespace.
**Future:** Additional versions may be added (`/api/v2`); existing versions must remain stable.

### 1.2 Path grammar

```text
/api/v1/<resource>[/<id>[/<sub-resource>[/<sub-id>]]]
```

Rules:

- Resources are lowercase, plural nouns.
- Path segments are hyphen-separated, not camelCase or snake_case.
- No verbs in URLs. Behavior is expressed by HTTP method.
- No trailing slashes. `/users` and `/users/` are the same resource; only one form is routed.
- No file extensions.

**GOOD:**
```text
GET /api/v1/users
GET /api/v1/users/u_01HX...
POST /api/v1/users
GET /api/v1/users/u_01HX.../roles
GET /api/v1/roles
POST /api/v1/auth/login
POST /api/v1/auth/logout
```

**BAD:**
```text
GET /api/v1/getUsers
POST /api/v1/user/create
GET /api/v1/users.json
POST /api/v1/auth/loginUser
```

### 1.3 Query parameters

Query parameters are `snake_case`? No. OXYIDE uses **`camelCase`** for all query parameters and JSON fields, consistently.

**GOOD:**
```text
?pageSize=20&cursor=...&sort=createdAt:desc&filter[status]=active
```

**BAD:**
```text
?page_size=20&sort_by=created_at
```

### 1.4 Reserved prefixes

The following prefixes are reserved and must not be used for domain resources:

- `/health`
- `/metrics` (future)
- `/.well-known` (future)
- `/docs` (OpenAPI UI, if enabled)

---

## 2. API Versioning

### 2.1 Version in the path

**RULE:** The major API version is in the URL path: `/api/v1`. A breaking change requires a new major version (`/api/v2`), which does not exist in V1 and is not pre-created.

**WHY:** Simple, cacheable, explicit, independent of headers, and inspectable in logs without parsing headers.

**GOOD:**
```text
GET /api/v1/users/{id}
```

**BAD:**
```text
GET /users
GET /api/users?version=1
GET /api/v1/users with an Accept-Version: 2 header
```

### 2.2 The major version is a contract, not a release number

**RULE:** `v1` denotes one major compatibility contract. Backward-compatible evolution happens inside `v1`.

**WHY:** Consumers must be able to reason about stability without tracking releases.

**Explicitly forbidden:**

- Minor or patch URL versions (`/api/v1.1`, `/api/v1.0.3`) — additive evolution belongs inside `v1`.
- Using `package.json` `version` as a proxy for the API version. **The package version and the API major version evolve independently.** A release of `2.0.0` does not imply `/api/v2`, and no `/api/v2` is created without an explicit breaking-change decision under §2.4.
- Version negotiation of any kind: `Accept-Version`, `X-API-Version`, query parameters, hostnames, or content negotiation. None exist; none may be added without an architecture decision.

### 2.3 Backward compatibility

A change is **backward compatible** when every client that conformed to the previous published contract still behaves correctly against the new one, without modification.

**Compatible (may ship inside the current major version):**

| Change | Why it is safe |
|--------|----------------|
| Adding a new endpoint | Nothing existing changes. |
| Adding an **optional** request field with a default | Existing requests remain valid and unchanged. |
| Adding a new optional query parameter | Same. |
| Adding an `operationId`, tag, or description in OpenAPI | Documentation only. |
| Adding a new OpenAPI component | Documentation only. |
| Adding a new error `code` for a genuinely new failure mode | Clients match documented codes and must ignore unknown ones (§7.3). Existing failures keep their codes. |
| Adding an optional response field **on a resource whose contract documents tolerant decoding** | Only compatible if §6 states clients must tolerate unknown response fields. See the caution below. |
| Relaxing a constraint that was never satisfiable (e.g. a limit no client could reach) | Unobservable. |

**NOT automatically compatible (assess each case explicitly):**

| Change | Why it needs judgement |
|--------|------------------------|
| **Adding a required response field** | Breaks strict clients and generated models. |
| **Adding a response field at all** | V1 response schemas are `additionalProperties: false` and actively strip undeclared fields (§6.9); document and serializer must change together. |
| **Adding an enum value** | Client generators emit closed enums; a new `status` value can break a strict client. Compatible only where the contract explicitly documents tolerant decoding. |
| **Changing nullability** (`null` ↔ missing) | Both are contractual (§6.4); consumers may branch on either. |
| **Relaxing validation** | Observable: previously rejected requests now succeed. |
| **Tightening validation** | Observable: previously accepted requests now fail. |
| **Changing a default** | Observable behaviour change. |
| **Changing an error `code` meaning** | Breaking, even though the status is unchanged. |

### 2.4 Breaking changes

A change is **breaking** when it alters externally observable contract for a client that conformed to the previous published contract. Breaking changes require a **new major API version**; they are never shipped inside the current one.

Breaking changes include:

- Removing or renaming an endpoint, path parameter, request field, or response field.
- Changing a field's type, format, or nullability where clients may rely on it (§6.4).
- Changing the meaning of an existing field, parameter, error `code`, or operation — an identical wire shape with different semantics is still breaking.
- Changing a success or error status code for the same condition.
- Changing Problem Details semantics (§7) in any observable way.
- Changing authentication requirements, or changing authorization requirements in a way that invalidates a previously valid client.
- Changing documented pagination, sorting, or filtering semantics once an endpoint adopts them (§8–§10).
- Changing the `Location` header convention of a `201` (§6.7).
- Removing or renaming an `operationId` (it is part of the machine-readable contract; see §2.5).

**Not breaking:** internal refactoring, storage changes, logging changes, performance work, dependency upgrades, and test changes, provided the wire contract — paths, methods, parameters, bodies, headers, statuses, error codes, and auth behaviour — is observably identical.

**Contributor rule:** any change touching a route's path, schema, handler status/body, guard, or error mapping must be classified as compatible or breaking **in the change description** before review. When in doubt, treat it as breaking and ask.

### 2.5 OperationId stability

**RULE:** `operationId` values are part of the machine-readable API contract. They are stable, unique, `camelCase`, declared explicitly on the route, and never derived from runtime object ordering, file names, or internal implementation names.

**WHY:** Generated clients and SDKs key on `operationId`; renaming one silently breaks downstream code generation.

### 2.6 Deprecation lifecycle

```text
active → deprecated → sunset-scheduled → removed
```

| Stage | Runtime | Documentation |
|-------|---------|---------------|
| **active** | Normal operation. | `deprecated` absent from the operation. |
| **deprecated** | **Fully functional and unchanged.** No status, body, auth, or authorization change. | `deprecated: true`, plus `x-deprecation-reason` / `x-deprecation-sunset` / `x-deprecation-successor`. |
| **sunset-scheduled** | Still fully functional. A removal date is published. | `Sunset` header emitted; date documented in release notes. |
| **removed** | Not served. | Operation no longer published; removal announced. |

Deprecation is **metadata and signalling**, never runtime state: no database record, no registry, no configuration switch. A deprecated operation keeps serving traffic exactly as before until the removal policy (§2.9) says otherwise. **Deprecation never introduces an error status and never changes a status code.**

### 2.7 How deprecation is declared

Deprecation is declared once, on the route, in the route schema:

```ts
schema: {
 operationId: 'legacyThing',
 deprecation: {
 deprecated: true,
 reason: 'Superseded by the batch endpoint.',
 successor: '/api/v1/batches', // optional, absolute path only
 sunset: 'Wed, 31 Dec 2026 23:59:59 GMT', // optional, future HTTP-date
 },
}
```

The route definition is the **single source of truth**. Both consumers read that same object, so documentation and runtime cannot disagree:

- **OpenAPI** — the documentation plugin derives `deprecated: true` and the `x-deprecation-*` extensions from it. Swagger UI renders `deprecated: true` natively; there is no UI-specific configuration.
- **Runtime** — a per-route `onSend` hook installed **only** on routes that declare deprecation.

**RULE:** active operations carry **no** `deprecated` key at all (absence, not `false`). A route that declares no deprecation is left completely untouched by the mechanism.

Invalid metadata fails **loudly at registration**, never degrading silently to a partial signal.

### 2.8 Deprecation signalling (HTTP)

Signalling is emitted only for deprecated operations, from the declared metadata:

```http
Deprecation: true
Sunset: Wed, 31 Dec 2026 23:59:59 GMT
Link: </api/v1/batches>; rel="successor-version"; title="Superseded by the batch endpoint."
```

| Header | RFC | Emitted when |
|--------|-----|--------------|
| `Deprecation` | RFC 9745 | Always, for a deprecated operation. The boolean form is used because the RFC's structured `@<timestamp>` form requires a declaration timestamp this contract deliberately does not keep as a second source of truth. |
| `Sunset` | RFC 8595 | Only when a sunset instant is declared. |
| `Link` (`rel="successor-version"`) | RFC 8288 | Successor when declared; otherwise the reason as migration guidance. |

**RULE:** signalling never alters the status code or the response body, and is never derived from client input. Metadata is validated so that a successor cannot publish an internal hostname, a credential, or a header injection — absolute URLs, protocol-relative URLs, userinfo, query strings, fragments, and control characters are all rejected.

### 2.9 Removal policy

- Every deprecation intended to end in removal **must** declare a sunset date. Removal without a published date is a breaking change and is forbidden.
- A deprecated operation **remains available until its published sunset date**, so no consumer is cut off without notice.
- A documented exception exists for **security emergencies**, where accelerated removal or a behaviour change may be required. That is a security decision, recorded as such; it does not silently become the normal path.
- Removal is announced in release notes and reflected in the OpenAPI document (the operation disappears; a successor is published).
- **No minimum notice period is fixed by this contract.** Each deprecation states its own removal target. Fixing a universal number here would be a project policy decision beyond this engineering contract.

### 2.10 Major-version lifecycle

| Stage | Meaning |
|-------|---------|
| **active** | Normal development under the compatibility rules of §2.3/§2.4. |
| **maintenance** | No new behaviour. Only security, correctness, compatibility, and necessary maintenance changes. |
| **sunset-scheduled** | Removal date announced; migration guidance published. |
| **removed** | No longer served. |

V1 is **active**. No second version is created by this document.

**BAD:**
```text
Endpoint silently removed.
Operation deprecated in docs but with no Sunset date.
```

---

## 3. HTTP Methods

| Method | Semantics | Safe | Idempotent |
|---|---|---|---|
| `GET` | Read a resource or collection | Yes | Yes |
| `POST` | Create a resource or trigger a non-idempotent action | No | No |
| `PUT` | Partial update of the addressed resource (Forge convention, frozen) | No | Yes |
| `PATCH` | Partial update of a resource | No | No (unless designed idempotent) |
| `DELETE` | Remove a resource | No | Yes |
| `HEAD` | Same as GET without body | Yes | Yes |
| `OPTIONS` | Capability discovery | Yes | Yes |

### 3.1 Method rules

- `GET` MUST NOT change server state.
- `POST` MUST be used to create a resource at a collection URL.
- `PUT` applies a **partial update** of the addressed resource (Forge convention, frozen): only the fields present in the request body are modified; omitted mutable fields keep their current values. Request schemas declare `required: []` for update bodies. `PUT` is idempotent: repeating an identical body leaves the resource unchanged after the first application.
- `PATCH` MUST apply a partial update using a documented merge strategy (JSON Merge Patch by default).
- `DELETE` on an existing resource returns `204`. `DELETE` on a missing resource returns `204` if the caller is authorized to know the resource could exist, otherwise `404`. Document the chosen behavior per endpoint.

### 3.2 PATCH semantics

**Future:** The following convention applies when PATCH endpoints are added.

**RULE:** `PATCH` uses JSON Merge Patch (`application/merge-patch+json`) unless an endpoint explicitly documents another strategy.

**WHY:** Simple, well-specified, and consistent with JSON.

**GOOD:**
```http
PATCH /api/v1/users/u_01HX...
Content-Type: application/merge-patch+json

{ "displayName": "Ada L." }
```

**BAD:**
```http
PATCH /api/v1/users/u_01HX...
Content-Type: application/json

{ "op": "replace", "path": "/displayName", "value": "Ada L." }
```

(JSON Patch is not part of the OXYIDE standard.)

### 3.3 No method tunneling

`X-HTTP-Method-Override` and query-based method overrides are forbidden.

---

## 4. HTTP Status Codes

Use the smallest correct set. Do not invent codes.

| Status | When |
|---|---|
| `200 OK` | Successful GET, PUT, PATCH, or action POST returning a body |
| `201 Created` | Successful POST that created a resource; includes `Location` header |
| `202 Accepted` | Async operation accepted (future) |
| `204 No Content` | Successful DELETE, or PUT/PATCH with no response body |
| `400 Bad Request` | Malformed request (invalid JSON, unknown query param, bad header) |
| `401 Unauthorized` | Missing or invalid authentication |
| `403 Forbidden` | Authenticated but not authorized |
| `404 Not Found` | Resource does not exist or is not visible to the caller |
| `405 Method Not Allowed` | Valid path, unsupported method |
| `409 Conflict` | State conflict (duplicate unique field, optimistic lock failure) |
| `412 Precondition Failed` | `If-Match` mismatch (future) |
| `415 Unsupported Media Type` | Wrong `Content-Type` |
| `422 Unprocessable Entity` | Reserved; not used (decision: all current validation failures are 400; no endpoint documents 422 business-rule failures) |
| `429 Too Many Requests` | Rate limit exceeded |
| `500 Internal Server Error` | Unhandled server error |
| `503 Service Unavailable` | Adopted **only** by `GET /health/ready` when a required dependency is unusable, a configured optional dependency is unhealthy, or shutdown is in progress. Empty body, never Problem Details. Not emitted by any other operation; no `Retry-After` policy exists. (During the brief Fastify-owned drain window, Fastify itself answers `503` on every route — see §6.2.) |

### 4.1 Distinguishing 400 vs 422

**RULE:** OXYIDE uses `400` for schema validation failures by default. `422` is reserved for well-formed requests that fail business rules when the endpoint explicitly documents it. Do not mix the two for the same class of failure.

### 4.2 401 vs 403

- `401` means “you did not authenticate or your credentials are invalid.” Include `WWW-Authenticate`.
- `403` means “you authenticated, but you are not allowed.” Do not leak whether the resource exists beyond what the caller is authorized to see.

### 4.3 404 vs 403 for hidden resources

**RULE:** When a caller is not authorized to know a resource exists, return `404`, not `403`. This avoids existence disclosure.

**Current implementation note (frozen):** user resource reads/updates/deletes — and, identically, note reads/updates/deletes — deny unauthorized cross-user access with `403` + an audit-logged ownership decision (/, tested) rather than 404-concealment. This is a deliberate fail-closed-with-trail product behavior that takes precedence for these routes, frozen as the final cross-user policy: a caller learns that a foreign-owned resource exists, but learns nothing about its contents and cannot read, modify, or delete it. Future hidden-resource endpoints should follow the `404` rule above; any deviation requires an explicit documented decision.

---

## 5. Request Validation

### 5.1 Validation at the boundary

All input is validated by Fastify route schemas before reaching the handler, consistent with `docs/engineering-standards.md` §14.

### 5.2 Content types

- Request bodies: `application/json`, or `application/merge-patch+json` for PATCH.
- Responses: `application/json`.
- Error responses: `application/problem+json` (in-pipeline; see §7 and `docs/error-handling.md`, normative since).
- File uploads: `multipart/form-data` (see §19 — **future**).

> **V1 Status:** In-pipeline error responses use `application/problem+json` with exactly `{type, title, status, detail, code, instance}`. Only pre-pipeline router rejections (malformed URL, over-long params) keep framework-native bodies — a documented boundary, not a second contract.

Unsupported media types receive `415`.

### 5.3 Unknown fields

**RULE:** Unknown request body fields are rejected by default (`additionalProperties: false`). This prevents silent typos and accidental mass-assignment.

**Future:** Endpoints may opt in to lenient mode only with a documented justification.

### 5.4 Validation error contract

A validation failure returns `400` with code `VALIDATION_FAILED` as a Problem Details body (§7.4). There is no `errors` array: the `detail` carries the value-free framework message, and clients branch on `code`, never on message text.

### 5.5 Query parameter validation

Query parameters follow the same rules. Unknown query parameters are rejected with `400`.

### 5.6 Size limits

Global and per-route body limits are enforced (see `docs/engineering-standards.md` §25.3). Oversized bodies return `413 Payload Too Large`.

---

## 6. Response Structure

### 6.1 Single resource

A single resource is returned as a flat JSON object. No `data` wrapper. No `success` flag.

Health endpoint success responses use `200 OK` and have no additional required health-specific fields.

### 6.2 Health probes

Both probes are public infrastructure endpoints outside `/api/v1`, unversioned, and unauthenticated — orchestrators cannot authenticate. Both bodies are **exactly `{}`**: the status code is the entire signal, and neither probe exposes dependency state, versions, host information, or error detail. Making them public is safe precisely because the body is empty.

`GET /health/live` answers *"is this process alive?"* It **must never** depend on PostgreSQL, Redis, or any external service, so a dependency outage can never cause a restart loop. It has no failure mode: the process not answering is the signal.

`GET /health/ready` answers *"can this instance serve traffic?"* It returns `200 {}` when every required dependency is usable and no configured optional dependency is unhealthy, and `503 {}` otherwise.

**PostgreSQL is the only required dependency.** Redis is **optional**:

| Draining | PostgreSQL | Redis | Result |
|---|---|---|---|
| no | healthy | not configured | `200` |
| no | healthy | healthy | `200` |
| no | healthy | unhealthy | `503` |
| no | unhealthy | any | `503` |
| **yes** | *(not checked)* | *(not checked)* | **`503`** |

When `REDIS_URL` is unset, Redis is not probed and cannot affect readiness. When it is set but unreachable, the process **stays observable** and this probe reports `503` while `/health/live` stays `200` — see ADR-003's amendment. A configured-but-unreachable Redis is never silently reported as "not configured."

The `503` body is deliberately **not** Problem Details. The probe is consumed by machines that read only the status code, and an unauthenticated endpoint must not carry an error envelope, code, or reason. No new error code exists in the registry for readiness.

Startup is never gated on dependency health — the process must always be able to report *not ready*, because blocking startup converts a recoverable outage into a crash loop.

**Shutdown.** Once `close` begins, readiness reports **NOT READY** and never reports ready again for that instance. Liveness keeps its own semantics while the process is running. Two windows exist, and the difference is a framework fact rather than a Forge choice:

| Window | Owner | `/health/ready` | `/health/live` |
|---|---|---|---|
| A request already past Fastify's closing check | **Forge** — `evaluateReadiness({ draining: true })` | `503 {}` | `200 {}` |
| Any later request, until the listener closes | **Fastify** — `return503OnClosing` drain short-circuit | `503` with Fastify's body | `503` with Fastify's body |

Fastify runs the closing check *before* the handler chain and closes the route tree before `preClose`, so once draining begins no Forge handler can run and every route — including `/health/live` and unrelated endpoints — receives Fastify's bare `503 {"error":"Service Unavailable","message":"Service Unavailable","statusCode":503}`. That is the framework's load-shedding fast path and is correct load-balancer behavior: a draining instance must not start new work. It is pinned explicitly in `src/app/app.ts` (`return503OnClosing: true`) so a framework default change cannot silently alter drain semantics, and it carries no dependency, credential, or host detail.

The Forge-owned window exists because a request can already be executing when shutdown starts; without `shutdownPhase.draining` a healthy database would let it answer `200` while the instance was leaving. `evaluateReadiness` short-circuits on `draining` without touching any dependency.

**Invalid configuration is not softened.** An invalid `REDIS_URL` (wrong protocol, malformed, or empty) fails validated configuration loading and aborts startup; only an unreachable *valid* server is tolerated.

Full contract: `api-conventions.md` §6.2; operator guidance in `docs/production-logging.md`.

**GOOD:**
```json
{
 "id": "u_01HX9...",
 "email": "ada@example.com",
 "displayName": "Ada Lovelace",
 "status": "active",
 "role": "user",
 "createdAt": "2026-01-15T09:30:00.000Z",
 "updatedAt": "2026-01-15T09:30:00.000Z"
}
```

**BAD:**
```json
{
 "success": true,
 "data": { "user": { "id": "..." } }
}
```

### 6.2 Collection

> **V1 Status:** Collections are NOT implemented in V1. This defines the contract for when collections are added.

Collections return an object with `items` and `pageInfo` (§8). Never a bare array.

**GOOD:**
```json
{
 "items": [ { "id": "u_01HX9..." }, { "id": "u_01HX10..." } ],
 "pageInfo": {
 "hasMore": true,
 "nextCursor": "eyJpZCI6InVfMDFIWDkuLi4ifQ",
 "prevCursor": null
 }
}
```

**BAD:**
```json
[ { "id": "u_01HX9..." }, { "id": "u_01HX10..." } ]
```

### 6.3 Field naming

All JSON fields are `camelCase`.

**GOOD:**
```json
{ "displayName": "Ada Lovelace" }
```

**BAD:**
```json
{ "display_name": "Ada Lovelace" }
```

### 6.4 Null vs missing

- A field that is defined but has no value is `null`.
- A field that does not apply to the resource is omitted.
- Do not use empty strings to represent absence.

### 6.5 Empty collections

Empty collections return `200` with an empty `items` array, never `404`.

### 6.6 Timestamps in responses

All timestamps are ISO 8601 UTC strings with millisecond precision (§14).

### 6.7 Headers

Success responses may include:

- `Location` on `201`.
- `ETag` on resources that support conditional requests (future).
- `X-Request-ID` carrying the server-generated request correlation ID (; every in-pipeline response; never client-supplied values).
- Rate limit headers (§17 — **future**).

### 6.8 No HTML, no XML

Responses are JSON only. XML is forbidden.

### 6.9 Response schemas

Every route sending a JSON body declares an explicit Fastify `response:` schema for the status it returns. The schema is runtime-enforced serialization, not documentation: the serializer strips any property the contract does not declare, so internal fields cannot leak even if a service change attached them. A service bug that drops a required public field fails closed (loud 500 through the frozen path), never a partial body.

- Ownership: the users module owns the canonical User contract (`PublicUser` type + `toPublicUser` mapper + JSON Schema in `src/modules/users/user-response.ts`); auth token envelopes and role shapes are route-local. Prisma-generated types never appear in public contracts.
- Strictness: resource schemas use `additionalProperties: false` with explicitly required fields. Open vocabularies (`status`, `role`, permission strings) stay plain `type: 'string'` — no false-precision enums.
- Null vs missing follows §6.4 (`displayName` is `string | null`, always present).
- 204 routes declare no response body. Errors are exclusively Problem Details (§7), never wrapped in a success envelope.
- Creation returns `201` with `Location: /api/v1/users/<id>` (registration only — the sole endpoint creating an addressable resource; credentials/tokens are delivered via body/cookies, not URLs).
- Collection convention (§6.2) is defined but unused: no list endpoint exists. Pagination/sorting/filtering primitives arrive in.3–; response schemas are structured (JSON Schema consts) so the OpenAPI assembler can consume them directly.

---

## 7. Error Structure

### 7.1 Error response structure

All error responses use the following shape:

```json
{
 "type": "https://docs.oxyide.com/errors/auth-invalid-credentials",
 "title": "Invalid credentials",
 "status": 401,
 "detail": "The email or password is incorrect.",
 "code": "AUTH_INVALID_CREDENTIALS",
 "instance": "/requests/req-1"
}
```

> **V1 Status:** error responses include exactly `type`, `title`, `status`, `detail`, `code`, `instance` (see `docs/error-handling.md`, normative). The `timestamp` field remains future and is NOT included. There is NO separate `requestId` field — correlation uses `instance` (`/requests/<id>`) plus the `X-Request-ID` response header, both carrying the server-generated request ID.

### 7.2 Field rules

| Field | Required (V1) | Notes |
|---|---|---|
| `type` | Yes | Stable URI identifying the error category |
| `title` | Yes | Short, human-readable summary |
| `status` | Yes | Must match the HTTP status |
| `detail` | Yes | Human-readable explanation; safe to display |
| `code` | Yes | Stable machine-readable code (§7.3) |
| `requestId` | No | No separate field exists — correlation uses `instance` plus the `X-Request-ID` response header |
| `timestamp` | **Future** | Server time when the error was produced |
| `errors` | No | Array of field-level errors for validation failures |
| `instance` | Yes | Occurrence identifier: `/requests/<server-generated-request-id>` |

### 7.3 Error codes

Codes are `SCREAMING_SNAKE_CASE` and namespaced by module, consistent with `docs/engineering-standards.md` §11.5.

**Current V1 codes:**
```text
USERS_EMAIL_TAKEN
USERS_NOT_FOUND
AUTH_INVALID_CREDENTIALS
AUTH_INVALID_TOKEN
AUTH_TOKEN_EXPIRED
AUTH_FORBIDDEN
AUTH_TOO_MANY_ATTEMPTS
AUTH_INVALID_PASSWORD
VALIDATION_FAILED
MALFORMED_JSON
BODY_TOO_LARGE
UNSUPPORTED_MEDIA_TYPE
BAD_REQUEST
CONFLICT
ROLES_NOT_FOUND
INTERNAL_ERROR
```

API errors use the canonical Problem Details contract: `application/problem+json` with exactly `{type, title, status, detail, code, instance}`. See `docs/error-handling.md` (normative since). Framework errors map centrally (: schema validation, malformed/empty JSON, body limit, media type); only pre-pipeline router rejections keep native bodies — a documented framework boundary, not a second contract.

**Future codes (examples):**
```text
RATE_LIMIT_EXCEEDED
```

**BAD:**
```text
ERROR_1
BAD_REQUEST
SOMETHING_WENT_WRONG
```

### 7.4 Validation error shape

Validation failures return the canonical six-field body with code `VALIDATION_FAILED`. There is no `errors` array and no field-level breakdown: the `detail` is the value-free framework validation message (deterministic AJV template over the closed schema vocabulary — request values are never reflected).

```json
{
 "type": "https://docs.oxyide.com/errors/validation-failed",
 "title": "Bad Request",
 "status": 400,
 "detail": "body must have required property 'password'",
 "code": "VALIDATION_FAILED",
 "instance": "/requests/req-1"
}
```

### 7.5 No internal details

Error responses never contain stack traces, SQL, ORM messages, database hosts/ports, filesystem paths, configuration values, or secrets.

**V1 Status:** Enforced by the V1 global error handler (`src/app/app.ts`), which sanitizes unexpected server errors (`statusCode >= 500`) into the generic `INTERNAL_ERROR` body (§21.12). See `docs/adr/005-global-error-handler.md`.

### 7.6 Do not localize `title` and `detail`

`title` and `detail` are English by default. Clients branch on `code`, not on message text. Localization is out of scope.

### 7.7 Error code stability

Once published, an error `code` never changes meaning or HTTP status. New behavior means a new code.

---

## 8. Pagination

> **V1 Status:** The offset page/limit primitive is implemented (`src/shared/pagination/pagination.ts`) and first consumed by `GET /api/v1/notes`. Cursor pagination below remains the documented direction for large or frequently-changing collections (not implemented).

### 8.1 Cursor pagination is the default

Large or frequently-changing collections use cursor pagination, consistent with `docs/engineering-standards.md` §22.2.

### 8.2 Request parameters

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `pageSize` | integer | `20` | Max `100` |
| `cursor` | string (opaque) | none | Returned by previous response |
| `direction` | `next` \| `prev` | `next` | Optional; defaults to `next` |

Cursors are opaque. Clients must not parse or construct them.

### 8.3 Response shape

```json
{
 "items": [ /*... */ ],
 "pageInfo": {
 "hasMore": true,
 "nextCursor": "eyJpZCI6InVfMDFIWDkuLi4ifQ",
 "prevCursor": null
 }
}
```

### 8.4 Offset pagination (implemented primitive)

Offset pagination is the implemented mode and the only mode any current endpoint may use. Cursor pagination (§§8.1–8.3) remains future.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `page` | integer | `1` | 1-based, min `1`, no max (bounded by safe-integer offset instead) |
| `limit` | integer | `20` | Min `1`, max `100` (centralized, never overridden per route) |

Validation (both layers yield 400 through the frozen contract): the query schema gates lexical shape (integer or digit-string; arrays/objects/booleans/blanks/unknown fields rejected, duplicates rejected); `parsePagination` enforces semantics (ranges, safe-integer arithmetic) with static non-reflecting details. `coerceTypes: false` is unchanged — no implicit conversion anywhere.

Normalization: omitted fields become defaults; the result is always concrete `{ page, limit, offset }` with `offset = (page - 1) * limit`. Raw query strings never reach services or repositories; repositories receive typed pagination and translate to Prisma `skip: offset, take: limit`. Paginated queries MUST specify deterministic server-defined ordering (client-controlled sorting is).

Response:

```json
{
 "items": [ /*... */ ],
 "pagination": {
 "page": 1,
 "limit": 20,
 "total": 134,
 "totalPages": 7
 }
}
```

Zero results use `"total": 0, "totalPages": 0` (pure arithmetic, no special case).

### 8.5 Rules

- Every paginated endpoint enforces the centralized maximum `limit` (100).
- Every offset-paginated endpoint returns the same `pagination` shape.
- Cursors are invalidated by underlying sort changes; return `400` with `code: "PAGINATION_CURSOR_INVALID"` if a cursor cannot be used.

---

## 9. Filtering

> **V1 Status:** The `filter[field_op]` primitive is implemented (`src/shared/filtering/filtering.ts`) and first consumed by `GET /api/v1/notes`. This section remains the canonical contract: allowlisted fields, suffixed operators, AND semantics, unknown fields → 400. Note: **filtering is never a means to escape ownership** — the authenticated owner predicate is always applied server-side and cannot be filtered away.

### 9.1 Syntax

Filters use the `filter[field]=value` convention.

```text
GET /api/v1/users?filter[status]=active
GET /api/v1/users?filter[role]=admin&filter[status]=active
```

### 9.2 Operators

For non-equality comparisons, use suffixed keys:

| Operator | Suffix | Example |
|---|---|---|
| Equals | none | `filter[status]=active` |
| Not equals | `_ne` | `filter[status_ne]=suspended` |
| In | `_in` | `filter[status_in]=active,suspended` |
| Greater than | `_gt` | `filter[createdAt_gt]=2026-01-01T00:00:00Z` |
| Greater or equal | `_gte` | `filter[createdAt_gte]=2026-01-01T00:00:00Z` |
| Less than | `_lt` | `filter[createdAt_lt]=2026-02-01T00:00:00Z` |
| Less or equal | `_lte` | `filter[createdAt_lte]=2026-02-01T00:00:00Z` |
| Contains (text) | `_contains` | `filter[email_contains]=example.com` |

### 9.3 Rules

- Only allowlisted fields may be filtered. Unknown filter fields return `400` with `code: "VALIDATION_FAILED"`.
- Multiple values for the same filter are ANDed.
- Multiple filters are ANDed.
- OR semantics require an explicit `filter[or]` form documented per endpoint; do not overload the default.
- Complexity is bounded by centralized constants: at most 10 criteria per request, 20 values per `in`-list, 256 characters per value, 64 characters per key.
- `"null"` is a literal string, never null-semantics; there is no null operator.
- Datetimes are strict ISO-8601 UTC instants with real calendar validity; booleans are not filterable.
- Supported operators per field type: string → `eq, ne, in, contains`; enum → `eq, ne, in`; integer → `eq, ne, in, gt, gte, lt, lte`; datetime → `gt, gte, lt, lte`.

---

## 10. Sorting

> **V1 Status:** The `?sort` primitive is implemented (`src/shared/sorting/sorting.ts`) and first consumed by `GET /api/v1/notes`. This section remains the canonical contract: `field:direction` entries, allowlisted fields, max three fields, stable endpoint default when omitted.

### 10.1 Syntax

```text
?sort=createdAt:desc
?sort=status:asc,createdAt:desc
```

- `field:direction`, comma-separated.
- Direction is `asc` or `desc`. Default is `asc` if omitted.
- Only allowlisted fields may be sorted.

### 10.2 Rules

- Unknown sort fields return `400` with `code: "VALIDATION_FAILED"`.
- Maximum of three sort fields per request.
- A repeated sort field returns `400` with `code: "VALIDATION_FAILED"` (freeze: duplicates are rejected, never last-wins normalised).
- If no `sort` is provided, the endpoint documents a stable default (usually `createdAt:desc` or `id:asc`).
- Deterministic tie-breaking is mandatory: the endpoint's sort configuration declares a server-owned tie-breaker, so equal primary values paginate stably. Client input never controls it.

**GOOD:**
```text
GET /api/v1/users?sort=createdAt:desc
```

**BAD:**
```text
GET /api/v1/users?orderBy=createdAt&dir=desc
```

---

## 11. Searching

> **V1 Status:** Searching is NOT implemented in V1. This section defines the contract for when searching is added.

### 11.1 Syntax

Full-text or multi-field search uses a single `q` parameter.

```text
GET /api/v1/users?q=ada
```

### 11.2 Rules

- `q` is a case-insensitive substring or full-text search, documented per endpoint.
- `q` must be combined with pagination.
- `q` must have a minimum length (default: 2 characters). Shorter values return `400` with `code: "VALIDATION_FAILED"`.
- `q` must be rate-limited more strictly than normal reads.
- `q` results include a stable `sort` default; if relevance ranking is used, it must be documented.

### 11.3 Do not mix `q` with `filter`

Endpoints may support both, but `q` is reserved for text search. Do not overload `q` for exact matching; use `filter[...]`.

---

## 12. Resource Naming

### 12.1 Plural nouns

Collections use plural nouns.

**GOOD:**
```text
/users
/roles
/sessions
```

**BAD:**
```text
/user
/getRoles
```

### 12.2 Sub-resources

Sub-resources are nested when they only exist in the context of their parent.

```text
GET /api/v1/users/u_01HX.../roles
GET /api/v1/roles/r_01HX.../permissions
```

If a sub-resource has independent identity, expose it at the top level instead:

```text
GET /api/v1/roles/r_01HX...
```

### 12.3 Actions

Actions on resources use `POST` on a verb-less sub-path when the operation is not a natural CRUD operation.

**GOOD:**
```text
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/users/u_01HX.../password-reset
```

**BAD:**
```text
POST /api/v1/loginUser
POST /api/v1/users/u_01HX.../doPasswordReset
```

### 12.4 Reserved names

`/me` is reserved for the authenticated caller. The top-level current-user paths are reserved for a future milestone and are not implemented in V1 (this does not refer to the implemented `GET /api/v1/auth/me`, which exists since):

```text
GET /api/v1/me
PATCH /api/v1/me
```

`/health` is reserved for infrastructure health checks.

---

## 13. IDs

### 13.1 Opaque strings

All resource IDs are opaque strings. Clients must not parse or construct them.

### 13.2 Format

**V1 (current):** IDs are opaque strings generated with `crypto.randomUUID` (UUID v4). They are lowercase, hyphenated, and 36 characters long:

```text
a1b2c3d4-e5f6-7890-abcd-ef1234567890 (user, credential, or any resource)
```

**Future migration:** Prefixed, sortable strings are the intended long-term format:

```text
<prefix>_<ULID>
```

```text
u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T (user)
r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T (role)
s_01HX9Z6Y7K8Q3V2N4M5P6R7S8T (session)
```

This migration requires a database migration, route schema updates, and client coordination. It will be tracked as a dedicated future milestone with an ADR. Until then, V1 UUIDs are the authoritative ID format.

### 13.3 Rules

- IDs are never integers exposed to clients.
- IDs are never sequential integers.
- IDs are opaque strings — clients must not parse or construct them.
- IDs are validated by shape at the route boundary.

**Future (when prefixed IDs are adopted):** IDs will follow `<prefix>_<ULID>` format and will be case-sensitive.

### 13.4 ID exposure

Internal database IDs must not be exposed if they differ from the public ID. Repositories map public IDs to internal keys.

---

## 14. Dates and Timestamps

### 14.1 Format

All timestamps are ISO 8601 UTC strings with millisecond precision and a `Z` suffix.

```json
"createdAt": "2026-01-15T09:30:00.000Z"
```

### 14.2 Rules

- Dates without time are forbidden in API payloads. Use timestamps.
- Local time zones are forbidden in API payloads. Convert at the boundary.
- Field names for timestamps end in `At`.
- Durations are expressed in seconds as integers, never as strings.
- TTLs in requests are expressed as integer seconds.

**GOOD:**
```json
{ "createdAt": "2026-01-15T09:30:00.000Z", "expiresIn": 3600 }
```

**BAD:**
```json
{ "created": "2026-01-15", "expires": "1h" }
```

### 14.3 Date ranges in filters

Filter ranges use the comparison operators from §9.2:

```text
?filter[createdAt_gte]=2026-01-01T00:00:00.000Z&filter[createdAt_lt]=2026-02-01T00:00:00.000Z
```

---

## 15. Authentication

### 15.1 Mechanism

The current authentication endpoints are:

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
```

Access tokens are JWTs signed with HS256 using required validated configuration variable `JWT_SECRET`. Access-token TTL is 15 minutes (900 seconds).

**Current (V1):** JWT access tokens, cookie plugin, auth module, bcrypt password hashing with cost/work factor 12. Browser cookie authentication and bearer token authentication. Authorization with RBAC (user/admin roles, 11 permissions).
**Future:** Refresh tokens, refresh-token rotation and revocation, session persistence, CSRF protection for cookie auth, password reset, email verification, MFA, account lockout, suspicious-login detection, and breached-password checks.

### 15.2 Credentials

- Browser clients authenticate with the server-set `accessToken` cookie.
- Non-browser clients receive the access token in the login response and send it using `Authorization: Bearer <accessToken>`.
- A request must use exactly one mechanism. Requests containing both the access-token cookie and an `Authorization: Bearer` header are not accepted.

The access token is never logged or returned in a URL. Passwords are never logged, and `passwordHash` never appears outside the authentication boundary.

### 15.3 Access tokens

- JWT, signed with HS256.
- Signed with the validated `JWT_SECRET` configuration value.
- Expires after 900 seconds.
- Never logged or returned in URLs.

### 15.4 Login responses

#### Non-browser client response

Non-browser clients (no cookie) receive the access token in the JSON response body:

```json
{
 "accessToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

#### Browser client response

Browser clients receive the access token via the server-set `accessToken` cookie. The response body contains the public User representation:

```json
{
 "id": "u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T",
 "email": "ada@example.com",
 "displayName": "Ada Lovelace",
 "status": "active",
 "createdAt": "2026-01-15T09:30:00.000Z",
 "updatedAt": "2026-01-15T09:30:00.000Z"
}
```

#### Registration response

Registration returns the public User representation. Registration does NOT implicitly authenticate the user:

```json
{
 "id": "u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T",
 "email": "ada@example.com",
 "displayName": "Ada Lovelace",
 "status": "active",
 "createdAt": "2026-01-15T09:30:00.000Z",
 "updatedAt": "2026-01-15T09:30:00.000Z"
}
```

#### Logout response

Logout returns `204 No Content` with an empty body.

#### Invalid credentials response

Invalid credentials return `401`:

```json
{
 "type": "https://docs.oxyide.com/errors/auth-invalid-credentials",
 "title": "Invalid credentials",
 "status": 401,
 "detail": "The email or password is incorrect.",
 "code": "AUTH_INVALID_CREDENTIALS"
}
```

### 15.5 Refresh tokens

**Future:** Refresh tokens, rotation, revocation, and session persistence are deferred.

### 15.6 Logout

```text
POST /api/v1/auth/logout
```

Clears the `accessToken` cookie. Refresh-token revocation is not performed because refresh-token and session infrastructure is deferred. Stateless bearer access tokens are not revoked in this milestone.

Cookie attributes for the current access-token cookie:

| Attribute | Value |
|---|---|
| Name | `accessToken` |
| `HttpOnly` | `true` |
| `Secure` | `true` in production; `false` in development/testing |
| `SameSite` | `lax` |
| `Path` | `/` |
| `Domain` | Unset |
| `Max-Age` | `900` (15 minutes in seconds) |

### 15.7 CSRF boundary

CSRF protection is **Future**. Production cookie-based authentication MUST NOT be enabled until the CSRF milestone is implemented. In production the cookie plugin is skipped and Bearer authentication remains available. Development and testing may use the cookie mechanism. This requirement must not be weakened.

### 15.8 Unauthenticated responses

Missing or invalid credentials return `401` with `WWW-Authenticate`:

```http
WWW-Authenticate: Bearer realm="oxyide", error="invalid_token"
```

### 15.9 Auth events

Login, logout, and failed login are current authentication events. Token refresh and password reset remain future features.

---

## 16. Authorization

> **V1 Status:** Authorization is IMPLEMENTED in V1. The V1 baseline includes RBAC with user/admin roles, 11 permissions, server-side role lookup, authorization guards, and policies.

### 16.1 Implemented authorization behavior

Routes are protected unless explicitly marked public. Public routes are listed and reviewed.

Health endpoints are public infrastructure endpoints.

Authorization is enforced at the route boundary via hooks, consistent with `docs/engineering-standards.md` §19.

### 16.2 Guards

Three authorization guards are implemented in V1:

```ts
// Verify JWT authentication
fastify.get('/me', { preHandler: [requireAuth] }, handler);

// Check specific permission
fastify.delete('/users/:id', {
 preHandler: [requireAuth, requirePermission('users:delete')],
}, handler);

// Check specific role
fastify.get('/admin/dashboard', {
 preHandler: [requireAuth, requireRole('admin')],
}, handler);
```

### 16.3 Policies

Policies are deterministic, independently testable functions that evaluate authorization decisions:

- `userPolicy` — user action policies (includes self-scope logic)

### 16.4 Response on denial

Denied access returns `401` (not authenticated) or `403` (authenticated but not authorized). A cryptographically valid token whose subject no longer exists is not authenticated (401 `AUTH_INVALID_TOKEN`): authentication requires an existing subject, verified per request.

The 403 `detail` is a single stable string — `You do not have permission to perform this action.`. It never names the caller's role, the required role or permission, the policy, the route, or whether the subject exists. Denial reasons are operator-only: they are recorded in the server-side authorization decision event. Authorization semantics are unchanged; only the public representation is generic.

```json
{
 "type": "https://docs.oxyide.com/errors/auth-forbidden",
 "title": "Forbidden",
 "status": 403,
 "detail": "You do not have permission to perform this action.",
 "code": "AUTH_FORBIDDEN",
 "instance": "/requests/req-1"
}
```

### 16.5 Hidden resources

If the caller must not know a resource exists, return `404` instead of `403`. Document which endpoints use hidden-resource semantics.

### 16.6 Self-escalation

Role and permission changes must prevent a caller from escalating their own privileges.

### 16.7 Audit

All authorization failures are logged at `warn` with actor, action, and resource.

---

## 17. Rate Limiting

### 17.1 Mechanism

> **V1 Status:** Login throttling is implemented for `POST /api/v1/auth/login` using PostgreSQL-backed fixed-window counters. General rate limiting for other endpoints is not implemented.

**Current:** Login throttling uses the `LoginThrottle` PostgreSQL table with two dimensions (account and source IP). Policy: 5 failures per account per 15 minutes, 30 failures per source IP per 15 minutes. State expires naturally. brute-force backoff adds a bounded server-side delay before authentication work but does not change this response contract. See `docs/auth.md` §Login Throttling.

**Future:** General rate limiting uses the Fastify rate-limit plugin, backed by Redis when available (see `docs/architecture.md` §11 and §21).

### 17.2 Scopes

- Global default per IP.
- Stricter per-route limits for authentication, password reset, and token endpoints.
- Per-identity limits for authenticated endpoints (future).

### 17.3 Response headers

Every response includes:

```http
RateLimit-Limit: 100
RateLimit-Remaining: 87
RateLimit-Reset: 42
```

`RateLimit-Reset` is the number of seconds until the window resets.

### 17.4 429 response

> **V1 Status:** The 429 response is implemented for login throttling. The general rate-limit headers below are documented for future use.

```json
{
 "type": "https://docs.oxyide.com/errors/rate-limit-exceeded",
 "title": "Too Many Requests",
 "status": 429,
 "detail": "You have exceeded the rate limit. Retry after 42 seconds.",
 "code": "RATE_LIMIT_EXCEEDED"
}
```

Include `Retry-After`:

```http
Retry-After: 42
```

**Current (extended):** Login throttling returns `429 AUTH_TOO_MANY_ATTEMPTS` with a generic message and no `Retry-After` header (the fixed-window expiry is per-key and the response does not reveal which dimension triggered). account lockout reuses this exact contract byte-identically: a locked account is indistinguishable from a throttled one, so lock state never becomes an account-existence oracle. See `docs/auth.md` §Login Throttling.

### 17.5 Failure behavior

Auth rate limiting fails closed. Cache-based limiting fails open only for non-security endpoints. Documented per feature in `docs/architecture.md` §11 and §25.

---

## 18. Idempotency

### 18.1 Idempotency keys

**Future:** Unsafe, non-idempotent endpoints (`POST`, and `PATCH` where the merge is non-idempotent) may support `Idempotency-Key`.

**V1 Status:** Not implemented. This section defines the contract for when it is added.

### 18.2 Contract

- Client sends `Idempotency-Key: <opaque string>` with a unique value per logical operation.
- Server stores the key, request hash, and response for a documented window (default: 24 hours).
- Repeated requests with the same key and same body return the stored response.
- Repeated requests with the same key and different body return `409` with `code: "IDEMPOTENCY_KEY_REUSED"`.
- Keys are scoped to the authenticated principal.

### 18.3 Storage

Idempotency records are stored in Redis with a TTL. If Redis is unavailable, endpoints that require idempotency fail closed.

### 18.4 Responses

Responses to idempotent replays include:

```http
Idempotency-Key: <key>
Idempotent-Replayed: true
```

---

## 19. File Uploads

### 19.1 Applicability

**V1 Status:** File uploads are NOT part of the frozen V1 starter. This section defines the contract for when they are added.

### 19.2 Contract

Uploads use `multipart/form-data` with a metadata part and one or more file parts.

```text
POST /api/v1/files
Content-Type: multipart/form-data; boundary=...
```

Metadata fields:

| Field | Required | Notes |
|---|---|---|
| `purpose` | Yes | Allowlisted purpose (e.g., `avatar`, `attachment`) |
| `file` | Yes | File part |

### 19.3 Rules

- Maximum file size is enforced per purpose.
- Allowed MIME types are allowlisted per purpose.
- Uploaded files are virus-scanned before being made available (future).
- Files are stored outside the database; the database holds metadata and a reference.
- Files are never served from the API process; a separate origin or CDN is used.
- Upload endpoints are rate-limited per identity.
- Upload responses return `201` with the file metadata resource.

### 19.4 Download

Downloads return a signed, time-limited URL. The API does not stream large files through the request handler.

---

## 20. OpenAPI Documentation

> **V1 Status:** Implemented in. `@fastify/swagger` (dynamic mode) generates the document from the route schemas; `@fastify/swagger-ui` serves an optional presentation bundle over that same document. No `src/docs` directory exists.

### 20.1 Source of truth

Route schemas are the source of truth for the OpenAPI document. `src/plugins/swagger.plugin.ts` assembles the document from registered schemas during `app.swagger`; no `src/docs` directory is part of the frozen architecture.

Success request and response bodies are **never re-declared** for documentation: the generator reads the `response:` contracts and the existing request schemas directly, so a route schema edit cannot drift out of the document. The only hand-written documentation content is what a JSON Schema cannot express:

- `info`, `tags`, `servers`, and `components` (declared once in the plugin),
- the static `ProblemDetails` component describing §7,
- the per-operation error-status table and the bodyless `204` contracts (§20.2),
- the descriptive metadata every route carries in its schema (§20.3).

`components.parameters.{PageParam,LimitParam,SortParam}` and `components.schemas.PaginationMetadata` exist for §8/§9/§10 reuse and are deliberately **unattached**: no current operation consumes them, and attaching them would be false documentation.

### 20.2 Errors and 204s

Error responses are merged into the generated document by the plugin's per-route `transform` hook (keyed by `operationId`), **not** by adding error statuses to route `response:` configs — status-keyed response serialization belongs to and must not be entered from documentation. Errors always reference `#/components/schemas/ProblemDetails` with `application/problem+json`. A `transformObject` hook strips any `content` block from `204` responses so a body can never be claimed for a bodyless status.

### 20.3 Required annotations

Every route must include:

- `summary`
- `description` (may be short)
- `operationId` (unique, stable, `camelCase`)
- `tags` defined by the Swagger registration flow in the plugin architecture
- `security` (or explicitly public, i.e. `security: []`)
- Request and response schemas
- Error responses for `400`, `401`, `403`, `404`, `409`, `429`, `500` as applicable

Operation IDs are explicit string constants, never derived from route registration order.

### 20.4 Exposure

Two independent, validated flags (`src/config/env.schema.ts`; consumed as `config.docs`):

| Flag | Default | Effect |
|------|---------|--------|
| `OPENAPI_ENABLED` | `true` (all environments) | Generate and serve the document at `/openapi.json`. |
| `SWAGGER_UI_ENABLED` | `true` except production | Serve the Swagger UI at `/docs`. |

Both accept only the exact literals `true`/`false` (whitespace tolerated); `1`, `yes`, `TRUE`, and anything else reject at startup.

**Dependency rule:** `SWAGGER_UI_ENABLED=true` with OpenAPI disabled is **rejected as invalid configuration**. Swagger UI is a presentation layer over the OpenAPI document, not an independent contract, so the request is a contradiction and startup fails rather than silently enabling generation.

Swagger UI is **disabled by default in production**, consistent with `docs/engineering-standards.md` §25.6. Operators keep `/openapi.json` and set `SWAGGER_UI_ENABLED=false` to remove the developer UI without touching generation.

**GOOD:**
```ts
// src/plugins/swagger.plugin.ts — honors config.docs
if (!config.docs.openApiEnabled) return;
```

**BAD:**
```ts
fastify.register(swaggerPlugin); // always on
```

Documentation routes live outside `/api/v1`: `/openapi.json` and `/docs` are infrastructure, alongside `/health/*`.

### 20.5 Contract tests

**Implemented in.** Two suites verify that the published document actually describes the running API:

- `src/app/openapi-contract.test.ts` — structural validity (authoritative validator), bidirectional route/method coverage, the frozen `operationId` mapping, request/response schema properties, Problem Details, security, deprecation, the reusable –§10 components, the configuration matrix, and a leakage scan. Runs without a database.
- `src/app/openapi-runtime-contract.integration.test.ts` — live responses validated **against their own published operation** for the representative classes (201, 200, 204, 400, 401, 403, 404, 409, 429). Database-gated.

**RULE:** the contract suite consumes the document the real application generates. It must never declare a second spec, and it must never duplicate a request/response schema by hand — the runtime route schema remains the source of truth. A change that adds, removes, renames, or re-shapes an operation must update the frozen contract **deliberately**; weakening the assertion to make a change pass is forbidden (§2.4).

---

## 21. Concrete JSON Examples

All examples below use `application/json` unless otherwise noted. Error examples use `application/problem+json` with the six-field contract in §7.

> **V1 Status:** The following examples show the actual V1 response shapes. Examples marked with "Future" define the contract for when those features are added.

### 21.1 Successful GET — single resource

```http
GET /api/v1/users/u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T HTTP/1.1
Accept: application/json
Authorization: Bearer <accessToken>
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
 "id": "u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T",
 "email": "ada@example.com",
 "displayName": "Ada Lovelace",
 "status": "active",
 "role": "user",
 "createdAt": "2026-01-15T09:30:00.000Z",
 "updatedAt": "2026-01-15T09:30:00.000Z"
}
```

### 21.2 Successful POST — resource created

```http
POST /api/v1/auth/register HTTP/1.1
Content-Type: application/json

{
 "email": "ada@example.com",
 "password": "correct horse battery staple",
 "displayName": "Ada Lovelace"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json
```

```json
{
 "id": "u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T",
 "email": "ada@example.com",
 "displayName": "Ada Lovelace",
 "status": "active",
 "role": "user",
 "createdAt": "2026-01-15T09:30:00.000Z",
 "updatedAt": "2026-01-15T09:30:00.000Z"
}
```

### 21.3 Successful PUT — partial update (frozen)

```http
PUT /api/v1/users/u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T HTTP/1.1
Content-Type: application/json

{
 "displayName": "Ada L.",
 "status": "active"
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
 "id": "u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T",
 "email": "ada@example.com",
 "displayName": "Ada L.",
 "status": "active",
 "role": "user",
 "createdAt": "2026-01-15T09:30:00.000Z",
 "updatedAt": "2026-01-15T10:00:00.000Z"
}
```

### 21.4 Successful PATCH — partial update

> **V1 Status:** PATCH endpoints are NOT implemented in V1. This example defines the contract for when they are added.

```http
PATCH /api/v1/users/u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T HTTP/1.1
Content-Type: application/merge-patch+json

{
 "displayName": "Ada L."
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
 "id": "u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T",
 "email": "ada@example.com",
 "displayName": "Ada L.",
 "status": "active",
 "role": "user",
 "createdAt": "2026-01-15T09:30:00.000Z",
 "updatedAt": "2026-01-15T10:00:00.000Z"
}
```

### 21.5 Successful DELETE

```http
DELETE /api/v1/users/u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T HTTP/1.1
Authorization: Bearer <accessToken>
```

```http
HTTP/1.1 204 No Content
```

(No body.)

### 21.6 Validation error

Validation failures return the canonical Problem Details body with code `VALIDATION_FAILED` (see §7.4). There is no `errors` array.

```http
POST /api/v1/auth/register HTTP/1.1
Content-Type: application/json

{
 "email": "not-an-email",
 "password": "short"
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
```

```json
{
 "type": "https://docs.oxyide.com/errors/validation-failed",
 "title": "Bad Request",
 "status": 400,
 "detail": "body must have required property 'password'",
 "code": "VALIDATION_FAILED",
 "instance": "/requests/req-1"
}
```

### 21.7 Authentication error

```http
GET /api/v1/users/u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T HTTP/1.1
```

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/problem+json
WWW-Authenticate: Bearer realm="oxyide", error="invalid_token"
```

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

### 21.8 Authorization error

```http
DELETE /api/v1/users/u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T HTTP/1.1
Authorization: Bearer <accessToken>
```

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json
```

```json
{
 "type": "https://docs.oxyide.com/errors/auth-forbidden",
 "title": "Forbidden",
 "status": 403,
 "detail": "You do not have permission to perform this action.",
 "code": "AUTH_FORBIDDEN",
 "instance": "/requests/req-1"
}
```

### 21.9 Not found

```http
GET /api/v1/users/u_01HX0000000000000000000000 HTTP/1.1
Authorization: Bearer <accessToken>
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json
```

```json
{
 "type": "https://docs.oxyide.com/errors/users-not-found",
 "title": "User not found.",
 "status": 404,
 "detail": "User not found.",
 "code": "USERS_NOT_FOUND",
 "instance": "/requests/req-1"
}
```

### 21.10 Conflict

```http
POST /api/v1/auth/register HTTP/1.1
Content-Type: application/json

{
 "email": "ada@example.com",
 "password": "correct horse battery staple",
 "displayName": "Ada Lovelace"
}
```

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
```

```json
{
 "type": "https://docs.oxyide.com/errors/users-email-taken",
 "title": "A user with this email already exists.",
 "status": 409,
 "detail": "A user with this email already exists.",
 "code": "USERS_EMAIL_TAKEN",
 "instance": "/requests/req-1"
}
```

### 21.11 Rate limit exceeded

> **V1 Status:** The 429 response is implemented for login throttling. The general rate-limit headers below are documented for future use.

```http
POST /api/v1/auth/login HTTP/1.1
Content-Type: application/json

{ "email": "ada@example.com", "password": "..." }
```

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
Retry-After: 42
RateLimit-Limit: 5
RateLimit-Remaining: 0
RateLimit-Reset: 42
```

```json
{
 "type": "https://docs.oxyide.com/errors/rate-limit-exceeded",
 "title": "Too Many Requests",
 "status": 429,
 "detail": "You have exceeded the rate limit. Retry after 42 seconds.",
 "code": "RATE_LIMIT_EXCEEDED",
 "instance": "/requests/req-1"
}
```

**Current:** Login throttling returns:

```json
{
 "type": "https://docs.oxyide.com/errors/auth-too-many-attempts",
 "title": "Too many login attempts. Please try again later.",
 "status": 429,
 "detail": "Too many login attempts. Please try again later.",
 "code": "AUTH_TOO_MANY_ATTEMPTS",
 "instance": "/requests/req-1"
}
```

No `Retry-After` or `RateLimit-*` headers (see `docs/auth.md` §Login Throttling).

### 21.12 Internal server error

> **V1 Status:** Implemented. The centralized error mapper (`src/shared/errors/error-mapper.ts`) classifies the failure and the single Problem Details serializer returns this exact sanitized body for unexpected server errors in every environment, logging the full error server-side only. See `docs/adr/005-global-error-handler.md`.

```http
GET /api/v1/users HTTP/1.1
Authorization: Bearer <accessToken>
```

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/problem+json
```

```json
{
 "type": "https://docs.oxyide.com/errors/internal-error",
 "title": "Internal Server Error",
 "status": 500,
 "detail": "An unexpected error occurred. Please try again later.",
 "code": "INTERNAL_ERROR",
 "instance": "/requests/req-1"
}
```

(The `detail` must not include stack traces, SQL, or ORM messages.)

### 21.13 Paginated response

> **V1 Status:** Pagination is NOT implemented. This example defines the contract for when pagination is added.

```http
GET /api/v1/users?pageSize=2&sort=createdAt:desc HTTP/1.1
Authorization: Bearer <accessToken>
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
 "items": [
 {
 "id": "u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T",
 "email": "ada@example.com",
 "displayName": "Ada Lovelace",
 "status": "active",
 "createdAt": "2026-01-15T09:30:00.000Z",
 "updatedAt": "2026-01-15T09:30:00.000Z"
 },
 {
 "id": "u_01HX9Z6Y7K8Q3V2N4M5P6R7S8U",
 "email": "grace@example.com",
 "displayName": "Grace Hopper",
 "status": "active",
 "createdAt": "2026-01-14T17:12:00.000Z",
 "updatedAt": "2026-01-14T17:12:00.000Z"
 }
 ],
 "pageInfo": {
 "hasMore": true,
 "nextCursor": "eyJpZCI6InVfMDFIWDlaNlk3SzhRM1YyTjRNNVA2UjdTOFUifQ",
 "prevCursor": null
 }
}
```

---

## 22. Consistency Rules

These rules are absolute and apply to every OXYIDE module.

1. Every in-pipeline error response uses `application/problem+json` with the shape in §7. (Only pre-pipeline router rejections keep framework-native bodies — a documented boundary.)
2. Every success response is a flat resource or a collection with `items` and `pageInfo`.
3. Every field is `camelCase`.
4. Every timestamp is ISO 8601 UTC with `Z`.
5. Every ID is an opaque prefixed string.
6. Every list endpoint enforces a maximum `pageSize` (**future**).
7. Every list endpoint returns the same `pageInfo` shape for its chosen mode (**future**).
8. Every sortable or filterable field is allowlisted (**future**).
9. Every protected route denies by default.
10. Every request carries the server-generated correlation ID, emitted as `X-Request-ID` and referenced by Problem Details `instance` (; never client-supplied values).
11. Every error code is namespaced and stable.
12. Every breaking change requires a new major version (§2.4).
13. No operation is deprecated unless its route declares deprecation metadata (§2.7).
14. A deprecated operation keeps serving traffic unchanged until its published sunset date (§2.9).

---

## Enforcement

- Route schemas enforce shape, content type, and status codes.
- OpenAPI generation and contract validation run as part of the test suite (§20.5).
- Integration tests cover each error example in §21.
- OpenAPI contract tests verify the published document against runtime responses (§20.5).
- The published OpenAPI document is derived from route schemas, so route-level
 deprecation metadata and the runtime deprecation headers cannot disagree (§2.7).
- PR review enforces rules not fully automatable.

## Precedence

1. `docs/architecture.md`
2. `docs/engineering-standards.md`
3. `docs/api-conventions.md` (this document)
4. Per-module READMEs

---

**End of API conventions.**
