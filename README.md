# Oxyide Forge

A TypeScript backend **foundation** for building secure, maintainable services.

Forge ships a working, tested platform layer — application lifecycle, validated configuration, database access, JWT authentication, RBAC, a frozen error/API contract, health probes, OpenAPI, CI and a Docker image. It is **not a complete application**: the domain features here (the `notes` example, the module generator) are reference and starting points, not finished business functionality.

This is the **V1 foundational platform** — an audited baseline that establishes the core infrastructure, authentication, authorization, and testing patterns that future Oxyide business modules will build upon.

---
**Official website:** https://www.oxyide.com/

---

## Status

| Field | Value |
|-------|-------|
| Version | v1.0.0 |
| Status | Base Platform Complete / Audited |
| Node.js | >= 20.19.0 |
| TypeScript | 5.7+ (strict mode) |

V1 represents the completed foundational platform: Fastify + Prisma/PostgreSQL, JWT authentication with persistent sessions, RBAC, a frozen error/API/observability/health/email architecture, OpenAPI 3.1, CI plus release gates, and a Docker production image. The remaining deferred items (CSRF, MFA, durable email delivery, production observability backends, deployment automation) are documented as future work and are not part of this release.

**What "audited" means here:** the V1 foundation was audited against a defined internal checklist during development. It is **not** a claim of third-party penetration testing, a security certification, or a guarantee of fitness for any particular workload. Verify Forge against your own requirements before production use.

Forge publishes an honest [support policy](docs/support.md) — there is **no SLA**: no guaranteed response time, resolution time, or support duration. Support channels are designated (portal and email, see [Support Policy](docs/support.md) §2), but neither is independently verified from every environment. Oxyide Forge is open-source software under the MIT License; support and maintenance are not included or guaranteed.

---

## Overview

Oxyide Forge provides:

- **Fastify 5.x** application foundation with clean plugin architecture
- **Centralized configuration** validated with Zod at startup
- **Health endpoints** for liveness and readiness checks
- **PostgreSQL** database with Prisma ORM and repository abstraction
- **Authentication** — JWT access tokens, bcrypt password hashing, cookie + bearer auth, persistent refresh sessions, login throttling (PostgreSQL fixed-window), brute-force backoff (bounded exponential delay), temporary account lockout (30-minute non-extending), and security notifications (best-effort post-commit lockout/reset emails)
- **Authorization** — RBAC with roles, permissions, policies, and route guards
- **Email** — provider-neutral `EmailProvider` boundary with NoOp default, generic SMTP transport (customer-owned server), typed HTML + plain-text templates, and authentication wiring (verification, password reset, security notices)
- **Redis foundation** — optional Redis client with cache service abstraction
- **Modular architecture** — clear separation between domain modules, platform infrastructure, and shared code
- **Automated testing** — unit, route, and integration tests with Vitest

---

## Core Features

### Implemented in V1

- Fastify application factory with AJV strict validation (`additionalProperties: false`)
- Graceful startup and shutdown (SIGINT/SIGTERM handling)
- Centralized, validated environment configuration (Zod schema)
- User and Credential database models with Prisma migrations
- User registration with email normalization, password hashing (bcrypt cost 12), and transactional creation
- User login with generic error messages (prevents user enumeration), fixed-window throttling (5 per account / 30 per IP per 15 minutes, PostgreSQL-backed), bounded exponential backoff (250ms doubling to a 2000ms cap), and temporary account lockout (5 failures → 30 minutes, non-extending, resets on success/expiry/password-reset)
- Recovery-issuance throttling: password-reset requests and verification resends bounded at 5 per address / 30 per IP per hour (PostgreSQL-backed, enumeration-safe, race-safe), reusing the login throttle contract (429 `AUTH_TOO_MANY_ATTEMPTS`)
- JWT access tokens (HS256, 15-minute TTL) via `@fastify/jwt`
- Opaque refresh tokens (256-bit, SHA-256 hash persisted) with `Session`/`RefreshToken` models and migration
- Refresh endpoint (`POST /api/v1/auth/refresh`) via HttpOnly `refreshToken` cookie (7-day absolute server-side expiry; single-use rotation with replay-driven family invalidation)
- Browser cookie authentication (`accessToken` cookie, HttpOnly, SameSite Strict)
- Bearer token authentication for API clients
- Logout (cookie clearing)
- Production CSRF startup gate (blocks cookie auth in production until CSRF is implemented)
- RBAC authorization foundation (user/admin roles, 11 permissions)
- Server-side role lookup (never trusts client data)
- Authorization guards: `requireAuth`, `requirePermission`, `requireRole`
- Authorization policy: `userPolicy`
- Self-scope authorization (users can access their own resources)
- Deny-by-default authorization model
- Centralized error-code registry (`ErrorCodes` + `AppError`, mapped to six-field Problem Details)
- AppError class with code + statusCode
- Health endpoints: `GET /health/live`, `GET /health/ready`
- **Notes module (`src/modules/notes`)**: the canonical example feature — user-owned CRUD with explicit AJV request/response schemas, owner-only authorization (`notePolicy`), Problem Details on every failure path, and the first real consumer of the pagination, sorting, and filtering primitives
- OpenAPI 3.1 document generated from the route schemas and served at `GET /openapi.json`, with optional Swagger UI at `/docs` (`OPENAPI_ENABLED` / `SWAGGER_UI_ENABLED`, independently configurable; UI off by default in production)
- Optional Redis client (`ioredis`) with lazy connect and clean shutdown
- Cache service abstraction (get, set, del, exists)
- Email subsystem (frozen): provider-neutral boundary (`src/shared/email`), SMTP transport over any customer-owned server (`src/platform/email`, explicit `smtps`/`starttls`/`plaintext`), typed HTML + plain-text templates (`src/shared/email/templates`), authentication wiring with post-commit delivery and NoOp default when SMTP is unconfigured
- Colocated unit, route, integration, contract, and architecture tests with Vitest (including a 42-test freeze suite pinning every email contract)
- TypeScript strict mode, ESLint, Prettier

### Deferred / Future

