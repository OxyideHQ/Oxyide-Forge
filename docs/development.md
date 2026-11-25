# Oxyide Forge — Development Guide

> **Status:** current developer entry point. The implementation is authoritative on any conflict: `src/config/env.schema.ts` for environment variables, `package.json` for commands, `prisma/migrations/` for schema history, `docs/architecture.md` for boundaries.
> **Audience:** a developer starting from a fresh checkout who wants to run, understand, test, and extend Forge as the foundation of their own backend.

This guide covers the first 30–60 minutes: what Forge is, how to start it, the daily loop, where new code belongs, and what to do when something breaks. Normative contracts (API shapes, error format, auth behavior, logging policy) live in their owning documents — this guide points at them, never duplicates them.

---

## 1. What Forge is (and is not)

Forge is a **production-oriented TypeScript backend foundation**: Fastify 5, PostgreSQL 17 + Prisma 6, JWT authentication with persistent sessions, RBAC authorization, a frozen Problem Details error system, a versioned `/api/v1` REST contract with generated OpenAPI 3.1, validated pagination/sorting/filtering primitives, structured logging with redaction, health probes, an automated 16-rule architecture checker, CI plus release gates, and a frozen email subsystem (provider boundary, SMTP transport, typed templates).

Forge is **not an application**. It ships no business domain of its own — except `src/modules/notes/`, a deliberately tiny user-owned CRUD module whose only job is to show the correct layering. Your product code belongs in **new modules you create**, following the notes pattern. Do not build your domain inside `auth`, `users`, or `notes`.

Forge also deliberately does **not** provide: queues/workers, durable email delivery (outbox/retry), CSRF, MFA, distributed rate limiting, production observability backends, deployment automation, marketing email, localization, or a template CMS. The README's deferred list is the complete inventory — if it is not there and not in the tree, it does not exist.

---

## 2. Requirements

| Requirement | Version | Notes |
|---|---|---|
| Node.js | >= 20.19.0 | 20.19 is the floor for the `--env-file` support `npm run dev` relies on |
| npm | 10.x+ | Lockfile is `package-lock.json`; always install with `npm ci` |
| PostgreSQL | 17+ | Required — the application and most tests do not run without it |
| Redis | 7+ | Optional — the application starts and fully functions without it |
| gitleaks | >= 8.30 | Only for `npm run security:secrets` |

---

## 3. First run (fresh checkout to healthy API)

> Shell-specific setup (Windows PowerShell / Command Prompt / macOS / Linux),
> ZIP extraction, and PostgreSQL provisioning live in the canonical
> [Installation](installation.md) guide — follow it first, then return here for
> the daily loop. The commands below are the Unix form of the same steps.

```bash
git clone <repository-url> my-backend
cd my-backend
npm ci # reproducible install from the lockfile

cp .env.example .env # then set DATABASE_URL and JWT_SECRET (see §4)
npx prisma generate # build the Prisma client from prisma/schema.prisma
npx prisma migrate deploy # apply the 10 committed migrations
npm run dev # start with file watching; loads .env automatically
```

Then verify health (see §6):

```bash
curl http://localhost:3000/health/live # 200 {} — the process is alive
curl http://localhost:3000/health/ready # 200 {} — PostgreSQL reachable; 503 {} when it is not
```

PostgreSQL options: point `DATABASE_URL` at an existing server, or start the bundled one with `docker compose up -d postgres` (requires `POSTGRES_PASSWORD` in the environment; see `docker-compose.yml`). The compose file is a **local verification stack**, not a production orchestrator — production database ownership is yours (see `docs/deployment.md`).

Seed data: there is none to load. `npm run db:seed` exists as the idempotent entry point future reference-data operations plug into, but the current schema defines no baseline seed data, so it inserts nothing. Application startup **never** seeds — production startup must not silently seed the database (rule, enforced by design).

---

## 4. Environment configuration

Centralized and validated at startup: `src/config/index.ts` is the **sole** production consumer of `process.env`; `src/config/env.schema.ts` is the validation authority. A missing or invalid variable fails startup immediately with a named error — never a silent default (except where a default is documented below).

### Required (no defaults — startup fails without them)

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://user:pass@localhost:5432/myapp` | Must use `postgresql://` or `postgres://`. Production requires `?sslmode=require` |
| `JWT_SECRET` | output of `openssl rand -base64 32` | Minimum 32 characters; HS256 signing secret |

