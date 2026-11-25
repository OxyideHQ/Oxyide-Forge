# Oxyide Forge — Reference Module: Notes

> **Status:** permanent teaching reference. `src/modules/notes/` is the module a new developer studies first; `src/modules/auth/` is the secondary reference for scale patterns (nested services, cross-service orchestration, transaction threading).
> **Rule:** this document describes the module — it never duplicates its source. Paths are exact; behavior claims name the test that proves them.

## 1. What the example demonstrates

One user-owned resource (`Note`) exercised end to end: strict AJV request/response schemas, bearer authentication, owner-only authorization, service orchestration, Prisma persistence, public-response mapping, six-field Problem Details errors, offset pagination with allowlisted sorting and filtering, and OpenAPI generation — in ~430 production lines across 5 files.

## 2. Why this domain was selected

Notes were chosen in because the domain is understandable with zero business context, needs no external provider, job, cache, or email, and still forces every decision a real module faces: who owns a row, who may read it, what a client may send, and what the wire may return. A `tasks`-style alternative was evaluated in and rejected: same shape (title, enum status, ownership, CRUD, list), zero new pattern coverage, and a second example module is explicitly forbidden — it would duplicate notes while churning a migration, five endpoints, and the frozen contract tables for nothing.

## 3. Directory structure

```text
src/modules/notes/
├── routes/note.routes.ts # 5 endpoints, schemas, guards, thin handlers
├── notes.service.ts # use cases: list/getById/create/update/remove
├── note.repository.ts # the ONLY Prisma touch for Note
├── note-response.ts # PublicNote + toPublicNote + JSON Schemas
├── note.types.ts # Note (persistence shape) + Create/Update inputs
└── routes/note.routes.integration.test.ts # HTTP + DB + ownership matrix
```

File noun follows the module directory (`notes/` → `notes.service.ts`); small modules keep layers flat. Wiring: `registerNoteRoutes` + one `app.register(...)` line in `src/app/routes.ts` — unregistered files never serve (pinned by `scripts/project-structure.test.ts`).

## 4. Request flow

`POST /api/v1/notes` with a valid bearer token: Fastify validates the body against `createNoteSchema` (unknown fields 400) → `preHandler: [requireAuth]` attaches `request.auth` → handler calls `notesService.create(authContext, body)` → service spreads the client input with server-derived `id: randomUUID` and `userId: actor.sub` → `notesRepository.create` → single Prisma client → PostgreSQL → `toPublicNote` strips internals → `201` + `Location: /api/v1/notes/<id>` through the declared response schema (undeclared fields stripped even if a service change attached them).

## 5. Route responsibilities

Routes own HTTP only: schema binding (`params`/`querystring`/`body`/`response`, all `additionalProperties: false`), `tags`/`summary`/`description`/`operationId`/`security` metadata, guard invocation, status codes, and the `Location` header on creation. They never query, never decide access, never touch Prisma (ARCH-ENF-013 fails the build otherwise). List composes exactly one reusable fragment the primitive (`paginationQueryProperties`, `sortQueryProperties`, `filterPatternProperties`).

## 6. Service responsibilities

Use cases and nothing else: parse list intents (`parsePagination`/`parseSort`/`parseFilter` with endpoint-owned allowlists), check `notePolicy` **after** the existence check (missing → 404 even for foreign ids, then foreign → 403 — existence is never disclosed to non-owners), map to the public shape, throw `AppError`. No Fastify objects, no Prisma, no transactions here (single-row operations need none). Cross-user writes are structurally impossible: `actor.sub` is the only owner id in the building.

## 7. Repository responsibilities

Flat Prisma queries with an explicit `noteSelect` allowlist and a mandatory owner predicate on every method; `list` runs data + count under one shared `where`. No HTTP, no policy, no `$transaction` (ENF-002 reserves transactions for services), no Prisma error leakage — unexpected failures propagate to the frozen mapper, which is the correct behavior for an infrastructure outage.

## 8. Authorization and ownership

`notePolicy.canAccessNote` in `src/modules/authorization/policies/` (policies live in the authorization module, never in the consuming module): strict string equality of `actor.sub` to the row's `userId`, fail-closed on any non-identity input. No admin override, no sharing model — deliberately the simplest meaningful policy. Guards authenticate (`requireAuth` on all five routes); the policy authorizes. Regression: the integration suite's BOLA matrix (own/foreign/missing × read/update/delete) plus hostile filter keys (`?userId=`, `ownerId`, relation paths → 400).

## 9. Validation

Route schemas reject unknown fields, overlong titles (>200), overlong descriptions (>2000), and off-enum statuses before any service code runs; malformed JSON → 400, oversized bodies → 413, wrong media type → 415 via the frozen pipeline. Service-level parsing (`parsePagination` etc.) rejects hostile query keys with static non-reflecting 400s. No Zod in the module, no validation duplicated between route and service — each layer validates what it owns.

## 10. Error handling

Two domain errors only: `NOTES_NOT_FOUND` (404, every absence including post-policy races) and `AUTH_FORBIDDEN` (403, generic detail — denial reasons stay operator-side per the frozen policy). Validation failures flow through `VALIDATION_FAILED`; infrastructure failures become sanitized 500s. No 409 exists because the domain has no unique constraint to conflict on — invented errors are forbidden. Prisma errors never reach the wire.

## 11. Tests

`routes/note.routes.integration.test.ts` (DB-gated, refuses `NODE_ENV=production`): request validation, authentication, full BOLA matrix, CRUD + 404/repeat-delete, pagination, sorting, filtering, hostile injection keys, response contract. Unit-level policy/mapper behavior is covered where it lives. What the tests teach: ownership is proven at the HTTP boundary against real PostgreSQL, not mocked — a policy unit test alone cannot prove the route calls it.

## 12. How to use this module as a template

1. Copy the five-file shape with your noun; keep layers flat until the module earns nesting (auth-scale).
2. Write the response mapper first — it fixes the wire contract everything else serves.
3. Derive ownership from `AuthContext`; add your policy next to `notePolicy`, not inside your module.
4. Declare route schemas with `additionalProperties: false`; add the operation to `OPERATION_ERRORS` and the frozen OpenAPI tables deliberately.
5. Register in `src/app/routes.ts`; run `npm run check`, then the module tests, then `npm test`.

## 13. What NOT to copy blindly

- Owner-only policy is the *simplest* policy, not the *only* one — shared resources need a real policy review, not a wider equality check.
- No transactions here because none are needed; multi-write use cases must follow the auth/users transaction-threading pattern instead.
- `User 1:N Note` cascade delete is a product decision for an example; real domains must choose their own delete semantics deliberately.
- The status enum (`active`/`archived`) is illustrative; an enum without a consumer is speculation.
