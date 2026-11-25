# ADR 013: API Documentation Generation (OpenAPI + Swagger UI)

> **Status:** Accepted
> **Date:** 2026-10-03
> **Decision makers:** Engineering
> **Supersedes:** None
> **Milestone:**

## Context

The API had machine-readable request contracts (route schemas) and explicit
response contracts but no published description of itself.
`docs/api-conventions.md` §20 defined the intended contract — route schemas
as the source of truth, a plugin at `src/plugins/swagger.plugin.ts`, no
`src/docs` directory, and production-gated Swagger UI — but nothing was
implemented.

Two constraints shaped the decision:

1. **No second API definition.** A hand-written OpenAPI document would drift
 from the schemas the runtime actually validates. The failure mode is
 silent: the document keeps describing behaviour the server no longer has.
2. **is frozen.** `docs/error-handling.md` and `docs/api-conventions.md`
 §7 own the Problem Details contract and the status policy. Error
 documentation must describe that contract without touching how errors are
 produced, mapped, or serialized.

A third constraint is subtler: Fastify `response:` maps are keyed by status
code and are compiled into response serializers. Declaring `400`/`401`/… in a
route `response:` would place error statuses into the serialization path that
owns, which is precisely the boundary already declined to cross.

## Decision

1. **Generate from the runtime, document the edges separately.**

 `@fastify/swagger` runs in dynamic mode. Success request and response
 bodies are read from the existing route schemas — never re-declared for
 documentation. The only hand-written document content is what JSON Schema
 cannot express: `info`/`tags`/`servers`/`components`, per-route descriptive
 metadata (`summary`, `description`, `operationId`, `tags`, `security`),
 and error/204 responses.

2. **Errors are merged document-side.**

 The plugin's per-route `transform` hook (keyed by `operationId`) merges an
 operationId→error-status table that references a single
 `#/components/schemas/ProblemDetails` component, and synthesizes bodyless
 `204` contracts for routes that intentionally declare no response schema.
 A `transformObject` hook strips any `content` block from `204` responses,
 so a body can never be claimed for a bodyless status regardless of what a
 future route edit declares. Transform output is consumed only by
 `app.swagger`; it is never compiled as a serializer.

3. **Swagger UI is a presentation layer, never a second contract.**

 `@fastify/swagger-ui` renders the same `app.swagger` source that
 `/openapi.json` serves. One definition, two URLs.

4. **Two independent, validated flags with one dependency rule.**

 `OPENAPI_ENABLED` (default `true`) controls generation and
 `/openapi.json`. `SWAGGER_UI_ENABLED` (default `true` except production)
 controls `/docs`. Both are strict `true`/`false` literals validated in
 `src/config/env.schema.ts` and consumed as frozen booleans via
 `config.docs`. Requesting the UI while the document is disabled is
 **rejected at startup** rather than silently enabling generation: the UI is
 not an independent capability, so the request is a contradiction.

5. **Documentation routes are infrastructure.**

 `/openapi.json` and `/docs` sit outside `/api/v1`, alongside `/health/*`.

## Alternatives considered

- **Hand-written OpenAPI document.** Rejected: guarantees drift and a second
 contract to maintain.
- **Declare error responses in route `response:` schemas.** Rejected: enters
 the frozen serialization path; would couple documentation to a boundary
 owns and deliberately left alone.
- **Custom JSON-Schema-to-OpenAPI compiler in shared code.** Rejected:
 re-implements an official, maintained Fastify plugin and adds a maintenance
 surface for zero additional accuracy.
- **Serve Swagger UI without OpenAPI enabled** (UI reads a static file).
 Rejected: reintroduces a second definition and contradicts the "one
 runtime contract" rule.
- **Authenticating `/docs`.** Deferred: the architecture has no documented
 mechanism for protecting documentation routes, and configurable exposure
 satisfies the requirement. Revisit with /.

## Consequences

- New runtime dependencies: `@fastify/swagger@9.9.1`, `@fastify/swagger-ui@6.1.1`
 (official Fastify-org packages, MIT, Fastify 5 compatible).
- The document cannot drift for request/response bodies; it can only drift for
 the error table and descriptive metadata, both of which are co-located with
 the route (or, for errors, one reviewable table in the plugin).
- Operators choose exposure explicitly; nothing documentation-related is
 exposed unconditionally.
- Every new route must carry descriptive metadata to remain documented. That
 is a cost, and the intended forcing function: it is also the point of §20.3.