### Optional (each has a documented default or a defined absence)

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production`. Production enables the strictest gates (HTTPS base URL, DB `sslmode=require`, Secure cookies, Swagger UI off) |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Bind address and port |
| `LOG_LEVEL` | `info` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` |
| `REDIS_URL` | *(unset = no Redis)* | `redis://` or `rediss://`. **Never set it to an empty string**: `REDIS_URL=""` is a configuration *error*, not "disabled" |
| `APP_BASE_URL` | `http://localhost:3000` | Public base URL for absolute links (password-recovery links) and the OpenAPI `servers` entry. Production requires `https://`. Never derived from request headers |
| `CORS_ALLOWED_ORIGINS` | *(unset = CORS fully disabled)* | Comma-separated bare `http(s)://host[:port]` origins, exact match, no wildcards |
| `OPENAPI_ENABLED` / `SWAGGER_UI_ENABLED` | `true` / `true` (except `false` in production) | Strict `true`/`false` literals only. UI without the document is rejected at startup |
| `METRICS_ENABLED` | `false` | Opt-in Prometheus-compatible exporter at `GET /metrics`. Off by default (NoOp metrics); when `true`, the app records bounded HTTP request/error/duration metrics (labels: `method`, route‑template, `status` only — never raw URLs, IDs, emails, IPs, tokens, or query strings) and serves the Prometheus text exposition format |

### Conditional (required only when their feature is enabled)

| Variable | Required when | Notes |
|---|---|---|
| `SMTP_HOST` | any `SMTP_*` is set | Mail server hostname or IP. Presence means "SMTP configured"; any other `SMTP_*` without it rejects |
| `SMTP_PORT` | `SMTP_HOST` is set | TCP port 1–65535. No assumed 587 — omitting it rejects |
| `SMTP_SECURITY` | `SMTP_HOST` is set | `smtps` (implicit TLS) \| `starttls` (STARTTLS required, never opportunistic) \| `plaintext` (development relays only). No default — the posture must be explicit |
| `SMTP_USER` / `SMTP_PASSWORD` | each other | Authentication pair: both or neither. Passwords are **not** trimmed (surrounding spaces are valid in secrets). Credentials with `plaintext` reject |

All five unset = NoOp email: authentication flows run normally with no email leaving the process. Partial groups never construct a broken provider — they fail startup with a named error instead.

### How configuration works (read this before adding a variable)

- **Validated once, at import time.** `src/config/env.schema.ts` (Zod) parses a single `rawEnv` literal in `src/config/index.ts`; an invalid value throws before the server listens. Application code imports the typed `config` object — never `process.env`.
- **Immutable.** The parsed config is recursively frozen (`Object.freeze` at every level); reassignment throws. Tests pin this — do not replace it with a mutable singleton.
- **Sole-reader rule.** `src/config/` is the only production code allowed to read `process.env` (enforced by ARCH-ENF-004, which fails the build otherwise). Test files and `scripts/` tooling may read their own tool-only inputs, which are never application configuration.
- **Startup errors are secret-safe.** Validation failures name the variable and the expected shape, never the value: secrets, passwords, and `DATABASE_URL` contents are asserted absent from serialized failures (see `configuration secret safety` in `src/config/index.test.ts`).
- **Secrets.** `DATABASE_URL` credentials, `JWT_SECRET`, and `SMTP_PASSWORD` come from the deployment environment in production. Never commit them, never put real ones in `.env.example` (placeholders only — machine-checked), never log them, never expose them through an API.

### Adding a new environment variable

Follow the existing pattern exactly — no new mechanism:

1. Add the field to `envSchema` in `src/config/env.schema.ts` (validation, defaults, production gates, coherence with related variables).
2. Read it in the `rawEnv` literal in `src/config/index.ts` — every validated variable is read in exactly that one place — and map it onto the typed `AppConfig` in `src/config/types.ts`.
3. Add a safe representation to `.env.example` if a developer needs to set it (commented `Example:` lines for optional/conditional vars; the schema↔example consistency test fails until you do).
4. Add tests in `src/config/index.test.ts`: valid values, each invalid shape, production behavior, and secret-echo absence for secret-bearing values.
5. Update this section and `docs/deployment.md` if the variable affects operators.
6. Search the repo for stale references to the area you touched.
7. Run the config tests, then the full validation (`npm run typecheck`, `lint`, `architecture:check`, `test`, `build`).

Rules that bite newcomers: `.env` is for local development only — `npm run dev` loads it, `npm start` (production) reads the process environment and ignores it; values already in the environment win over `.env`; never commit `.env` (gitignored; release validation rejects it if shipped); `DATABASE_URL` tuning (`connection_limit`, `pool_timeout`, `connect_timeout`, `sslmode`) travels as URL query parameters, not separate variables (see `.env.example`).