- Public per-session management endpoints (listing, single-session administration; tested Auth-owned primitives exist)
- Password-change flow (reset and verification reuse the password policy and bcrypt config directly)
- Durable email delivery (outbox/worker/retry), delivery tracking, bounces, marketing mail, localization, template CMS, customer branding — transport and templates are frozen as implemented
- CSRF protection for cookie-based authentication
- MFA / TOTP / WebAuthn
- Temporary account lockout is current since (30-minute non-extending `User.lockedUntil`; lockout administration stays future)
- Multiple roles per user (UserRoles join table)
- Role administration CRUD API
- Permission caching in Redis
- Distributed rate limiting (general rate limiting; login throttling implemented with PostgreSQL)
- Production observability backends (Sentry, OpenTelemetry collectors, metrics stores — Forge ships NoOp boundaries; customers wire their own)
- Customer log storage, retention, and SIEM (Forge owns structure/semantics/privacy; customers own collection and storage)
- Image scanning, dev/prod Compose profiles, deployment automation

---

## Feature Inventory

What Forge actually ships, and — importantly — what you still have to build. Every row states its real status:

| Status meaning |
|---|
| **Verified** | Implemented and covered by the automated test suite in this repository. |
| **Opt-in** | Implemented but disabled by default; you enable it with configuration. |
| **Example** | Real, working reference code — but it is a *sample*, not your business logic. Use it as the pattern. |
| **Skeleton** | Generated scaffolding that **will not work until you implement it**. |
| **Not included** | Deliberately deferred; documented under [Deferred / V2 Scope](#deferred--v2-scope). |

### Platform layer — ships working

| Capability | Status | Limitation / note |
|---|---|---|
| Fastify 5 application factory, strict AJV validation (`additionalProperties: false`) | **Verified** | — |
| Centralized config validated by Zod at startup | **Verified** | No insecure default for anything security-relevant; see [Configuration](#environment-configuration) |
| Graceful startup/shutdown (SIGINT/SIGTERM) | **Verified** | — |
| PostgreSQL access via Prisma with a repository boundary | **Verified** | Repository is the only layer that touches Prisma |
| Health probes `/health/live`, `/health/ready` | **Verified** | Readiness requires PostgreSQL; body is always empty by design |
| Structured Pino logging with redaction + security events | **Verified** | See [Production Logging](docs/production-logging.md) |
| Frozen Problem Details error contract (`ErrorCodes` + `AppError`) | **Verified** | — |
| OpenAPI 3.1 document + Swagger UI | **Opt-in** | `/openapi.json` on by default; `/docs` UI on except in production |
| Prometheus `/metrics` exporter | **Opt-in** | Off by default (`METRICS_ENABLED=true`). Bounded labels only — never raw URLs, IDs, or tokens |
| Redis client + cache abstraction | **Opt-in** | Runs fully without Redis; not used by auth/authz in V1 |
| Email subsystem (provider boundary, SMTP transport, typed templates) | **Opt-in** | **NoOp by default — no email leaves the process** until SMTP is configured |
| Automated test suite (unit, route, integration, contract, architecture) | **Verified** | Integration tests need a real PostgreSQL and **truncate** the target database |
| 16-rule automated architecture checker | **Verified** | `npm run architecture:check` |
| CI + release gates, Docker production image (non-root, healthchecked) | **Verified** | Image verified locally; see Deployment for platform caveats |
| Pre-commit hook (typecheck + lint + architecture) | **Verified** | Installed by `setup.sh`; no tests or build are run |
| Coverage reporting | **Opt-in** | `npm run test:coverage`. **Informational only — no threshold exists** |

### Authentication and authorization — ships working

| Capability | Status | Limitation / note |
|---|---|---|
| JWT access tokens (HS256, 15 min) + opaque refresh with rotation | **Verified** | — |
| Registration, login, logout, refresh, revoke-all | **Verified** | Registration does **not** issue a token; login is separate |
| Password reset + email verification flows | **Verified** | Email delivery is NoOp unless SMTP is configured |
| Login throttling (account + IP), bounded backoff, temporary account lockout | **Verified** | Lockout is 5 failures → 30 min, non-extending; there is **no unlock endpoint** |
| Security notifications (lockout, password reset) | **Verified** | Best-effort, post-commit; delivery failure never alters the auth outcome |
| RBAC — roles, permissions, `requireAuth` / `requirePermission` / `requireRole` | **Verified** | `user` and `admin` roles only; role *administration CRUD is not included* |
| Cookie auth for browsers | **Verified, production-disabled** | **Blocked in production until CSRF exists.** Bearer auth remains available |

### Reference and scaffolding — real code, but not your business logic

| Capability | Status | What you must do |
|---|---|---|
| `notes` module | **Example** | A complete, working, user-owned CRUD module — but it is a *sample*. Copy its structure; write your own domain. |
| Module generator (`scripts/gen-module.mjs`) | **Skeleton** | Generates a conformant module **skeleton**: types, response schema, a service, routes, and a repository **port whose methods throw "not implemented yet"**. It creates no database model and returns no fake data. You must implement the repository, register the routes, and add a Prisma model. |
| `render.yaml` / `fly.toml` | **Example** | Platform starting points, validated locally but **never deployed to a live account**. You own the database, secrets, and DNS. |

### Not included

CSRF, MFA, durable email delivery/outbox, session-management endpoints, password change, role administration CRUD, permission caching, general/distributed rate limiting (login + recovery throttling *are* included), production observability backends (Sentry/OpenTelemetry/metrics stores), log storage and SIEM, image scanning, and automated deployment pipelines. See [Deferred / V2 Scope](#deferred--v2-scope).

> **Forge does not host Grafana, Prometheus, Sentry, or any other backend.** It ships the exporter and the boundary; you run and own the storage.

---

## Development tooling

| Command | Purpose |
|---|---|
| `npm run check` | Fast gate: typecheck + lint + architecture check. Also what the pre-commit hook runs. |
| `npm test` | Full test suite (needs PostgreSQL). |
| `npm run test:watch` | Watch mode. |
| `npm run test:coverage` | Full suite + coverage report in `coverage/`. **Informational only — no threshold.** |
| `npm run typecheck` / `npm run lint` / `npm run build` | TypeScript / ESLint / compile. |
| `npm run architecture:check` | 16-rule architecture enforcement. |
| `bash setup.sh` / `npm run setup` | One-command onboarding (see [Quick Start](#quick-start)). |
| `node scripts/gen-module.mjs <name>` | Generate a conformant module skeleton. |
| `npm run dashboards` | Regenerate the Grafana dashboard JSON from the manifest. |
| `npm run smoke` | Probe a running instance's `/health/live` + `/health/ready`. |
| `npm run verify:deployment` | Deployment-artifact verification. |
| `npm run validate` | Full pre-ship validation. |

Full inventory and the daily loop: [docs/development.md](docs/development.md).

---

## Tech Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Runtime | Node.js | >= 20.19.0 |
| Language | TypeScript | ^5.7.0 |
| HTTP Framework | Fastify | ^5.1.0 |
| ORM | Prisma | 6.12.0 |
| Database | PostgreSQL | 17+ |
| Cache (optional) | ioredis | ^6.0.0 |
| JWT | @fastify/jwt | ^10.2.2 |
| Cookies | @fastify/cookie | ^11.1.2 |
| Password Hashing | bcrypt | ^6.0.0 |
| Validation | Zod | ^3.25.0 |
| Logging | Pino | ^9.3.0 |
| Plugin Wrapper | fastify-plugin | ^6.0.0 |
| Testing | Vitest | ^2.1.0 |
| Linting | ESLint | ^9.17.0 |
| Formatting | Prettier | ^3.3.0 |

---

## Architecture

The application follows a modular monolith architecture with clear dependency boundaries:

```text
src/
├── main.ts — Bootstrap entry point
├── app/ — Fastify factory, server, routes, lifecycle hooks
├── modules/ — Domain modules (auth, authorization, roles, users, notes, health)
│ └── auth/email/ — Auth email adapters + composition (domain request → template data; only transport selection point)
├── shared/ — Dependency-light cross-cutting code: errors, email contract + templates, pagination/sorting/filtering, logging, tracing, metrics
├── platform/ — Infrastructure/provider implementations: database (Prisma), cache (Redis), email (SMTP transport)
├── plugins/ — Cross-cutting Fastify plugins (auth, cookie, cors, redis, telemetry, swagger, …)
├── config/ — Centralized configuration with Zod validation (sole process.env consumer)
└── types/ — Fastify type augmentation, AuthContext contract
```

**Dependency rule:** Domain modules depend on shared infrastructure. Shared code never depends on domain modules. Modules never import each other's repositories.

For the complete architecture document, see [docs/architecture.md](docs/architecture.md).

---

## Project Structure

```text
oxyide-forge/
├── src/
│ ├── main.ts — Bootstrap entry point
│ ├── app/ — Fastify factory, server, routes, lifecycle hooks
│ ├── modules/
│ │ ├── auth/ — Authentication (routes, services, repositories, types) + email/ adapters
│ │ ├── authorization/ — RBAC (permissions, roles, guards, policies, service)
│ │ ├── users/ — User domain (routes, service, repository, types)
│ │ ├── notes/ — Canonical example module (routes, service, repository, types)
│ │ ├── health/ — Health endpoints
│ │ └── roles/ — Role listing and detail (read-only; CRUD is future)
│ ├── shared/
│ │ ├── errors/ — AppError, ErrorCodes, error mapper
│ │ ├── email/ — EmailProvider contract, NoOp provider, templates/ (registry, templates, layout, escaping)
│ │ ├── pagination|sorting|filtering/ — Validated list-query primitives
│ │ └── logging|tracing|metrics/ — Pipeline options, NoOp tracer/metrics
│ ├── platform/
│ │ ├── database/ — Prisma client
│ │ ├── cache/ — Redis client, CacheService
│ │ └── email/ — SMTP transport (sole nodemailer importer)
│ ├── plugins/
│ │ ├── auth.plugin.ts — JWT registration + authenticate hook
│ │ ├── cookie.plugin.ts — Cookie handling + production CSRF gate
│ │ ├── cors.plugin.ts — Strict opt-in origin allowlist
│ │ ├── redis.plugin.ts — Optional Redis connect/disconnect
│ │ └── … — request-id, security-headers, swagger, telemetry (see src/plugins/)
│ ├── config/
│ │ ├── index.ts — Centralized config (sole process.env consumer)
│ │ ├── env.schema.ts — Zod validation schema
│ │ └── types.ts — Config type definitions
│ └── types/
│ ├── auth-context.ts — AuthContext contract (ADR-001)
│ └── fastify.d.ts — Fastify type augmentation
├── prisma/
│ ├── schema.prisma — 8 models: User, Credential, Session, RefreshToken, PasswordResetToken, EmailVerificationToken, LoginThrottle, Note
│ └── migrations/ — Database migrations (deployment source of truth)
├── docs/
│ ├── development.md — Developer guide: first run, daily loop, module recipe (start here)
│ ├── architecture.md
│ ├── engineering-standards.md
│ ├── api-conventions.md
│ ├── auth.md
│ ├── authorization.md
│ ├── migrations.md
│ ├── deployment.md
│ └── adr/ — Architecture Decision Records (001–003, 005–014; 004 never issued)
├──.env.example
├── LICENSE.txt
├── package.json
└── tsconfig.json
```

---

## Prerequisites

- **Node.js** >= 20.19.0
- **npm** (used by this project; lockfile is `package-lock.json`)
- **PostgreSQL** 17+ (required)
- **Redis** (optional — the application starts without it when `REDIS_URL` is not set)

---

## Quick Start

> **Forge needs a PostgreSQL database before anything else works.** There is no bundled database process — provision one first, then install. Setup checks that your database is *reachable*; it does not create or provision one.

### 0. Pick your shell

| Your environment | Follow | Setup command |
|---|---|---|
| Windows PowerShell | [Installation](docs/installation.md) §2–§6 (`PowerShell` blocks) | `npm run setup` |
| Windows Command Prompt | [Installation](docs/installation.md) §2–§6 (`Command Prompt` blocks) | `npm run setup` |
| macOS / Linux Terminal, WSL2, Git Bash | [Installation](docs/installation.md) §2–§6 (`macOS / Linux` blocks) | `npm run setup` (or `bash setup.sh`) |
| VS Code integrated terminal | Whichever shell is selected in the terminal dropdown — then the row above | same as the selected shell |

`bash setup.sh` works on macOS/Linux only. On Windows use `npm run setup`
(PowerShell and Command Prompt) — do not install Bash just to run onboarding.
The condensed cross-shell sequence below mirrors the canonical
[Installation](docs/installation.md) guide; if anything differs, the guide wins.

### 1. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | **>= 20.19.0** | enforced by `engines`; `setup.sh` refuses to run on anything older |
| npm | ships with Node | lockfile is `package-lock.json` |
| PostgreSQL | **17+** | **required** |
| Redis | — | *optional*; the app starts and works without it when `REDIS_URL` is unset |

### 2. Provision PostgreSQL

Pick whichever suits you. Any PostgreSQL 17+ instance works — local, Docker, or a managed service.

**Option A — bundled Docker Compose database (easiest):**

```bash
export POSTGRES_PASSWORD='choose-a-local-password'   # required; Compose refuses to start without it
docker compose up -d postgres
```

This starts `postgres:17-alpine` on **host port 5433** (container port 5432) with a persistent volume. (PowerShell: `$env:POSTGRES_PASSWORD='…'`; Command Prompt: `set POSTGRES_PASSWORD=…` — see [Installation](docs/installation.md).)

**Option B — an existing or managed PostgreSQL:**

Create a role and database, and note the credentials:

```bash
createuser forge --pwprompt
createdb oxyide_starter --owner forge
```

### 3. Get the code

Forge is distributed as a **ZIP download**, not a Git repository. Extract it
with your shell's native tool, then enter the folder:

```bash
unzip oxyide-forge-v1.0.0.zip -d my-backend
cd my-backend
```

(If you received a Git URL instead, `git clone <url> my-backend` also works.)

Windows PowerShell and Command Prompt need different extraction commands —
see [Installation](docs/installation.md) §2.

### 4. Configure the environment

```bash
cp .env.example .env
```

(Windows shells need different copy commands — see [Installation](docs/installation.md) §4.)

Then set **at minimum**:

```env
DATABASE_URL=postgresql://forge:YOUR_PASSWORD@127.0.0.1:5433/oxyide_starter
JWT_SECRET=a-random-secret-of-at-least-32-characters
```

`DATABASE_URL` must match the database you provisioned in step 2. `JWT_SECRET` must be **>= 32 characters** — there is no default and the app will not start without it. Every variable is validated at startup by `src/config/env.schema.ts`; invalid values fail immediately with a message naming the variable.

Full contract, defaults, and optional groups: [Environment Configuration](#environment-configuration).

### 5. Run setup

```bash
npm run setup
```

`npm run setup` performs, in order: prerequisite checks → `npm ci` → Husky pre-commit hook install → create `.env` if absent (**never overwrites an existing one**) → check the database is reachable → `prisma generate` → `prisma migrate deploy` → build → start the dev server → poll `/health/ready` until it returns `200` (up to 60s). On macOS/Linux, `bash setup.sh` runs the same implementation.

> `npm run setup` installs the Husky hook because Forge deliberately avoids npm `prepare` lifecycle scripts. If you installed with a bare `npm ci` instead, run `npx husky` once to enable commit checks. (A ZIP extraction has no `.git`, so the hook install is skipped there.)

### 6. Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health/live   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health/ready  # 200
```

(Windows shells need `curl.exe` with different flags — see [Installation](docs/installation.md) §6.)

- `/health/live` — process is alive; returns `200` whenever the process serves traffic.
- `/health/ready` — returns `200` only when a dependency is usable; PostgreSQL is the only required dependency. Returns `503` otherwise. Both return an **empty body by design**.

### 7. Where to go next

| I want to… | Go to |
|---|---|
| See the interactive API docs | <http://localhost:3000/docs> (`SWAGGER_UI_ENABLED`, off in production) or `/openapi.json` |
| Understand what is included | [Feature Inventory](#feature-inventory) |
| Understand the architecture | [Architecture](docs/architecture.md) |
| Add a module | [Reference module](docs/reference-module.md) · [Module generator](docs/development.md#start-from-the-generator) |
| Configure everything | [Environment Configuration](#environment-configuration) |
| Deploy | [Deployment](docs/deployment.md) |
| Set up metrics | [Observability](docs/observability.md) |
| Fix a problem | [Troubleshooting](docs/troubleshooting.md) |
| Run the tests | [Testing](#testing) · [Development workflow](docs/development.md) |

### Manual setup (equivalent, step by step)

If you prefer not to use `setup.sh`:

```bash
npm ci
npx prisma generate        # generate the Prisma client
npx prisma migrate deploy  # apply pending migrations (never migrate dev / reset / seed here)
npm run build
npm run dev                # development server with watch + .env loading
```

---

## Environment Configuration

The application uses centralized configuration validated with Zod at startup. Configuration is read from environment variables in `src/config/index.ts` via `src/config/env.schema.ts`.

Copy the provided `.env.example` file to `.env` and edit with your production values. `npm run dev` loads `.env` automatically; `npm start` reads the process environment only (see [Running the Application](#development)).

### Required

```env
DATABASE_URL=postgresql://user:password@localhost:5432/oxyide
JWT_SECRET=<strong-random-secret-min-32-chars>
```

Connection behavior is tuned through `DATABASE_URL` query parameters (native
Prisma mechanism — no separate variables): `connection_limit`,
`pool_timeout`, and `connect_timeout` must be positive integers (≥ 1) when
present; `sslmode` must be `require` or `disable`. Production requires
`sslmode=require`. See `docs/deployment.md` (Connection management).

### Optional

```env
NODE_ENV=development # development | test | production (default: development)
HOST=0.0.0.0 # default: 0.0.0.0
PORT=3000 # default: 3000
LOG_LEVEL=info # fatal | error | warn | info | debug | trace (default: info)
REDIS_URL=redis://localhost:6379 # optional; redis:// or rediss:// protocol
APP_BASE_URL=http://localhost:3000 # optional; production REQUIRES https://
OPENAPI_ENABLED=true # serve the OpenAPI document at /openapi.json (default: true)
SWAGGER_UI_ENABLED=true # serve Swagger UI at /docs (default: true, except production)
```

All environment variables are validated at application startup. Invalid or missing required variables cause the application to fail immediately with a clear error message.

---

## Database Setup

### Database Setup

For the first-run sequence (PostgreSQL → `prisma migrate deploy` → `npm run dev` → health check), the extension model (routes → services → repositories), the daily development loop, and troubleshooting, see [docs/development.md](docs/development.md) — the single developer guide. The reference below lists the raw commands.

### Prisma Commands

```bash
npx prisma generate # Generate Prisma Client
npx prisma migrate deploy # Apply pending migrations — SAFE: use this for local and production
npx prisma validate # Validate the Prisma schema
npx prisma studio # Open Prisma Studio (visual database browser)
npm run db:seed # Run the idempotent seed entry point
```

> **`prisma migrate dev` is deliberately not listed.** It is a development-time command that can prompt to **reset the database** when it detects drift, and it applies migrations only to development databases. Forge's onboarding and deployment workflow use `prisma migrate deploy`, which applies pending migrations and does nothing else. Never run `prisma migrate dev` or `prisma migrate reset` against a database whose data you care about.

### Initial Migration

The database schema includes eight models:

- **User** — id, email (unique), displayName, status, role, timestamps
- **Credential** — id, userId (unique FK), passwordHash, timestamps
- **Session / RefreshToken** — persistent refresh sessions with rotation state
- **PasswordResetToken / EmailVerificationToken** — opaque single-use credentials (SHA-256 hash persisted)
- **LoginThrottle** — PostgreSQL-backed fixed-window throttle counters
- **Note** — user-owned example resource (`User 1:N Note`)

Key relationships are `User 1:1 Credential`, `User 1:N Session`, `User 1:N Note`.

For migration documentation, see [docs/migrations.md](docs/migrations.md).

### Database Seed

```bash
npm run db:seed # Run the idempotent seed entry point
```

- Explicitly invoked; application startup never runs it and it is not part of deployment.
- Idempotent and safe to repeat; performs no destructive operations and deletes nothing.
- The current schema defines no baseline seed data, so it inserts nothing.
- Disabled in production. Requires `DATABASE_URL` (and validated config); verify the target database before running.

---

## Running the Application

### Development

```bash
npm run dev
```

Starts the application with file watching via `tsx watch`. The server listens on the configured `HOST` (default: `0.0.0.0`) and `PORT` (default: `3000`).

`npm run dev` loads `.env` automatically (Node's built-in `--env-file-if-exists=.env`, no extra dependency). Notes:

- If `.env` is missing the server still starts and reports the missing variables through normal configuration validation.
- Values already present in the environment win over `.env`, so `PORT=3001 npm run dev` overrides the file.
- `.env` is for local development only. `npm start` (production) does not read it — production configuration comes from the process environment.

### Production Build

```bash
npm run build
npm start
```

### Health Check

Once running, verify the application:

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

### API Documentation

The OpenAPI document is generated from the route schemas at request time:

```bash
curl http://localhost:3000/openapi.json
```

With `SWAGGER_UI_ENABLED=true` the same document is browsable at `http://localhost:3000/docs`. The two capabilities are independently configurable:

| `OPENAPI_ENABLED` | `SWAGGER_UI_ENABLED` | Result |
|--------------------|----------------------|--------|
| `false` | `false` | Neither route exists |
| `true` | `false` | `/openapi.json` only |
| `true` | `true` | `/openapi.json` and `/docs` |
| `false` | `true` | **Rejected at startup** — the UI has nothing to render |

Swagger UI is a presentation layer over the OpenAPI document, not a second API definition. It is disabled by default in production; set `SWAGGER_UI_ENABLED=false` to hide it while keeping `/openapi.json`.

---

## API

All API routes are versioned under `/api/v1`. Health endpoints are public infrastructure endpoints outside the versioned namespace.

### Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/health/live` | Liveness check | None |
| `GET` | `/health/ready` | Readiness check | None |
| `POST` | `/api/v1/auth/register` | Register a new user | None |
| `POST` | `/api/v1/auth/login` | Authenticate a user | None |
| `POST` | `/api/v1/auth/logout` | Clear auth cookies | None |
| `GET` | `/api/v1/auth/me` | Get current authenticated user | Bearer or cookie |
| `POST` | `/api/v1/auth/refresh` | Exchange refresh cookie for a new access token | Refresh cookie |
| `POST` | `/api/v1/auth/password-reset/request` | Start password recovery (generic response) | None |
| `POST` | `/api/v1/auth/password-reset/confirm` | Complete password recovery from a reset credential | Reset token |
| `POST` | `/api/v1/auth/email-verification/resend` | Re-send verification message (generic response) | None |
| `POST` | `/api/v1/auth/email-verification/confirm` | Prove email control from a verification credential | Verification token |
| `POST` | `/api/v1/auth/sessions/revoke-all` | Revoke every session of the authenticated user | Bearer or cookie |
| `GET` | `/api/v1/users/:id` | Get a user (self or permitted) | Bearer or cookie |
| `PUT` | `/api/v1/users/:id` | Partial update of a user | Bearer or cookie |
| `DELETE` | `/api/v1/users/:id` | Delete a user | Bearer or cookie |
| `GET` | `/api/v1/roles` | List roles | Bearer or cookie |
| `GET` | `/api/v1/roles/:name` | Get a role by name | Bearer or cookie |

The notes example module adds five more operations (`/api/v1/notes`, `/api/v1/notes/:id`); the machine-readable route table is always available at `/openapi.json`.

For the complete API contract, see [docs/api-conventions.md](docs/api-conventions.md).

### Versioning and Compatibility

The API is versioned by URL only: `/api/v1`. There are no version headers, no negotiation, and no minor URL versions. `v1` is a compatibility contract, not a release number — the package version and the API major version evolve independently.

- **Compatible inside `v1`:** new endpoints, optional request fields, new error codes for genuinely new failure modes, documentation.
- **Breaking (needs a new major version):** removing/renaming endpoints or fields, changing types, nullability, meanings, status codes, error-code meanings, authentication, or authorization requirements.
- **`operationId` values are contractual** — renaming one breaks generated clients.

Contributors must classify an API change as compatible or breaking in the change description before review. Full policy: [docs/api-conventions.md §2](docs/api-conventions.md) and [ADR-014](docs/adr/014-api-versioning-deprecation-policy.md).

### Deprecation

Deprecation is declared once, on the route, and applies to the OpenAPI document and the HTTP response at the same time. A deprecated operation **keeps working unchanged** until its published sunset date — deprecation never changes a status code or body.

```ts
schema: {
 deprecation: {
 deprecated: true,
 reason: 'Superseded by the batch endpoint.',
 successor: '/api/v1/batches', // optional, absolute path only
 sunset: 'Wed, 31 Dec 2026 23:59:59 GMT', // optional, future HTTP-date
 },
}
```

That single declaration produces, automatically:

- OpenAPI `deprecated: true` (Swagger UI renders it natively) plus `x-deprecation-reason` / `-sunset` / `-successor`.
- `Deprecation: true`, `Sunset: …`, and `Link: <successor>; rel="successor-version"` response headers.

No operation is deprecated today. An invalid declaration (an internal URL, a credential, a header-injection attempt, a past date) fails at startup rather than shipping a broken signal.

### Example Module: Notes

`src/modules/notes` is the canonical reference feature. Every future domain module is expected to follow its boundaries. Start with [docs/reference-module.md](docs/reference-module.md) — the architectural walkthrough of exactly this module.

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/notes` | List the caller's notes (paginated/sorted/filtered) | Bearer |
| `POST` | `/api/v1/notes` | Create a note (201, `Location` set) | Bearer |
| `GET` | `/api/v1/notes/{id}` | Read a note (own or 403) | Bearer |
| `PUT` | `/api/v1/notes/{id}` | Update a note (own or 403) | Bearer |
| `DELETE` | `/api/v1/notes/{id}` | Delete a note (204) | Bearer |

It demonstrates every cross-cutting decision in one small place: strict AJV request/response schemas, owner-only authorization via `notePolicy` (cross-user → 403, missing → 404, no client-supplied owner), Problem Details via `AppError`, the single module-owned public mapper, and — for the first time — pagination, sorting, and filtering actually consumed.

List query:

```
GET /api/v1/notes?limit=20&page=1&sort=createdAt:desc&filter[status]=active&filter[title_contains]=milk
```

`{ page, limit }` (default 1/20, max 100), `?sort=` from the endpoint-owned allowlist `title | status | createdAt` (each `:asc|:desc`, max 3), and `filter[field_op]` from the endpoint-owned set `status` (enum: `eq|ne|in`), `title` (string), `createdAt` (datetime: `gt|gte|lt|lte`). The owner predicate is always applied server-side; `userId`/`ownerId`/credentials/relations can never be injected.

---

## Authentication

V1 implements JWT-based authentication with persistent refresh sessions:

- **Registration** — Creates a user with normalized email and bcrypt-hashed password (cost 12). Registration does NOT issue an access token; the user must log in separately.
- **Login** — Returns a JWT access token. Browser clients receive the token via an `accessToken` cookie plus a `refreshToken` cookie backed by a persistent session. API clients receive the access token in the JSON response body.
- **Refresh** — `POST /api/v1/auth/refresh` exchanges the `refreshToken` cookie for a new access token plus a successor credential (single-use rotation; replay invalidates the family). Successor inherits the 7-day absolute session expiry.
- **Logout** — Revokes the session identified by the presented refresh credential and clears both auth cookies. Credential-less logout only clears cookies. Access JWTs drain to expiry.
- **Revoke all sessions** — `POST /api/v1/auth/sessions/revoke-all` revokes every live session of the bearer- or cookie-authenticated user (`204`, idempotent, no metadata returned). Access JWTs drain; a new login starts fresh.
- **Password reset** — `POST /api/v1/auth/password-reset/request` (always generic `204`) and `/confirm` (opaque single-use credential, 1-hour server-side expiry; consumes token, replaces password hash, and revokes all sessions atomically). Recovery email is delivered post-commit through the frozen email subsystem: NoOp transport when SMTP is unconfigured, otherwise SMTP with typed HTML + plain-text templates.
- **Email verification** — Registration issues an opaque single-use credential (24-hour server-side expiry) with post-commit delivery; `POST /api/v1/auth/email-verification/resend|confirm` complete the flow. Confirmation stamps `emailVerifiedAt` without creating sessions, JWTs, or revocations; unverified users can still log in. When SMTP is unconfigured the credential is recorded but no email leaves the process (NoOp default).
- **Login throttling** — Fixed-window frequency control: 5 failures per account per 15 minutes, 30 failures per source IP per 15 minutes, backed by PostgreSQL. Throttled attempts return `429 AUTH_TOO_MANY_ATTEMPTS` before any authentication work. State expires naturally; successful login resets account-scoped state.
- **Brute-force protection** — Bounded exponential backoff derived from account failure state: 250ms doubling per level, capped at 2000ms, applied asynchronously before authentication work. Same `LoginThrottle` state, no new table. Enumeration-resistant (pre-lookup state only); successful login resets account delay; source abuse state preserved. No CAPTCHA.
- **Account lockout** — Temporary, bounded, account-scoped policy: 5 account failures within a live window lock the account for a fixed, non-extending 30 minutes (`User.lockedUntil`). Locked logins return the byte-identical `429 AUTH_TOO_MANY_ATTEMPTS` with no bcrypt, no delay, and no state change. Recovery is expiry-driven or via successful password reset; existing sessions, refresh, and JWTs are unaffected; there is deliberately no unlock endpoint.
- **Security notifications** — Best-effort post-commit emails for exactly two events: the lock transition (one notice per lock, never for retries) and successful password reset (one notice per committed reset). Rendered from frozen typed templates; delivery failure is logged safely and never alters the auth outcome. No queue, outbox, retry, endpoint, or preferences.
- **Current user** — `GET /api/v1/auth/me` returns the current persisted user for the bearer-authenticated request. Identity comes from `AuthContext`; PostgreSQL is authoritative for current state.
- **Token lifetime** — Access 15 minutes (900 seconds); refresh 7 days (absolute, server-side).
- **Password minimum** — 12 characters.

### Cookie Configuration

| Attribute | Value |
|-----------|-------|
| Name | `accessToken` |
| HttpOnly | `true` |
| SameSite | `strict` |
| Secure | `true` in production / `false` in development |
| Path | `/` |
| Max-Age | 900 seconds |

### Refresh Cookie Configuration

| Attribute | Value |
|-----------|-------|
| Name | `refreshToken` (distinct from `accessToken`) |
| HttpOnly | `true` |
| SameSite | `strict` |
| Secure | `true` in production / `false` in development |
| Path | `/api/v1/auth/refresh` (scoped to the refresh endpoint) |
| Max-Age | Remaining session lifetime (rotation never extends it) |

**Production note:** Cookie-based authentication is blocked in production until CSRF protection is implemented. The cookie plugin is skipped when `NODE_ENV=production`; Bearer authentication remains available.

For the complete authentication contract, see [docs/auth.md](docs/auth.md).

---

## Authorization

V1 implements role-based access control (RBAC) with server-side role lookup:

### Roles

| Role | Description |
|------|-------------|
| `user` | Default role at registration. Self-scoped permissions only. |
| `admin` | Elevated role with full permission set. |

### Guards

```ts
// Require authentication
{ preHandler: [requireAuth] }

// Require a specific permission
{ preHandler: [requireAuth, requirePermission('users:delete')] }

// Require a specific role
{ preHandler: [requireAuth, requireRole('admin')] }
```

- Unauthenticated requests return **401** with `WWW-Authenticate` header
- Unauthorized requests (insufficient permissions) return **403**

Authorization decisions are derived from server-side role lookup — never from client-supplied data.

For the complete authorization model, see [docs/authorization.md](docs/authorization.md).

---

## Redis

Redis is **optional** in V1. The application starts and functions normally without it.

When `REDIS_URL` is configured:

- The Redis plugin connects during startup using `ioredis` with lazy connect
- The client is available via `app.redis`
- A `CacheService` abstraction provides `get`, `set`, `del`, and `exists` operations
- The client disconnects during application shutdown

When `REDIS_URL` is not set:

- The Redis plugin is skipped entirely
- `config.cache` is `undefined`
- No Redis connection is attempted

Redis is not used by authentication or authorization in V1. Sessions and login throttling are PostgreSQL-backed. Redis provides infrastructure for future features (general rate limiting, permission caching).

---

## Testing

### Commands

```bash
npm test # Run all tests (vitest run)
npm run test:watch # Run tests in watch mode
```

### Test Categories

Tests are colocated with source files using the `*.test.ts` naming convention:

- **Unit tests** — Config, password service, token service, cache service, Redis client, permissions, authorization service, login throttle service/repository
- **Route tests** — Auth routes, health routes, auth plugin, cookie plugin, Redis plugin, login throttle service/repository
- **Integration tests** — Full HTTP request/response tests against real PostgreSQL (fail fast when the database is unavailable, never silently pass). Integration suites truncate tables in the targeted database and refuse `NODE_ENV=production`; verify `DATABASE_URL` before running.
- **Migration tests** — Opt-in Prisma migration workflow tests against an explicitly provided disposable database (`OXYIDE_MIGRATION_TEST_URL`; visibly skipped without it, which is not full migration validation). The ambient `DATABASE_URL` is never used as a fallback; production and shared targets are refused; drift experiments run only through a guarded helper that restores state. See `docs/deployment.md`.
- **Connection tests** — Prisma pool/timeout/TLS mechanism proofs against the test database (`prisma/connection.integration.test.ts`), plus config validation unit tests. See `docs/deployment.md` (Connection management).
- **Policy tests** — Authorization policy functions
- **Guard tests** — Authorization guard behavior
- **Architecture tests** — Automated enforcement self-tests (`scripts/architecture-check.test.ts`)

### Quality Gates

```bash
npm run check # Fast pre-commit trio: typecheck + lint + architecture check
npm test # Tests
npm run typecheck # TypeScript type checking (tsc --noEmit)
npm run lint # ESLint
npm run build # TypeScript compilation (tsc)
npm run architecture:check # Automated architecture enforcement
npm run validate # Full local release validation (security:all + migrate status + SBOM + release + deployment checks)
```

`npm run check` is the per-edit loop; `npm run validate` is the pre-tag/pre-ship loop (needs PostgreSQL, takes minutes). All gates must pass before any change is considered complete. Command inventory, the test workflow (watch/targeted/full), and the exact `validate` sequence are documented in [docs/development.md §6](docs/development.md).

### OpenAPI Contract Gates

Two suites keep the published OpenAPI document honest about the running API:

- `src/app/openapi-contract.test.ts` — the generated document is structurally valid, every runtime route is documented **and** every documented route is real, operation IDs match the frozen contract, request/response schemas, Problem Details, security, and deprecation all match, and nothing sensitive is published. No database required.
- `src/app/openapi-runtime-contract.integration.test.ts` — live responses are validated against their own published operation (201/200/204/400/401/403/404/409/429). Database required.

The document is generated, never committed. If a change adds, removes, or re-shapes an operation, update the frozen contract deliberately — do not weaken the assertion to make a change pass.

### Supply-Chain Security Gates

```bash
npm run security:dependencies # Dependency audit, production scope (blocking: must be 0 findings)
npm run security:secrets # Secret scan via gitleaks (blocking; requires gitleaks >= 8.30 installed)
npm run security:sast # Static security scan, repo-owned ruleset (blocking)
npm run security:sbom # Generate + validate CycloneDX SBOM (sbom.cyclonedx.json, gitignored)
npm run security:all # All security gates + typecheck/lint/tests/build/architecture
npm run release:check # Validate release readiness (contents, version, SBOM, evidence)
```

CI (`.github/workflows/ci.yml`, PR + main) runs every gate with a live PostgreSQL service; releases (`release.yml`, `v*` tags only) re-run all gates plus packaging, SBOM, artifact validation, and GitHub Release publication. Full policy: `docs/release-contract.md`.

---

## Development Standards

All code must follow [docs/engineering-standards.md](docs/engineering-standards.md).

Key rules:

- TypeScript strict mode is mandatory — no `any`, no non-null assertions without justification
- Every change must pass typecheck, lint, and tests
- Module boundaries must not be violated — modules never import each other's repositories
- New dependencies require written justification
- Architecture changes require an ADR under `docs/adr/`
- Secrets must never be logged, committed, or exposed in error responses

For contributor guidelines, see `AGENTS.md` in the repository.

---

## Documentation

| Document | Purpose |
|----------|---------|
| [Installation](docs/installation.md) | **Start here for setup** — per-shell Windows/macOS/Linux instructions, PostgreSQL options, verification |
| [Troubleshooting](docs/troubleshooting.md) | **Start here when something fails** — evidence-backed fixes |
| [Support Policy](docs/support.md) | What is covered, what is not, and honest response expectations |
| [Versioning & Release Policy](docs/versioning.md) | Version numbers, breaking changes, deprecation, upgrades |
| [Compatibility Policy](docs/compatibility.md) | What is declared vs actually tested |
| [Security Reporting](docs/security.md) | Reporting a vulnerability |
| [Development](docs/development.md) | First run, daily loop, module recipe, module generator — the main developer guide |
| [Architecture](docs/architecture.md) | System architecture and design decisions |
| [Engineering Standards](docs/engineering-standards.md) | Mandatory coding rules and patterns |
| [API Conventions](docs/api-conventions.md) | REST contract, error format, versioning |
| [Authentication](docs/auth.md) | Authentication contract and HTTP behavior |
| [Authorization](docs/authorization.md) | RBAC model, guards, policies |
| [Migrations](docs/migrations.md) | Database migration guidelines |
| [Deployment](docs/deployment.md) | Deployment guidance and platform examples |
| [Observability](docs/observability.md) | Metrics, Prometheus scrape config, Grafana dashboard |
| [Reference Module](docs/reference-module.md) | How to build a module: the canonical `notes` walkthrough |
| [Error Handling](docs/error-handling.md) | Problem Details contract, status policy, error codes |
| [Production Logging](docs/production-logging.md) | Logging, redaction, security events — operations guide |
| [Transport Security](docs/transport-security.md) | TLS boundary, HSTS policy, Secure-cookie contract |
| [Release Contract](docs/release-contract.md) | What a release is: mandatory gates, version/package contract, artifacts |
| [Backup & Recovery](docs/backup-recovery.md) | Database backup and recovery procedure |
| [Rollback & Recovery](docs/rollback-recovery.md) | Rollback decisions and incident recovery strategy |

> Internal milestone reports and audit records are **not** user documentation and are excluded from the distribution package.

### Architecture Decision Records

| ADR | Topic |
|-----|-------|
| [ADR-001](docs/adr/001-authentication.md) | Authentication foundation (JWT, bcrypt, cookies) |
| [ADR-002](docs/adr/002-authorization.md) | Authorization foundation (RBAC, guards, policies) |
| [ADR-003](docs/adr/003-redis.md) | Redis client (ioredis, optional infrastructure) |
| [ADR-005](docs/adr/005-global-error-handler.md) | Global error handler (500 sanitization) |
| [ADR-006](docs/adr/006-transaction-boundaries.md) | Transaction boundary ownership |
| [ADR-007](docs/adr/007-connection-policy.md) | Database connection policy (pool, timeouts, TLS) |
| [ADR-008](docs/adr/008-authentication-session-architecture.md) | Authentication session architecture |
| [ADR-009](docs/adr/009-login-throttle-storage.md) | Login throttle storage design |
| [ADR-010](docs/adr/010-account-lockout-policy.md) | Account lockout policy |
| [ADR-011](docs/adr/011-security-notifications.md) | Security notification policy |
| [ADR-012](docs/adr/012-csrf-strategy.md) | CSRF strategy |
| [ADR-013](docs/adr/013-api-documentation.md) | API documentation generation (OpenAPI document + Swagger UI) |
| [ADR-014](docs/adr/014-api-versioning-deprecation-policy.md) | API versioning, compatibility, and deprecation policy |

ADR-004 was never issued (numbering gap in the original series).

---

## V1 Scope

V1 establishes the foundational platform required for future business modules: application lifecycle, validated configuration, database access with migrations, JWT authentication with persistent sessions and throttling/lockout, RBAC authorization, a frozen six-field Problem Details error system, a versioned `/api/v1` REST contract with generated OpenAPI 3.1, validated pagination/sorting/filtering primitives, structured logging with redaction and security events, health probes, an automated 16-rule architecture checker, CI plus release gates, Docker production image with healthcheck, and a frozen email subsystem (provider boundary, SMTP transport, authentication wiring, typed templates).

V1 is not a complete application. It is a baseline with a defined contract, an audited codebase, and a clear extension model — start with [docs/development.md](docs/development.md).

---

## Deferred / V2 Scope

The following capabilities are documented as future work. They are not implemented in V1 and are not missing requirements — they are planned extensions of the V1 foundation.

**Authentication:** CSRF protection, durable notification delivery (outbox/worker/retry), password change, MFA/TOTP/WebAuthn, lockout administration, suspicious-login detection, public session-management endpoints.

**Authorization:** Multiple roles per user, role administration CRUD, permission caching, audit logging of authorization decisions.

**Platform:** Full Redis integration (sessions, rate limiting, caching), distributed rate limiting (login throttling implemented with PostgreSQL).

**Email:** Durable delivery, delivery tracking, bounces, marketing mail, localization, template CMS, customer branding, additional providers.

**Observability:** Production backends (Sentry, OpenTelemetry collectors, metrics stores), customer log storage and SIEM.

**Infrastructure:** Image scanning, dev/prod Compose profiles, deployment automation.

---

## Security

V1 implements the following security practices:

- Passwords hashed with bcrypt (cost 12), never logged, never returned in responses
- JWT secret is required with no insecure default
- Access tokens expire after 15 minutes; refresh tokens expire after 7 days server-side
- Raw refresh credentials never persisted (SHA-256 hash only), never logged, never in response bodies
- Cookie flags: HttpOnly, SameSite Strict, Secure in production
- Generic credential errors prevent user enumeration
- Production cookie authentication blocked until CSRF protection exists
- Authorization derived from server-side role lookup, never client data
- Deny-by-default authorization model
- Unknown request properties rejected (`additionalProperties: false`)
- Centralized secrets via config layer (no scattered `process.env`)
- Always-on security headers (`x-content-type-options`, `referrer-policy`, `x-frame-options`, `permissions-policy`)
- Strict opt-in CORS (disabled unless `CORS_ALLOWED_ORIGINS` configures an exact-match allowlist; credentials never enabled)
- Explicit transport limits (1 MiB body cap, 100-char route-param cap, centralized in frozen config)

**Not yet implemented:** general rate limiting (login throttling implemented, recovery throttling), production cookie enablement (future session-architecture decision per ADR-012). CSP remains intentionally absent (JSON API with no browser-rendered content, decision). Transport security — HTTPS/TLS-termination contract, edge-owned HSTS policy, no-trust proxy policy, Secure-cookie contract — is documented normatively in [docs/transport-security.md](docs/transport-security.md). Supply-chain automation — dependency audit, secret scanning, SAST, SBOM, CI gates, release validation — is implemented (see Supply-Chain Security Gates above).

For security architecture details, see [docs/architecture.md](docs/architecture.md) sections 12, 13, and 21.

---

## License

Oxyide Forge is free and open-source software released under the MIT License. See `LICENSE.txt` for the complete license terms. The MIT License permits use, modification, distribution, and commercial use, subject to its notice and disclaimer conditions.

**Official website:** https://www.oxyide.com/

---

## V1 Baseline

V1 is the audited foundational baseline for Oxyide Forge. The `/api/v1` contract is stable and governed by [docs/api-conventions.md §2](docs/api-conventions.md): compatible evolution happens inside `v1`, breaking changes require a new major API version, and `operationId` values are contractual. Deprecation is declared on the route, signalled through standard HTTP headers and the OpenAPI document, and never changes runtime behaviour. Package releases do not imply API versions; the two evolve independently.

---

**Built with Fastify, Prisma, and PostgreSQL.**
