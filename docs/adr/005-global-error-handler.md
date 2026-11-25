# ADR 005: V1 Global Error Handler (500 Sanitization)

> **Status:** Accepted
> **Date:** 2026-09-21
> **Decision makers:** Engineering
> **Supersedes:** None

## Context

The Step 9 Production Readiness audit identified a MEDIUM production blocker
(F-01): Fastify had no global error handler, so unexpected server-side
failures were serialized by Fastify's default error handler. That default
handler includes `error.message` in the 500 response body, which leaked raw
internal details to clients, including in `NODE_ENV=production`.

Empirically verified leaks:

- `Error("RAW_SECRET host=127.0.0.1:5999")` appeared verbatim in the 500 body.
- Prisma connection failures exposed `Can't reach database server at 127.0.0.1:5999`.

This violates `docs/api-conventions.md` §7.5 ("Error responses never contain
stack traces, SQL, ORM messages, or file paths"), §21.12 (the documented 500
shape), and `docs/architecture.md` §14 ("Never expose raw Prisma or Fastify
errors").

## Decision

V1 includes a **minimal Fastify global error handler**
(`app.setErrorHandler`), registered in `src/app/app.ts`, as a mandatory
security boundary.

The handler:

1. **Known/domain errors (`AppError`):** preserve the existing V1 RFC 7807
 shape (`type`, `title`, `status`, `detail`, `code`) and status codes.
2. **Other client errors (`statusCode < 500`):** delegate to Fastify's
 built-in handling by calling `reply.send(error)` so the documented V1
 behavior is unchanged (validation `400`, malformed JSON `400`,
 unsupported media type `415`, etc.).
3. **Unexpected server errors (`statusCode >= 500`):** log the complete error
 server-side via the existing Pino logger (`request.log.error`), then return
 the generic, sanitized body documented in `docs/api-conventions.md` §21.12:

 ```json
 {
 "type": "https://docs.oxyide.com/errors/internal-error",
 "title": "Internal Server Error",
 "status": 500,
 "detail": "An unexpected error occurred. Please try again later.",
 "code": "INTERNAL_ERROR"
 }
 ```

The raw `error.message`, stack traces, Prisma internals, database hosts/ports,
filesystem paths, and configuration values are never sent to clients.

## Scope

- Generic 500 sanitization and server-side logging only.
- Registered once during application construction, before routes.

## Non-goals

This decision does **not** implement the broader deferred error-handling
architecture. The following remain V2/deferred per `docs/architecture.md` §14:

- The centralized error mapper (`src/shared/errors/error-mapper.ts`).
- The centralized problem-details formatter (`src/shared/errors/problem-details.ts`).
- A dedicated error-handler plugin (`src/plugins/error-handler.plugin.ts`).
- Request IDs, advanced error taxonomy, observability/error tracking, and any
 Problem Details infrastructure beyond the existing V1 shape.

The minimal `setErrorHandler` is a security control, not the error-mapper
architecture. Implementing it does not promote or pre-empt the deferred items.

## Consequences

### Positive

- Raw internal errors can no longer reach clients in any environment.
- Existing 4xx/`AppError` contracts and the documented V1 error shape are
 preserved without change.
- No new dependency is introduced.

### Negative

- One additional, small piece of error-handling logic lives in `src/app/app.ts`
 until the V2 error mapper supersedes it.

### Risks

- If the deferred V2 error mapper is later implemented, this handler must be
 reconciled with (or replaced by) it. The V2 work should treat this ADR as the
 prior art to absorb.

## Related

- `docs/api-conventions.md` §7.5, §7.4, §21.12
- `docs/architecture.md` §14
- `src/app/app.ts` (`registerGlobalErrorHandler`)
- `src/app/error-handler.test.ts`