---

## 5. Repository structure (the real tree)

```text
src/
├── main.ts — Bootstrap: builds the app, starts the server, exits non-zero on fatal error
├── app/ — Fastify factory (app.ts), server lifecycle (server.ts), route registration (routes.ts)
├── modules/ — Domain modules; each owns its routes, services, repositories, and types
│ ├── auth/ — Registration, login, refresh, logout, password reset, email verification, lockout
│ │ └── email/ — Auth email adapters + composition (domain request → template data; the ONLY transport selection point)
│ ├── authorization/ — RBAC: permissions, roles, guards (requireAuth/requirePermission/requireRole), policies
│ ├── users/ — User domain (self-scoped CRUD)
│ ├── roles/ — Role listing and detail (read-only in V1)
│ ├── notes/ — Canonical example module: copy this structure for new features
│ └── health/ — Liveness (/health/live) and readiness (/health/ready) probes
├── shared/ — Dependency-light cross-cutting code. MUST NOT import business modules
│ ├── errors/ — AppError, ErrorCodes, the single error mapper
│ ├── email/ — EmailProvider contract, NoOp provider, templates/ (registry, templates, layout, escaping)
│ ├── pagination|sorting|filtering/ — Validated list-query primitives (lexical gate + semantic normalizer)
│ └── logging|tracing|metrics/ — Logger options/redaction, NoOp tracer, fixed metrics facade
├── platform/ — Infrastructure implementations. MUST NOT import business modules
│ ├── database/ — The single Prisma client (+ transaction helper)
│ ├── cache/ — Redis client + CacheService (optional; absent when REDIS_URL is unset)
│ └── email/ — SMTP transport (the ONLY importer of nodemailer)
├── plugins/ — Cross-cutting Fastify plugins (auth, cookie, cors, redis, telemetry, swagger, …)
├── config/ — env.schema.ts (Zod validation) + index.ts (sole process.env reader) + types.ts
└── types/ — Fastify augmentation, AuthContext contract, shutdown-phase contract

prisma/ — schema.prisma (desired state) + migrations/ (deployment source of truth, 10 files)
scripts/ — architecture-check, security-scan, sbom-validate, release-validate, verify-deployment, db-backup
docs/ — architecture.md, api-conventions.md, auth.md, deployment.md, … (this guide is the index for humans)
```

The request path through the system:

```text
HTTP / routes → guards / policies → services → repositories → PostgreSQL / Prisma
```

Boundaries that are machine-checked (`npm run architecture:check`, 16 rules — not conventions, failing builds):

- **Routes declare and delegate.** They validate input via schemas, enforce auth via guards, and call services. They never touch repositories or Prisma.
- **Services own composition and transactions.** `$transaction` lives in services only; repositories never open one.
- **Repositories own persistence.** One Prisma client exists (`src/platform/database/prisma.ts`); modules never import each other's repositories.
- **`shared` and `platform` never import business modules.** `shared` stays dependency-light so any module can use it; `platform` holds provider implementations; `src/config` is the only production reader of `process.env`; production code never calls `console.*`.
- **Repositories are module-private; services are the cross-module contract.** A module may import another module's *service* (precedent: `users.service` calls auth services), but never another module's *repository* (ARCH-ENF-001 fails the build). Authorization policies live in `src/modules/authorization/policies/` — never inside the consuming module — and services call them; `requireAuth`/`requirePermission`/`requireRole` guards run as route `preHandler`s.
- **Services may open transactions; repositories never do.** A service orchestrates atomicity with `prisma.$transaction` on the shared client and threads the client into repositories (ARCH-ENF-002); a repository performs flat queries only.

### Request flow (notes example: `POST /api/v1/notes`)

```text
HTTP request
 ↓ Fastify parses + validates body against the route schema (unknown fields 400)
main.ts → app.ts → plugins (security headers, swagger, request-id, telemetry, cors, cookie, auth, redis)
 ↓ route match in src/app/routes.ts → registerNoteRoutes
route handler (note.routes.ts) — preHandler: [requireAuth] → request.auth (AuthContext)
 ↓ notesService.create(authContext, body)
service (notes.service.ts) — parses list/query intents, checks notePolicy, maps to public shape, throws AppError
 ↓ notesRepository.create(ownerId, input) — owner predicate applied, explicit select allowlist
repository (note.repository.ts) — the ONLY Prisma touch for Note
 ↓ platform/database/prisma.ts (single client) → PostgreSQL
reply 201 + Location ← serialized through the route response schema (undeclared fields stripped)
```

Cross-cutting, on every request whether the handler succeeds or throws: request ID (`request.id`, echoed as `X-Request-ID`), structured completion logging with redaction, and — on failure — the single error mapper producing the Problem Details envelope. Not every request touches every layer: health probes hit no service/repository, and 204/register flows differ only in which service runs. The authoritative layer diagram is `docs/architecture.md` §6; the dependency rules are §9.

### Where should this go?

| I need to... | Put it in... | Do NOT put it in... |
|---|---|---|
| Add an HTTP endpoint | module `routes/*.routes.ts`, registered in `src/app/routes.ts` | a plugin, a service, or an unregistered file (unregistered routes never serve) |
| Implement a business use case | module service (`*.service.ts`) | the route handler, or another module's service file |
| Query PostgreSQL | module repository (`*.repository.ts`) | routes (ENF-013), services except via `$transaction` boundary (ENF-002), another module's repository (ENF-001) |
| Validate request/response shape | route schemas + one `*-response.ts` mapper per module | a second mapper (twin mappers drift) |
| Decide allow/deny for an actor | `src/modules/authorization/policies/` + guards as route `preHandler` | the repository (ENF-012), the route body, client-supplied data |
| Share domain-neutral logic | `src/shared/` (must import nothing from `src/modules`) | `src/platform/` (that's for provider implementations) |
| Integrate an external provider | `src/platform/` behind a `src/shared/` contract | a module (would couple every consumer to the vendor) |
| Add Fastify-wide behavior | `src/plugins/` | per-route hooks duplicated across modules |
| Add an environment variable | `src/config/` via the §4 recipe | `process.env` anywhere else (ENF-004) |
| Add a cross-module type | `src/types/` (must stay a dependency leaf) | `src/shared/` if it would pull module imports with it |

---

## 6. Daily development loop

Fast checks first, broad gates before commit. Two composites encode the two loops — use them instead of memorizing sequences:

```bash
npx vitest run src/modules/notes/ # focused tests for the area you touched
npm run check # fast pre-commit trio: typecheck + lint + architecture:check
npm test # full suite (needs PostgreSQL; serial by design — never run two DB-backed runners at once)
npm run validate # full local release validation (see below)
```

Pre-commit checklist: focused tests + `npm run check` green; broader regression (`npm test`) green for anything touching services, routes, or shared code; `git diff` reviewed and scoped (touch only what the task requires); no secrets, no `.env`, no debug logging in the diff. Run `npm run format` before committing if you touched formatting by hand — Prettier (single quotes, semicolons, trailing commas, width 100) is the enforced style.

### Test workflow

| Situation | Command |
|---|---|
| Active development, rerun on save | `npm run test:watch` |
| One file or directory | `npx vitest run src/modules/notes/` (any path or substring filter) |
| One test by name | `npx vitest run src/modules/notes/ -t "creates a note"` |
| Full suite (release truth) | `npm test` — serial by design (`fileParallelism: false`); needs PostgreSQL |

Test configuration is frozen: do not remove skipped tests, do not add coverage thresholds, and do not parallelize DB-backed suites to save wall-clock time — shared-table truncation makes concurrent runners contaminate each other (recorded lesson).

### Release validation (`npm run validate`)

One command runs the same gates CI runs, in dependency order — each step must pass before the next starts (`&&` chaining, failures propagate):

1. `npm run security:all` — production dependency audit (must be 0) + secret scan + SAST + typecheck + lint + full tests + build + architecture check. Despite the name it is the bulk of release validation, not just security checks.
2. `npx prisma migrate status` — applied migrations match `prisma/migrations/` (needs `DATABASE_URL`).
3. `npm run security:sbom` — generate + validate the CycloneDX SBOM (`sbom.cyclonedx.json`, gitignored).
4. `npm run release:check` — release readiness: contents, version, SBOM, evidence file.
5. `npm run verify:deployment` — 47 deployment-lifecycle checks (needs a built app and environment; live checks skip gracefully without `DATABASE_URL`).

Run `validate` before tagging, shipping, or opening a release PR — never after every small edit. It needs PostgreSQL and takes minutes; the fast loop above is the per-edit workflow.

### Command matrix

One table for the whole local workflow. Commands are real (`package.json`, verified by `scripts/developer-commands.test.ts`); "Needs PostgreSQL" means the command fails or degrades without a reachable database.

| Task | Command / action | Needs PostgreSQL | Typical use |
|---|---|---|---|
| Install | `npm ci` | No | First setup |
| Configure | copy `.env.example` → `.env`, set `DATABASE_URL` + `JWT_SECRET` | No | First setup |
| Check migration status | `npx prisma migrate status` | Yes | Database setup, pre-ship |
| Apply migrations | `npx prisma migrate deploy` | Yes | First setup, onboarding a fresh database |
| Start app | `npm run dev` | Degraded without (boots, `/health/ready` 503s) | Daily |
| Stop app | `Ctrl+C` in the dev terminal (SIGINT/SIGTERM drain gracefully) | — | Daily |
| Live check (process alive?) | `curl …/health/live` | No | Startup |
| Ready check (can it serve?) | `curl …/health/ready` | Yes | Startup |
| Smoke test a running instance | `SMOKE_TARGET_URL=… npm run smoke` (probes `/health/live` + `/health/ready`) | No (HTTP only) | POST-deploy operational check |
| Scrape metrics (when `METRICS_ENABLED=true`) | `curl …/metrics` | No | Production monitoring |
| API surface | `curl …/openapi.json` or `/docs` (Try-it-out bodies come prefilled with runnable examples) | No | Exploration |
| Focused tests | `npx vitest run <path>` / `-t "<name>"` | Depends (unit: no; integration: yes) | Development |
| Coverage report | `npm run test:coverage` | Yes, effectively | Reviewing test reach |
| Fast gate | `npm run check` | No | Per-edit, and automatically on every `git commit` |
| Full tests | `npm test` | Yes, effectively | Broad change |
| Full validation | `npm run validate` | Yes | Pre-ship |

Other release-grade commands (run before tagging or shipping, identical to CI): `npm run build` is included in `security:all`; `npm audit --omit=dev` must be 0. CI (`.github/workflows/ci.yml`) runs every gate with a live PostgreSQL service on PRs and main; releases re-run all gates plus packaging and publication.

### Pre-commit hook

`git commit` automatically runs `npm run check` — typecheck, then lint, then architecture check. It is [Husky](https://typicode.github.io/husky/) managed: the hook itself is the one-line file `.husky/pre-commit`.

- **What it runs:** the same `check` script you run by hand. No new commands, no duplicated gate logic.
- **What it deliberately does not run:** the test suite, the production build, migrations, or anything needing the network. The hook stays fast (~40s) and usable without PostgreSQL; run `npm test` yourself before you push.
- **Failure is loud and stops the commit.** `check` chains its three gates with `&&`, so a failure in one prevents the next from running and returns non-zero, so `git commit` aborts with the offending gate's output.
- **Enabling it.** Husky is installed by onboarding (`npm run setup`, or `bash setup.sh` on Unix — same implementation), which runs `npx husky` for you. If you set the repository up some other way, run `npx husky` once yourself. Forge deliberately does **not** install it from an npm `prepare` lifecycle script — `scripts/deployment-workflow.test.ts` forbids every `pre*`/`post*`/`prepare`/`install` hook, because those are how startup behavior sneaks back in invisibly.
- **In a ZIP with no `.git`:** there are no hooks to install. Setup prints a note and continues; nothing fails.
- **Bypassing is a deliberate act.** `git commit --no-verify` skips the hook. Use it only when you know why; CI runs every gate regardless.

### Test coverage

`npm run test:coverage` runs the full suite and writes a report to `coverage/` (text summary on the terminal, plus `coverage/lcov.info` for tooling and `coverage/coverage-report/` for browsing). `coverage/` is git-ignored.

**Coverage is informational only. There is no minimum threshold, and no percentage can fail the command or CI.** It is a visibility aid for finding untested code, not a quality gate — a coverage number is not a statement about code quality. Adding a threshold later would be a separate, deliberate decision.

Only first-party code under `src/` is measured. Excluded: test files, `src/types/` (type declarations with no runtime statements), build output, and dependencies.

### Operational metrics and smoke checks

- **Prometheus metrics** — set `METRICS_ENABLED=true` and scrape `GET /metrics` (text exposition v0.0.4). It exposes three bounded HTTP instruments: `forge_http_requests_total`, `forge_http_errors_total`, and `forge_http_request_duration_seconds` (histogram). Label set is fixed to `method`, the Fastify **route template** (for example `/api/v1/users/:id`, never the raw id), and `status` — so cardinality is bounded by your route count and no user data, token, or query string is ever exported. When the flag is off (default), no route is registered and nothing is collected. Configure the collector with a standard Prometheus `scrape_config` on `/metrics`; keep it disabled if you run metrics externally.
- **Operational smoke test** — `npm run smoke -- --url <base-url>` (or `SMOKE_TARGET_URL=<base-url> npm run smoke`) probes `/health/live` and `/health/ready` over HTTP only. Exit 0 = healthy, 1 = an endpoint unhealthy/timed out, 2 = bad configuration. It needs no database or credentials, uses a bounded timeout (`SMOKE_TIMEOUT_MS`, default 5000), and is the post-deploy "is this instance serving?" check. It is read-only and distinct from `npm run verify:deployment`, which boots the app locally against a database and drives the full lifecycle.

---

## 7. Database workflow

Migration files under `prisma/migrations/` are the deployment source of truth; the application never runs migrations automatically and startup never seeds. The full lifecycle (creation, review, drift, failure handling) lives in `docs/migrations.md` — this is the daily-use subset:

| Situation | Command | Notes |
|---|---|---|
| First-time local setup | `npx prisma migrate deploy` | Applies the 10 committed migrations to an empty database |
| Verify parity | `npx prisma migrate status` | Fails loudly on drift or pending migrations; also a step of `npm run validate` |
| Schema change (development) | `npx prisma migrate dev --name <name>` | Creates **and** applies a migration locally; review the generated SQL, then commit the file. Never in production |
| Regenerate the client | `npx prisma generate` | After install or schema changes |
| Inspect data | `npx prisma studio` | Visual browser, development only |
| Reference data | `npm run db:seed` | Idempotent entry point; currently inserts nothing by design |

Production deploys run `npx prisma migrate deploy` as an explicit operator command — never `migrate dev`, never `db push`, never at startup. There is intentionally no migrate/reset npm shortcut: destructive resets and migration bypasses must not become one convenient command.

---
## 8. How to add a module (copy `notes`, not `auth`)

`src/modules/notes/` is the canonical reference — small on purpose. For the full architectural walkthrough of this exact module (request flow, layer ownership, authorization, validation, errors, tests, and what not to copy), see [docs/reference-module.md](reference-module.md). A new module follows the same layers (auth nests them in `services/`/`repositories/`/`routes/` subdirectories at its scale; small modules keep them flat at the module root like notes and users; `roles/` shows a module may be routes-only — contain only the layers actually needed):

```text
src/modules/<name>/
├── routes/<name>.routes.ts — Route declarations: AJV schemas (additionalProperties: false),
│ guards (preHandler), thin handlers that call the service
├── <name>.service.ts — Composition: validation, policy checks, transactions, domain mapping
│ (file noun follows the module directory: notes → notes.service.ts)
├── <name>.repository.ts — Persistence only: the single place Prisma is touched for this module
├── <name>-response.ts — The ONE public representation (mapper + JSON Schema, shared by route + OpenAPI)
└── <name>.types.ts — Module-local input/output types
```

### Start from the generator

The skeleton above is mechanical, so it is generated. From the project root:

```bash
node scripts/gen-module.mjs <name>     # e.g. node scripts/gen-module.mjs blog-posts
node scripts/gen-module.mjs --help
```

`<name>` must be lowercase kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`). The generator refuses empty names, path separators, path traversal, absolute paths, punctuation, uppercase, leading digits, framework-reserved names (`auth`, `health`, `notes`, `users`, `roles`, …), and any name whose module directory already exists — it rejects **before** writing anything, and never overwrites. Exit codes: `0` success, `1` invalid input or refusal, `2` filesystem error (rolled back).

It creates exactly six files under `src/modules/<name>/`, following the conventions above:

| File | Role |
| --- | --- |
| `<name>.types.ts` | Module-local input/output types |
| `<name>-response.ts` | The one public representation (mapper + JSON Schema) |
| `<name>.repository.ts` | Persistence port — **the only layer that may touch Prisma** |
| `<singular>.service.ts` | Service contract the routes call |
| `routes/<singular>.routes.ts` | `register<Name>Routes(app)` — auth-protected CRUD under `/api/v1/<name>` |
| `routes/<singular>.routes.test.ts` | Route test asserting unauthenticated requests are rejected |

The generator writes only inside `src/modules/`. It never edits `package.json`, the lockfile, `prisma/schema.prisma`, or `src/app/routes.ts`, and it adds no dependency.

**It generates a skeleton, not a working module.** The repository is a typed port whose methods throw an explicit "not implemented yet" error — deliberately, so an unimplemented module is never mistaken for a working one and no fake data is ever returned. Implement it, then:

1. Register the routes: one import and one `app.register(register<Name>Routes)` line in `src/app/routes.ts`.
2. Add the `operationId`s to `OPERATION_ERRORS` in `src/plugins/swagger.plugin.ts` and the routes to the frozen sets in `src/app/openapi-contract.test.ts` — the contract tests fail until both are updated, by design (rule 6 below).
3. Add a Prisma model + migration if the module needs persistence.

Wiring: expose a `register<Name>Routes(app)` function and add one `app.register(...)` line in `src/app/routes.ts` — unregistered route files never serve, and the OpenAPI contract tests fail on any undocumented route, so wiring is verified, not assumed.

Rules, each with a checker or a test behind it:

1. **Start from the route contract.** Declare request and `response:` schemas explicitly; the serializer strips undeclared fields, so the schema is an enforced boundary, not documentation.
2. **Owner linkage is server-derived.** Like notes' `userId`: never accept ownership, identity, or role from the client — take it from `AuthContext` (see `requireAuth`).
3. **Missing → 404, foreign → 403.** Ownership decisions live in `src/modules/authorization/policies/` (never in the repository, never from client data); the service calls the policy, exactly like `notesService` calls `notePolicy.canAccessNote`. Never invent a second convention.
4. **Errors are `AppError` with a registered `ErrorCodes` value.** Never build response bodies in routes; the frozen mapper owns every error envelope.
5. **List endpoints reuse the primitives.** Compose the pagination + sorting + filtering fragments; field allowlists stay endpoint-owned; the server-owned ownership predicate is `AND`ed in the repository and can never be filtered away by the client.
6. **New routes update two frozen tables deliberately:** the operation must be added to `OPERATION_ERRORS` in `src/plugins/swagger.plugin.ts` and to the frozen contract sets in `src/app/openapi-contract.test.ts` — the coverage test fails until you do, which is the point.
7. **Tests live next to the code** (`*.test.ts` colocated; `*.integration.test.ts` for anything touching PostgreSQL, with an explicit DB gate that throws when the database is unavailable).

Do not add generic base classes, registries, or frameworks around this — the notes module is ~5 files precisely because each layer is explicit.

---

## 9. Email in development

No SMTP configuration is needed to develop. With no `SMTP_*` variables set, the composed mailers **are** the NoOp ports: authentication flows (registration, resend, password reset, lockout notices) behave exactly as in production except no email leaves the process. To send real mail locally, point the five `SMTP_*` variables at a development relay (e.g. local Mailhog with `SMTP_SECURITY=plaintext` and no credentials) — never at a production mailbox, and never commit credentials. Sender is derived from `APP_BASE_URL` as `no-reply@<host>`; there is intentionally no `SMTP_FROM`.

### Which auth flows send mail

Five flows attempt delivery, all post-commit: registration sends verification, resend re-sends verification, password-reset request sends a reset link, a lockout transition sends a lockout notice, and a completed reset sends a password-change notice. The first three propagate delivery failure (sanitized `500`, credential stays usable); notices are best-effort and never alter the auth outcome.

### Switching NoOp ↔ SMTP

Configuration is parsed at import time, so **restart the dev server after any `.env` change** (`Ctrl+C`, then `npm run dev` — file watching does not pick up environment edits). To switch:

```bash
# NoOp → SMTP: complete the coherent group, then restart
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURITY=plaintext
# restart, then: POST /api/v1/auth/password-reset/request
# → 204 and the relay receives the message

# SMTP → NoOp: remove all five variables, then restart
```

Verify the direction you intended: with SMTP configured, a partial group (e.g. `SMTP_HOST` alone) fails startup naming `SMTP_PORT`/`SMTP_SECURITY` — that failure *is* the confirmation the group is active. With all five absent, startup succeeds and nothing connects anywhere. There is no live SMTP server in this repository's test setup, so automated suites prove the NoOp path and the validation rules — not real delivery.

---

## 10. Troubleshooting (real problems only)

Startup failures now log one structured line — `Fatal startup error: <title>` with a `startupFailure` object (`category`, safe `details`, `remediation`, `see`) — instead of a raw library dump. The raw error is still attached as `err` for the operator pipeline. Failing fast with exit 1 is preserved everywhere below.

| Failure | Developer sees | Likely action |
|---|---|---|
| Missing `DATABASE_URL` | `Invalid configuration (DATABASE_URL)` + `DATABASE_URL: is missing.` | configure `.env` |
| Short `JWT_SECRET` | `Invalid configuration (JWT_SECRET)` + the 32-char rule | generate a secret |
| Partial SMTP group | `Invalid configuration` + per-variable lines | complete/remove group |
| Bad `PORT` / `LOG_LEVEL` | `Invalid configuration (<VAR>)` + the constraint | correct the value |
| Port occupied | `Port binding failure (EADDRINUSE)` + free-the-port remediation | change/free port |
| DB unreachable at boot | boots; `/health/ready` 503 + `Readiness check failed` naming `postgresql` | verify PostgreSQL/`DATABASE_URL` |
| Pending migrations | `migrate status` reports them; app behavior unchanged until applied | `migrate deploy` |
| Unexpected boot error | `Application bootstrap failure` + logged cause (never on HTTP) | inspect logs |

| Symptom | Cause | Fix |
|---|---|---|
| Startup fails naming `DATABASE_URL` / `JWT_SECRET` | Missing or invalid required variable | Copy `.env.example` to `.env`; set a full `postgresql://` URL and a ≥32-char secret. In production these come from the process environment, not `.env` |
| `P1001` / connection refused at boot or in tests | PostgreSQL not running, or wrong host/port for where the command runs | Start it (`docker compose up -d postgres` needs `POSTGRES_PASSWORD` set). The host to use depends on **where the command runs**: host-side tools (psql, `npx prisma migrate deploy`, tests) use the published port `127.0.0.1:5433`, while the application running *inside* compose uses the network host `postgres:5432`. `127.0.0.1` inside a container is that container itself, never the database |
| `Can't find a suitable migration` / drift errors | Schema and migration history disagree | `npx prisma migrate status` to diagnose; never hand-edit applied migrations or the `_prisma_migrations` table — see `docs/migrations.md` |
| `EADDRINUSE... 3000` | Port already in use (another dev server, or another project on a shared host) | Stop the other server, or run on a free port: `PORT=3451 npm run dev` |
| `PORT` rejected at startup (`PORT must be a valid TCP port`) | Non-numeric, fractional, or out-of-range port (`70000`, `smtp`, `587.5`) | Set a plain integer 1–65535; the schema trims whitespace but nothing else |
| `/health/ready` is 503 locally | PostgreSQL unreachable, migrations pending, or shutdown in progress | Check `DATABASE_URL`, confirm PostgreSQL accepts connections, run `npx prisma migrate status`; `/health/live` staying 200 proves the process itself is fine |
| Startup names a production-only rule (`sslmode=require`, `https://`) | Production gate evaluated outside production, or a real prod misconfiguration | Locally: unset `NODE_ENV=production` (or satisfy the gate deliberately). For real production: add `?sslmode=require`, use an `https://` `APP_BASE_URL` |
| `REDIS_URL` fails startup when "disabled" | `REDIS_URL=""` is a validation *error*, not "unset" | Delete the variable entirely instead of emptying it |
| Partial `SMTP_*` fails startup | By design: any `SMTP_*` without `SMTP_HOST`, missing `PORT`/`SECURITY`, split credentials, or credentials with `plaintext` all reject | Complete the group or remove all five; see §4 |
| Integration tests fail fast demanding a database | They truncate tables and refuse to pass vacuously | Provide `DATABASE_URL` (and never run them with `NODE_ENV=production` — they refuse) |
| `npm test` exits 1 after reporting 0 failures | Root-owned `node_modules/.vite/vitest/results.json` (`EACCES`) — environment artifact, not a failure | Ignore it, or run `npm test` as the owner of `node_modules` |
| Two test runs contaminate each other | DB-backed suites share one database and truncate tables; concurrent runners steal each other's fixtures | Never run two DB-backed vitest processes at once (serial by design: `fileParallelism: false`) |
| `prisma generate` permission errors | `node_modules` owned by another user | Run the install/generate step as that owner (e.g. `sudo`); do not change ownership to chase a green exit |
| Swagger UI 404s in production | `SWAGGER_UI_ENABLED` defaults to `false` in production | Intentional; set it `true` only if you deliberately publish the UI |

---

## 11. Where to read next

| Question | Document |
|---|---|
| Exact REST contract, versioning, breaking-change policy | `docs/api-conventions.md` |
| Auth flows, token lifetimes, throttling, lockout | `docs/auth.md` |
| RBAC model, guards, policies | `docs/authorization.md` |
| Migration lifecycle, drift, failure handling | `docs/migrations.md` |
| Production deployment, Docker, connection tuning | `docs/deployment.md` |
| Error system, status policy | `docs/error-handling.md` |
| Logging, redaction, security events, metrics | `docs/production-logging.md`, `docs/architecture.md` |
| How to build a module (the `notes` walkthrough) | `docs/reference-module.md` | | TLS boundary, HSTS, Secure-cookie contract | `docs/transport-security.md` | | Database backup and recovery | `docs/backup-recovery.md` | | Rollback decisions and incident recovery | `docs/rollback-recovery.md` | | Architecture decisions and their rationale | `docs/adr/` |
