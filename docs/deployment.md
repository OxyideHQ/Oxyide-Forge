# Oxyide Forge v1.0.0 — Deployment Guide

This document describes the production deployment procedure for Oxyide Forge v1.0.0.

## Production deployment workflow

One authoritative sequence. Each phase owns exactly one responsibility —
no phase silently performs another's. Failure at any gated step stops the
deployment; see Failure Behavior below.

```text
1.  Validate the release artifact ............ `node scripts/release-validate.cjs --tag vX.Y.Z` (Release Contract §2)
2.  Build .................................... `npm ci` then `npm run build` → `dist/` (Build below)
3.  Validate configuration ................... fail-fast Zod validation on startup; production requires
    `DATABASE_URL` (with `sslmode=require`), `JWT_SECRET` (≥ 32 chars),
    `APP_BASE_URL` (`https://`) (Configuration below)
4.  Verify database reachability ............. operator checks `DATABASE_URL` target + TLS before migrating
5.  Confirm backup/recovery prerequisite ..... verified backup exists where the operation requires one
    (Database Backups below; procedure in docs/backup-recovery.md)
6.  Run migrations ........................... `npx prisma migrate deploy` (Database below; full procedure in
    docs/migrations.md) — a separate operator command, never application startup
7.  Require clean migration status ........... `npx prisma migrate status` must report up to date (gate)
8.  Deploy + start the application ............ `node dist/main.js` with runtime-supplied environment (Start below)
9.  Verify liveness .......................... `GET /health/live` → `200 {}` (Health Verification below)
10. Verify readiness .......................... `GET /health/ready` → `200 {}`; `503 {}` means a dependency is
    unusable or shutdown is in progress — deployment is NOT successful
11. Run safe smoke verification ............... health endpoints plus one affected application path; never
    destructive, never creates customer data to prove deployment
12. Declare success ........................... only when every gate above holds
```

`docker-compose.yml` is a local verification stack for this sequence, not a
production orchestrator definition. `npm start` performs steps 8–10 only:
it never migrates, seeds, validates releases, or installs packages.

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 20.19.0 | LTS recommended (20.19 is the floor for the built-in `--env-file` support `npm run dev` relies on) |
| npm | bundled with Node.js | 9.x or 10.x both work (engines constrain only Node.js) |
| PostgreSQL | 17+ | Required for database |
| Redis | 7+ | Optional (application runs without it) |

---

## Installation

```bash
# 1. Clone the repository
git clone <repository-url>
cd oxyide-forge

# 2. Install dependencies (uses lockfile for reproducible installs)
npm ci

# 3. Configure environment (see Configuration below)
cp .env.example .env
# Edit .env with your production values
```

---

## Configuration

Create a `.env` file in the project root with the following variables:

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string (required) | `postgresql://user:pass@localhost:5432/oxyide_prod` |
| `JWT_SECRET` | HS256 signing secret, minimum 32 characters (required) | `your-32-char-minimum-secret-here` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `3000` | Port number |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` |
| `REDIS_URL` | (unset) | `redis://` or `rediss://` URL for optional Redis. Never set to an empty string — `""` is a startup error, not "disabled" |
| `APP_BASE_URL` | `http://localhost:3000` | Public base URL for absolute links; production **requires** `https://`. Also used as the OpenAPI `servers` entry and as the sender domain (`no-reply@<host>`) |
| `CORS_ALLOWED_ORIGINS` | (unset = CORS fully disabled) | Comma-separated bare `http(s)://host[:port]` origins, exact match, no wildcards |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURITY` | (all unset = NoOp email) | One coherent group enabling SMTP delivery; see `.env.example` for the coherence rules. Absent = authentication flows run normally with no email leaving the process |
| `OPENAPI_ENABLED` | `true` | Serve the OpenAPI 3.1 document at `/openapi.json` |
| `SWAGGER_UI_ENABLED` | `false` in production, `true` otherwise | Serve Swagger UI at `/docs` |

**Security notes:**
- `JWT_SECRET` must be at least 32 characters for HS256 security
- `DATABASE_URL` must use `postgresql://` or `postgres://` protocol
- `REDIS_URL` must use `redis://` or `rediss://` protocol if set
- Never commit `.env` to version control (it is gitignored)
- Use a strong random value for `JWT_SECRET` in production (e.g., `openssl rand -base64 32`)
- `OPENAPI_ENABLED` and `SWAGGER_UI_ENABLED` accept only the exact literals `true`/`false`; anything else (`1`, `yes`, `TRUE`) fails startup
- `SWAGGER_UI_ENABLED=true` with `OPENAPI_ENABLED=false` is rejected: the UI has no document to render
- The published document contains no secrets; `/openapi.json` is safe to expose, while `/docs` is a developer interface that should stay disabled in production (set `SWAGGER_UI_ENABLED=false`) unless intentionally published

---

## Database

### Prisma Commands

```bash
# Generate Prisma Client (after install or schema changes)
npx prisma generate

# Validate schema
npx prisma validate

# Apply pending migrations (PRODUCTION)
npx prisma migrate deploy

# Create new migration (DEVELOPMENT only)
npx prisma migrate dev --name <name>

# Open Prisma Studio (development)
npx prisma studio

# Run the idempotent seed entry point (DEVELOPMENT/TEST only; refused in production)
npm run db:seed
```

### Migration Procedure

Migration files under `prisma/migrations/` are the source of truth for the
database schema. The application never runs migrations automatically; every
schema change is an explicit operator command. The complete migration
operating procedure — creation, review, status, verification, failure
handling, drift, reconciliation, and test safety — lives in
[docs/migrations.md](migrations.md); this section states only what production
deployment needs inline.

**Production:**
```bash
npx prisma migrate deploy
```

**Development (never production):**
```bash
npx prisma migrate dev --name <migration_name>
```

**Verify migration state (gate):**
```bash
npx prisma migrate status
```

Exit 0 with "Database schema is up to date!" means every repository migration
is applied. Any other result — pending migrations, a failed migration, an
unverifiable history, or an unreachable database — is a failure: deployment
must NOT continue as if migration succeeded. Note the boundary documented in
[docs/migrations.md](migrations.md): status verifies migration *history*,
not physical schema correctness.

**Prohibited in production:** `prisma migrate dev`, `prisma db push`,
`prisma migrate reset`, manual `_prisma_migrations` edits, and production
seed execution. `migrate resolve` is exceptional operator-only recovery, never
a deployment step.

**Deployment order:**
1. Review migration files (checklist in [docs/migrations.md](migrations.md)).
2. Back up the production database.
3. Run `prisma migrate deploy`.
4. Run `prisma migrate status` and require a clean result.
5. Start/continue the application deployment.
6. Verify health endpoints and one affected application path.

The current migrations are purely additive, so migrate-then-start is safe.
Future destructive or breaking schema changes require expand/contract
discipline (strategy defined in `docs/migrations.md`; execution gated per
that strategy, not implemented as automation here). There is no automatic
rollback; recovery is forward-fix or deliberate resolve per
[docs/migrations.md](migrations.md).

### Seed

- `npm run db:seed` is explicit and never runs on application startup; seed is not part of deployment.
- Safe to repeat; performs no destructive operations and deletes nothing.
- Disabled in production. Verify `DATABASE_URL` targets the intended database before running.

### Schema

The database has eight models:

- **User** — `id`, `email` (unique), `displayName`, `status`, `role`, timestamps
- **Credential** — `id`, `userId` (unique FK → User), `passwordHash`, timestamps
- **Session / RefreshToken** — persistent refresh sessions with rotation state
- **PasswordResetToken / EmailVerificationToken** — opaque single-use credentials (SHA-256 hash persisted)
- **LoginThrottle** — PostgreSQL-backed fixed-window throttle counters
- **Note** — user-owned example resource (`User 1:N Note`)

Key relationships: `User 1:1 Credential`, `User 1:N Session`, `User 1:N Note`.

### Database Backups

Take a verified backup before any production migration. The full backup and
recovery procedure — objectives, RPO/RTO planning, retention, storage,
encryption, verification, restore testing, disaster scenarios, and the
`scripts/db-backup.cjs` operator tool — lives in
[docs/backup-recovery.md](backup-recovery.md). Backups are never automatic;
scheduling and storage remain operator responsibilities.

### Connection management

Connection behavior is configured through `DATABASE_URL` query parameters —
the native Prisma/PostgreSQL mechanism. There is intentionally no parallel set
of environment variables. All values below are validated at startup; invalid
configuration fails fast before the application starts.

| Parameter | Meaning | Rule |
|---|---|---|
| `connection_limit` | Max pooled connections per application instance | Positive integer (≥ 1), at most once; omit to use the Prisma default |
| `pool_timeout` | Seconds a request waits for a free pooled connection | Positive integer seconds (≥ 1), at most once; omit for the Prisma default (10s) |
| `connect_timeout` | Seconds allowed to establish a new connection | Positive integer seconds (≥ 1), at most once; omit for the Prisma default (5s) |
| `sslmode` | TLS policy | `require` or `disable` only, at most once |

Defaults are Prisma-documented (pool size scales with CPU count; timeouts as
above). A value of `0`, a negative, a decimal, a non-numeric value, or a
duplicated parameter is rejected. Unknown parameters are silently ignored by
Prisma — never rely on an unlisted parameter (there is no client-side idle
timeout knob; idle handling belongs to the PostgreSQL/network layer).

**Connection budgeting:** size the pool from the server, not from optimism.
Effective application ceiling ≈ `instances × connection_limit`, and that
ceiling must leave headroom:

| Consumer | Budget source |
|---|---|
| Application instances | `N × connection_limit` (explicit per-instance cap) |
| Migrations / admin / monitoring | Operator-reserved headroom outside the application ceiling |
| PostgreSQL `max_connections` | Operator-owned; the application cannot read it and never assumes it |

Example (illustrative, not a default): `max_connections = 100` with
2 instances × `connection_limit = 20` leaves 60 connections for migrations,
monitoring, and maintenance. Scaling replicas without revisiting this budget
exhausts PostgreSQL. Pool size is a capacity control, not a performance
guarantee: high HTTP concurrency does not need one database connection per
request — excess requests wait bounded by `pool_timeout` instead.

**Timeout semantics (distinct failures, distinct settings):**
- Pool acquisition timeout (`pool_timeout`): all pooled connections busy.
 The waiter fails deterministically (`P2024`) instead of hanging; the failure
 carries no credentials and the pool recovers for the next request.
- Connection establishment timeout (`connect_timeout`): unreachable or
 unresponsive host fails fast instead of hanging startup or readiness.
- These are different from statement timeouts and TLS failures; one setting
 does not cover the others.

**TLS policy:**

| Environment | Rule |
|---|---|
| Production | `sslmode=require` is mandatory and enforced by configuration startup validation — a production `DATABASE_URL` without it fails to start |
| Development / test | `sslmode` may be absent or `disable`; `require` is accepted |

Certificate verification modes (`verify-ca`, `verify-full`) and unknown modes
are silently ignored by Prisma 6.12.0 — they provide no verification. Do not
use them expecting verification; the enforced production contract is
encryption via `require`. No CA bundle is shipped in this repository.

**Exhaustion and shutdown:** the pool never grows beyond `connection_limit`;
exhaustion surfaces as bounded `P2024` errors while the application stays up.
There is exactly one production `PrismaClient`; repositories and services share
it and never construct their own. `SIGINT`/`SIGTERM` close Fastify first, then
disconnect Prisma; disconnect errors are logged, never hidden, and shutdown
never waits indefinitely on broken dependencies.

**PgBouncer assessment:** not required for this architecture (single modest
pool, no session-state usage found in the codebase — no advisory locks,
`LISTEN`/`NOTIFY`, session variables, temp tables, or background workers; the
only multi-statement server interactions are the two service-owned
`$transaction` blocks). Compatible future path, if ever needed: transaction
pooling mode with `pgbouncer=true` (disables prepared-statement caching),
migrations run against a direct connection, and the above pool/timeout policy
still applies per application instance. No PgBouncer service, config, or
dependency is introduced here.

---

## Build

```bash
# Production TypeScript build
npm run build
```

Output is written to `dist/` with entry point `dist/main.js`.

---

## Start

```bash
# Production start
node dist/main.js
```

The server listens on the configured `HOST` (default `0.0.0.0`) and `PORT` (default `3000`).

**Configuration source:** production reads the process environment only — `npm start`/`node dist/main.js` deliberately does **not** load a `.env` file, so container and platform configuration stays authoritative and a stray file on the host cannot override injected secrets. (`npm run dev` is the only script that loads `.env`, via Node's built-in `--env-file-if-exists`.)

---

## Running the container directly (`docker run`)

> **A running container is not a usable application.** This section is the requirement, not a warning you can skip. It was verified by running the published image; the observed behaviour is quoted below.

### What the image does and does not do

| Behaviour | Reality |
|---|---|
| Default environment | The image sets `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000` |
| Starts the app immediately | **Yes.** There is no wait loop and no entrypoint script |
| Requires PostgreSQL to start | **No.** Prisma connects lazily, so an unreachable database does **not** stop startup |
| Runs migrations | **No.** The container never migrates. Run `npx prisma migrate deploy` as a separate step |
| Exposes its port | **Immediately**, before readiness |
| Gates traffic on readiness | **No.** Docker does not wait, and it does not know what readiness means |

### Observed behaviour (verified on the built image)

With a reachable port but an unreachable database, and otherwise valid production configuration:

```
container state : running          <-- for the entire time
/health/live    : 200
/health/ready   : 503
docker health   : unhealthy        <-- only after ~2 minutes
app log         : {"msg":"Readiness check failed","dependencies":["postgresql"]}
```

With the same image and a reachable database, `/health/ready` returns `200`.

Two separate signals, often confused:

| Signal | Meaning | Use it for |
|---|---|---|
| Container `running` | The process started. Says nothing about usefulness | Nothing — never route traffic on this |
| Docker `healthy` | The image's own `HEALTHCHECK` last polled `/health/ready` successfully | A coarse, slow signal (~2 min to flip, see below) |
| `/health/live` `200` | The process can serve requests | Deciding whether to **restart** the process |
| `/health/ready` `200` | Dependencies are usable and it is not draining | Deciding whether to **route traffic** |

**The image's `HEALTHCHECK` uses `start-period=20s`, `interval=30s`, `retries=3`.** In the observed run it took roughly **two minutes** of a failing database before Docker marked the container `unhealthy`. That is far too slow to be your traffic gate — it is a liveness backstop, not a readiness mechanism.

### Gate traffic on `/health/ready`, never on container state

Docker exposes the port the moment the process binds it. If something routes traffic on "container started", it will send requests to an application that answers `503`.

```bash
# Gate on readiness explicitly. Poll /health/ready, not the container state.
docker run -d --name forge \
  -e DATABASE_URL='postgresql://user:pass@host:5432/db?sslmode=require' \
  -e JWT_SECRET="$(openssl rand -base64 48)" \
  -e APP_BASE_URL='https://api.example.com' \
  -p 3000:3000 oxyide-forge:latest

until [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health/ready)" = "200" ]; do
  sleep 1
done
echo "ready — safe to route traffic"
```

- **Orchestrators:** point the readiness/liveness probes at `/health/ready` and `/health/live` respectively. Both platform examples in this repository do exactly this.
- **Docker Compose:** use `depends_on: condition: service_healthy` for the database, as `docker-compose.yml` does.
- **Deployment tools:** most gate on "container started" by default. Override that.

### The container is running but readiness fails

1. Read what is actually unready — the log names the dependency:
   ```bash
   docker logs forge 2>&1 | grep -i 'Readiness check failed'
   # {"msg":"Readiness check failed","dependencies":["postgresql"]}
   ```
2. Confirm reachability **from inside the container's network**, not from your laptop:
   ```bash
   docker exec forge node -e "require('net').connect({host:'db-host',port:5432}).on('connect',()=>{console.log('ok');process.exit(0)}).on('error',e=>{console.error(e.message);process.exit(1)})"
   ```
3. Remember the two addresses trap: from the host a local database is `127.0.0.1:5433`; **inside the Compose network it is `postgres:5432`**. `127.0.0.1` inside the app container is the app container itself.
4. If configuration is wrong, the container will not reach this stage at all — an invalid `DATABASE_URL`/`APP_BASE_URL` under `NODE_ENV=production` fails at startup with a named field.

**Never "fix" an un-ready container with `prisma migrate reset` or `prisma migrate dev`.** Those destroy data. Use `npx prisma migrate deploy` to apply pending migrations; for a bad migration take a backup and follow [Rollback & Recovery](rollback-recovery.md).

### Configuration checklist for `docker run`

| Variable | Requirement in the image (production default) |
|---|---|
| `DATABASE_URL` | Required. `postgresql://` **and** must include `sslmode=require` in production |
| `JWT_SECRET` | Required, ≥ 32 characters. No default — generate one |
| `APP_BASE_URL` | Required in effect — must be `https://` in production |
| `HOST` | `0.0.0.0` (image default). `localhost` binds inside the container and is unreachable from outside |
| `PORT` | `3000` (image default) |
| `NODE_ENV` | `production` (image default) — applies the strictest gates |

Apply migrations as a **separate step before** starting the container:

```bash
npx prisma migrate deploy
```

---

## Health Verification

Once running, verify the application:

```bash
# Liveness check
curl http://localhost:3000/health/live

# Readiness check
curl http://localhost:3000/health/ready
```

Both endpoints return `200 {}` on success.

**Note:** `/health/live` reports process availability only and never depends on a database or cache. `/health/ready` additionally verifies that required and configured dependencies are usable, returning `503` when one is not.

**PostgreSQL is required.** If it is unusable the instance cannot serve traffic and readiness reports `503`.

**Redis is optional** and behaves differently depending on configuration:

| `REDIS_URL` | Startup | `/health/live` | `/health/ready` |
|---|---|---|---|
| unset | normal | `200` | unaffected by Redis |
| set, Redis reachable | normal | `200` | `200` |
| set, Redis unreachable | **continues running** | `200` | `503` |

An unreachable Redis does **not** stop the process from starting — that was changed deliberately in (see ADR-003). Failing startup would have made the instance unreachable rather than reporting it as not ready, and a cache outage would have taken down auth, users, roles and notes, none of which use Redis. The instance stays in the load balancer's view as "not ready" and rejoins automatically once Redis recovers, with no restart.

If you prefer strict fail-fast behavior for a genuinely required Redis, do not configure Redis as optional infrastructure — the current contract treats it as a cache. An **invalid** `REDIS_URL` (wrong protocol, malformed, or empty) is still rejected at startup; only an unreachable but valid server is tolerated.

Neither probe reveals *why* it failed. The response body is always `{}` and the status code is the entire signal, so no host, credential, version, dependency state, or driver error is ever exposed on these unauthenticated endpoints. Operators read the reason from the correlated structured log line (`Readiness check failed`, carrying only the failing dependency names) and correlate it with the `X-Request-ID` echoed on every response.

Probe latency is bounded by your `DATABASE_URL` connection parameters (`connect_timeout`, `pool_timeout`), which this project validates and honors. Forge adds no second timeout. Set `connect_timeout` below your orchestrator's probe `timeoutSeconds` (commonly `1`), otherwise a blackholed database can outlast the probe and the instance may be restarted while it is only un-ready.

### Container image and health check

`Dockerfile` builds a two-stage image: TypeScript is compiled with dev dependencies present, and the runtime stage carries only production dependencies, compiled output, and `prisma/`. It runs as the unprivileged `node` user and **installs no packages** — Alpine's busybox already provides `wget`.

**The health check probes `/health/ready`, not `/health/live`.** Readiness answers *"can this instance serve traffic?"*, which is exactly what a container health status should mean. Liveness answers *"is the process alive?"*; a container-health check on liveness would report a database outage as a **process** fault and invite a restart that fixes nothing while PostgreSQL remains down. Dependency health here is both observable *and* recoverable, so it belongs in the container health check.

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
 CMD wget -q -T 4 -t 1 -O /dev/null "http://127.0.0.1:${PORT:-3000}/health/ready" || exit 1
```

| Property | Why |
|---|---|
| `127.0.0.1` | Stays inside the container. No host networking, no DNS, no external service, no dependency on the public base URL. |
| `${PORT:-3000}` | The container's **actual** listening port. A hardcoded `3000` would silently probe the wrong port if the operator remapped it. |
| `busybox wget`, already present | No `apk add`, no new package, no extra CVE surface purely for healthchecking. |
| `\|\| exit 1` | Fails on any non-2xx — the required failure behavior, and it recovers automatically on the next success. |
| no credentials | The command contains no URL, token, password, or environment variable name. |

#### Timing, and why these values

| Value | Reasoning |
|---|---|
| `--start-period=20s` | Measured application startup on the reference host is **2.4–2.9s** (boot → listener open → `/health/ready` returning `200`). A cold PostgreSQL container adds first-boot initialization on top. 20s clears both with margin, so a normal cold start is never counted as unhealthy. Failures inside this window do not consume retries. |
| `--interval=30s` | Doubling to 15s would double the two lifecycle log lines every probe — worsening the accepted probe log-volume finding for no operational gain. 30s keeps the signal cheap. |
| `--timeout=5s` | Comfortably above a healthy probe (sub-millisecond) and below Docker's default, so a blackholed database yields a timed-out check rather than a hung one. |
| probe budget `-T 4` | Strictly inside the 5s check timeout — otherwise a slow probe could outlive its own check and checks would pile up. |
| `--retries=3` | Tolerates a brief blip; a sustained outage still surfaces. Time to unhealthy = 20s + 3×30s ≈ **110s**. |

#### Bringing the stack up

The bundled database is reached at **two different addresses** depending on
where the command runs. Using the wrong one is the single most common cause of
"`P1001` can't reach database server" against this stack:

| Where it runs | Address | Used by |
|---|---|---|
| Host (your shell) | `127.0.0.1:5433` (published port; override with `POSTGRES_HOST_PORT`) | `psql`, `npx prisma migrate deploy`, `npm test` |
| Inside the compose network | `postgres:5432` (service name) | the `app` container |

`127.0.0.1` inside a container is that container itself, never the database. The
compose file publishes `5433` specifically so host-side tooling works without
colliding with a host PostgreSQL on `5432`.

```bash
# 1. Secrets required by the stack.
export POSTGRES_PASSWORD='<a local development password>'

# 2. Configuration for HOST-side commands (matches .env.example).
cp .env.example .env
# set JWT_SECRET (>= 32 chars); DATABASE_URL may stay 127.0.0.1:5433

# 3. Configuration for the APPLICATION container — it must use the network host.
# Compose reads.env for interpolation, so export the container-side value:
export DATABASE_URL="postgresql://forge:${POSTGRES_PASSWORD}@postgres:5432/oxyide_starter"

# 4. Bring the stack up.
docker compose up --build
docker compose ps # watch the app reach "healthy"
```

If your `DATABASE_URL` already points at an external PostgreSQL, delete the
`postgres` service and its `depends_on` entry, and skip steps 1 and 3.

`docker-compose.yml` is a **verification** stack, not a production orchestrator definition. Notes:

- **No credential literals.** Every secret is interpolated from your environment, and required ones use `${VAR:?message}` so a missing value fails loudly instead of starting with a guess.
- **PostgreSQL readiness gates the application** via `depends_on: condition: service_healthy`. Without it the app comes up first and correctly reports `503` until the database finishes initializing — accurate, but a false alarm on every cold start.
- **Do not default `REDIS_URL`.** `${REDIS_URL:-}` expands to an *empty string*, and validated configuration treats `REDIS_URL=""` as an error rather than as "not configured" — the container would refuse to start for anyone without Redis. Enable Redis through an override file instead.
- **The database is reachable at two addresses** (`127.0.0.1:5433` on the host, `postgres:5432` inside the network). `127.0.0.1` in the app container is the app container itself, which is why the compose quick start previously never became ready. See "Bringing the stack up" above.
- **PostgreSQL 17** is what this stack runs, matching the documented minimum. It previously pinned `postgres:16-alpine`, below the stated minimum.
- **`init: true` and `stop_grace_period: 30s`** forward `SIGTERM` to Node as PID 1 so the graceful-shutdown path runs. Without an init, a container stop would `SIGKILL` the process and skip draining entirely.
- The image's own `HEALTHCHECK` applies; compose does not override it, so the verified definition is the one that runs.

#### Verifying the deployment contract without Docker

```bash
npm run verify:deployment
```

`scripts/verify-deployment.cjs` checks the healthcheck definition statically (endpoint, port source, loopback-only, timing, no credentials, build-context exclusions, compose wiring) and then drives the **real** lifecycle over real HTTP: it boots the compiled server, waits for healthy, severs the PostgreSQL connection (a local TCP proxy in front of the real database, whose sockets are destroyed), asserts `503` while `/health/live` stays `200`, restores the connection, asserts `200` again **without restarting the process**, sends `SIGTERM`, and confirms a clean exit and that a repeated signal is safe.

This is the substitute for `docker build` on hosts without a Docker daemon: it verifies the same application-side contract the health check depends on. **It does not verify the image itself** — no build, no layer contents, no registry push. Run `docker build` where a daemon is available.

#### Dependency failure and recovery

| Event | `/health/live` | `/health/ready` | Docker health |
|---|---|---|---|
| Running, dependencies healthy | `200` | `200` | healthy |
| PostgreSQL unreachable | `200` | `503` | unhealthy after ~110s |
| PostgreSQL restored | `200` | `200` | healthy again — **no restart** |
| Shutting down | `503` | `503` | unhealthy (expected) |

Recovery needs no restart: PostgreSQL reconnects on its own and the next probe observes it.

### Graceful shutdown and probes

On `SIGTERM`/`SIGINT` the instance stops reporting ready immediately, so a load balancer withdraws it before the socket disappears:

1. **Shutdown begins** — `preClose` marks the instance draining. Readiness answers `503`. An in-flight probe that already reached the application is refused rather than told everything is fine.
2. **The listener stops accepting connections.** From this moment Fastify itself answers any straggler request with a bare `503`, on **every** route including `/health/live`. That short window is the framework's load-shedding behavior and carries no dependency, credential, or host detail.
3. **The server closes**, then PostgreSQL and Redis disconnect, then the process exits.

Operational guidance:

- Allow in-flight requests to finish before your orchestrator escalates to `SIGKILL`; draining does not cancel work already running.
- During termination, do not treat a failing `/health/live` as a fault. A terminating instance is expected to stop answering, and acting on liveness at that point can force-kill requests that were still completing. Restart decisions belong to `/health/live` while the instance is **running**, not while it is terminating.
- If you probe from outside the cluster, expect `503` (not a connection error) for the short interval between shutdown starting and the socket closing.
- `close` is idempotent, so a repeated shutdown signal is safe and does not fail the sequence.

### Probe roles

The two probes have distinct, frozen roles. Configure them accordingly:

| Probe | Question it answers | Orchestrator use |
| --- | --- | --- |
| `GET /health/live` | Is this process alive? | Restart the container when it fails. |
| `GET /health/ready` | Can this instance serve traffic? | Add/remove the instance from the load balancer. |

`/health/live` must never gain a dependency check — a database outage must not cause a restart loop. Both probes are public and unauthenticated, and both return an empty body by design; the status code is the entire signal, so neither exposes dependency state, versions, or host information. Operator detail belongs in the correlated structured logs, keyed by the `X-Request-ID` echoed on every response.

In the current release the two probes answer differently while the instance is running: liveness answers `200 {}` and never consults a dependency, while readiness answers `200 {}` or `503 {}` depending on dependency health and shutdown state. Configure them for these roles. (During the brief Fastify-owned drain window after `close` begins, Fastify itself answers `503` on every route including `/health/live` — see "Graceful shutdown and probes" below. That is framework termination behavior, not a liveness finding.)

## API Documentation Verification

If documentation exposure is enabled:

```bash
# Machine-readable OpenAPI 3.1 document
curl http://localhost:3000/openapi.json

# Swagger UI (developer-facing; off by default in production)
curl -I http://localhost:3000/docs
```

Both routes live outside `/api/v1`. With `SWAGGER_UI_ENABLED=false`, `/openapi.json` still serves and `/docs` returns `404`.

---

## Shutdown

The application handles graceful shutdown on:

- `SIGINT` (Ctrl+C)
- `SIGTERM` (container orchestration)

On shutdown:
1. Fastify closes HTTP connections
2. Redis client disconnects (if configured)
3. Prisma client disconnects
4. Signal listeners are cleaned up

---

## Logs

Logs are written to **stdout** as structured JSON via Pino.

Example log entry:
```json
{
 "level": 30,
 "time": 1789983918549,
 "msg": "incoming request",
 "reqId": "req-1",
 "req": { "method": "POST", "url": "/api/v1/auth/register", "remoteAddress": "127.0.0.1" }
}
```

Request logs carry method, path (query string stripped), source IP, status code, duration, and request ID only — never headers, cookies, bodies, query strings, or user-agents. Error logs carry an allowlisted type/message/stack/code shape. Secret fields are redacted centrally (`[Redacted]`) as a fail-safe net. See `src/shared/logging/` and `docs/production-logging.md`.

Log level is controlled by `LOG_LEVEL` environment variable (default: `info`).

---

## Failure Behavior

| Scenario | Behavior |
|----------|----------|
| Missing/invalid `DATABASE_URL` | Startup fails immediately with validation error, exit code 1 |
| Missing/invalid `JWT_SECRET` | Startup fails immediately with validation error, exit code 1 |
| PostgreSQL unavailable at startup | Application starts (Prisma connects lazily); database-backed requests fail with 500 |
| PostgreSQL becomes unavailable at runtime | Requests fail with 500; application does not crash |
| Invalid `JWT_SECRET` | Startup fails (must be ≥32 chars) |
| Redis unavailable (when configured) | Startup continues; `/health/ready` reports `503` until Redis recovers |
| Redis unavailable (not configured) | Application runs normally; Redis features skipped |
| Migration failure | `prisma migrate deploy` fails with error; STOP and follow `docs/rollback-recovery.md` (no blind retry, no automatic rollback) |

**Startup failure is preferable to running in an unsafe configuration.**

### Recovery checkpoints

Each checkpoint states what is known, what can still be safely reversed,
and what must never be done. Decisions between compatible application
rollback, forward-fix, and verified restore belong to
[docs/rollback-recovery.md](rollback-recovery.md); migration failure
handling belongs to [docs/migrations.md](migrations.md). This section
only maps those procedures onto the deployment workflow above.

| Checkpoint | Known | Still safely reversible | Recovery action | Forbidden |
|---|---|---|---|---|
| CP1 Artifact validated | release contents + version reviewed | everything (nothing deployed) | do not deploy | deploying an unvalidated artifact |
| CP2 Config valid, DB reachable, backup prerequisite confirmed | target + TLS + history state understood | everything (nothing mutated) | fix config / restore DB availability / take backup | migrating before the backup prerequisite holds |
| CP3 Migration completed | `migrate deploy` exit 0 | application choice (schema is additive-only today; old artifacts stay compatible) | proceed to deploy, or hold | assuming an old artifact is compatible without checking |
| CP4 Migration failed | failure output + `migrate status` state | nothing automatically — state must be inspected first | STOP → classify per `docs/migrations.md` failure procedure | blind retry, silent repair, history edits, automatic rollback |
| CP5 Application started | process alive, config valid | application choice (stop/replace artifact) | stop rollout, preserve logs | claiming success from "process started" alone |
| CP6 Liveness healthy | `/health/live` 200 | application choice | continue verification | treating liveness as traffic-readiness |
| CP7 Readiness healthy | `/health/ready` 200, deps usable | application choice | proceed to smoke check | routing traffic on 503 |
| CP8 Smoke passed | affected paths behave | application choice within the compatibility window | declare success | creating customer data to prove deployment |
| CP9 Deployment accepted | all gates held simultaneously | forward-fix only (history is immutable) | monitor; file post-deploy evidence | editing migration history to hide failure |

Application rollback (redeploying a previous validated artifact) is safe
only while the old artifact is compatible with the **current** database
state — rolling back code never rolls back data. There is no automatic
rollback and no automatic restore anywhere in this workflow; every
destructive action is an explicit, human-approved operator step.

### Failure/recovery matrix

| Failure | Recovery | Checkpoint |
|---|---|---|
| Artifact validation failure | Do not deploy; fix the tree, re-validate | CP1 |
| Config validation failure | Correct config (never weaken it); redeploy | CP2 |
| DB unavailable before migration | Restore DB availability; retry deployment | CP2 |
| Backup prerequisite unavailable | Do not continue where backup is mandatory | CP2 |
| Migration fails before completion | STOP → `docs/migrations.md` failure procedure; inspect state first | CP4 |
| Migration succeeds, app deploy fails | Recover the application (previous compatible artifact); schema needs no action | CP3/CP5 |
| Migration succeeds, readiness fails | Diagnose compatibility; roll the app back only if schema-compatible, else forward-fix | CP7 |
| Smoke test fails | Stop rollout; application recovery; never declare success | CP8 |
| Application crashes after success | Redeploy previous artifact if schema-compatible (compatibility check first) | CP5→CP9 re-verified |
| Database corruption | `docs/backup-recovery.md` restore flow on an isolated target first; accept the stated data-loss window | out-of-band |
| Incompatible schema change | Corrective forward migration or verified restore per `docs/rollback-recovery.md` | out-of-band |
| Data-loss event | Explicit restore procedure; unknown loss stays declared unknown | out-of-band |
| Health endpoint fails | Stop rollout; do not claim deployment success | CP6/CP7 |
| Recovery validation fails | Remain in failed/recovery state; do not redefine success downward | any |

---

## Troubleshooting

Fail-fast is deliberate: an invalid configuration stops the process before it
serves a single request, so a startup error is diagnostic information, not a
defect to retry. Read the cause from `stdout` structured logs (redacted; see
[docs/production-logging.md](production-logging.md)) and the exit code. Do not
loosen a validation rule to start — fix the value.

| Symptom | Inspect / safe check | Stop or recover when |
|---|---|---|
| Startup exits non-zero with a `DATABASE_URL` / `JWT_SECRET` message | Startup log line names the field. `DATABASE_URL` must be a `postgresql(://)` URL; production additionally requires `sslmode=require`. `JWT_SECRET` ≥ 32 chars. | Fix the value and redeploy; never weaken validation |
| `P1001 can't reach database server` | Correct host/port for *where* the command runs: host-side `127.0.0.1:5433`, in-network `postgres:5432` (see Bringing the stack up). Confirm the host is reachable and, in production, that `sslmode=require` is accepted. | Restore reachability before migrating (CP2) |
| `migrate deploy` fails | Do **not** blind-retry. Inspect state with `migrate status` and follow the classified procedure in [docs/migrations.md](migrations.md). | STOP at CP4; destructive recovery is an explicit operator decision |
| `/health/live` not `200 {}` | The process is down or still booting; check the container/log. Restart decisions belong here **while running** — never treat a terminating instance's `503` as a liveness fault (see Graceful shutdown). | Restart only when live fails while the process should be running |
| `/health/ready` returns `503 {}` | A required dependency is unusable (PostgreSQL) or shutdown has begun. The body is always `{}`; the reason is the correlated `Readiness check failed` log line carrying only failing dependency names, joinable via `X-Request-ID`. | Withdraw from the load balancer; do not route on 503. Do not claim success |
| SMTP startup rejected | The five `SMTP_*` variables form one coherent group: `SMTP_HOST` present requires `SMTP_PORT` + `SMTP_SECURITY`; `SMTP_USER`/`SMTP_PASSWORD` are a pair; credentials forbid `plaintext` (use `starttls`/`smtps`). See `.env.example` for the full coherence rules. | Complete the group or omit it entirely (NoOp email — auth flows still run). Never downgrade a secure mode to start |
| `CORS_ALLOWED_ORIGINS` rejected | Each entry is a bare `http(s)://host[:port]` origin — no path, query, fragment, or credentials; empty entries reject the whole value. | Fix the origins; absent means CORS fully disabled (no cross-origin headers emitted) |
| `/docs` returns 404 in production | Expected: `SWAGGER_UI_ENABLED` defaults to `false` in production while `/openapi.json` still serves. Set `SWAGGER_UI_ENABLED=true` deliberately (and keep `OPENAPI_ENABLED=true`), accepting a developer interface in production. | Leave UI off unless intentionally published |
| Swallow a `SIGTERM` / requests cut | Allow in-flight requests to drain before `SIGKILL`; `close` is idempotent so repeated signals are safe. | See Graceful shutdown and probes |

Broader recovery decisions (application rollback, configuration rollback,
database roll-forward, verified restore) are owned by
[docs/rollback-recovery.md](rollback-recovery.md); backup mechanics by
[docs/backup-recovery.md](backup-recovery.md); the transport/TLS boundary and
pre-exposure checklist by [docs/transport-security.md](transport-security.md).
This table points to them; it does not restate their procedures.

---

## Security

### Secrets Management
- **Never commit `.env`** — it is gitignored
- **No hardcoded secrets** in source code
- `JWT_SECRET` has no default — must be provided
- `.env.example` contains only placeholders

### Authentication
- Passwords: bcrypt (cost 12), never logged or returned
- JWT: HS256, 15-minute TTL, signature verified on every request
- Generic credential errors prevent user enumeration
- Single approved JWT implementation (`@fastify/jwt`)

### Cookies (Development/Test Only)
| Attribute | Value |
|-----------|-------|
| Name | `accessToken` |
| HttpOnly | `true` |
| SameSite | `strict` |
| Secure | `true` in production, `false` in dev/test |
| Path | `/` |
| Max-Age | 900 seconds |

**Production cookie authentication is disabled** by the CSRF gate (`config.auth.cookie.enabled = false` when `NODE_ENV=production`). API clients must use Bearer token authentication.

### Authorization
- Deny-by-default model
- Server-side role lookup (never trusts client data)
- Static roles (`user`, `admin`) and permissions defined in code
- No role mass assignment possible

### Input Validation
- Strict AJV validation: `additionalProperties: false`, `coerceTypes: false`
- Unknown properties rejected with 400
- No unsafe type coercion

### Error Handling
- No stack traces in responses
- No database/ORM errors exposed
- No secrets in error responses
- 500 errors sanitized to generic `INTERNAL_ERROR` body
- All 401 responses include `WWW-Authenticate` header

### HTTPS
**Application does not terminate TLS.** Terminate HTTPS at your reverse proxy / load balancer / ingress controller. The application must run behind a TLS-terminating proxy in production.

The complete production transport contract — TLS boundary, HSTS policy and rollout safety, trusted-proxy policy (no-trust), forwarded-header boundaries, Secure-cookie contract, environment matrix, pre-exposure checklist, direct-access requirement, and the external edge-verification procedure — is normative in [docs/transport-security.md](transport-security.md). The summary below does not replace it.

**Never trust forwarded headers in-app:** Forge configures no `trustProxy` and ignores `X-Forwarded-Proto/Host/For`, `Forwarded`, and `X-Real-IP` for all security decisions (throttle identity stays socket-derived; cookie flags and emailed-link hosts stay config-derived). Enabling proxy trust would convert tested spoof-immunity into bypass. Behind a proxy, IP-dimension throttling sees the edge address — enforce rate limiting at the edge for proxied scale.

**HSTS is edge-owned:** the application emits no `Strict-Transport-Security` in any environment (pinned by tests). The edge must emit `max-age=31536000[; includeSubDomains]` post-checklist (never `preload` by default; never for localhost/staging origins).

**Secure cookies require browser-facing HTTPS:** production flags are config-derived (`NODE_ENV=production`), so proxy topology cannot weaken them — but without edge HTTPS they simply won't function. Verify `Secure; HttpOnly; SameSite=Strict` on production Set-Cookie responses plus host-only scoping and paths.

---

## V1 Scope

This is the V1 foundational platform. The following are **deferred to V2** and NOT implemented:

- CSRF protection (cookie auth blocked in production)
- MFA / TOTP / WebAuthn
- Multiple roles per user
- Role/permission CRUD
- Distributed rate limiting (login throttling implemented with PostgreSQL)
- Deployment automation (platform *examples* in `render.yaml`/`fly.toml` are included; automated one-click pipelines are not)
- Docker production profiles
- Advanced CORS / Helmet headers

Implemented in V1 (not deferred): refresh tokens with rotation, email verification, password reset, sessions with persistence, Swagger/OpenAPI 3.1, request ID correlation, metrics (NoOp boundaries), CI/CD pipelines.

---

## Directory Structure

```
oxyide-forge/
├── src/
│ ├── main.ts # Bootstrap entry point
│ ├── app/ # Fastify factory, server, routes, lifecycle
│ ├── modules/ # Domain modules (auth, authorization, users, roles, notes, health)
│ ├── shared/ # Errors, email contract + templates, pagination/sorting/filtering, logging
│ ├── platform/ # Database (Prisma), cache (Redis), email (SMTP transport)
│ ├── plugins/ # Cross-cutting Fastify plugins
│ ├── config/ # Centralized Zod-validated config
│ └── types/ # Fastify type augmentations
├── prisma/
│ ├── schema.prisma # 8 models
│ └── migrations/ # Ordered migrations
├── docs/ # Architecture, standards, conventions, ADRs
├──.env.example # Environment template
├── LICENSE.txt # MIT License
├── package.json
├── package-lock.json
├── tsconfig.json
└──.gitignore
```

---

## Platform deployment examples

Two platform-specific examples ship at the repository root. Both were
validated locally (structure, commands, env vars, health paths) but have NOT
been deployed to a live platform account — live deployment requires a
platform account and is the customer's step.

| Platform | File | Deploy command |
|---|---|---|
| Render | `render.yaml` | `render blueprint launch` or dashboard |
| Fly.io | `fly.toml` | `fly launch --no-deploy`, then `fly deploy` |

**What the examples guarantee:**

- Build/start commands match `package.json` (`npm ci`, `npm run build`, `node dist/main.js`).
- Node 20 runtime (matches `engines` and the Dockerfile).
- Migrations run as a **single pre-deploy step** (`npx prisma migrate deploy` via Render `preDeployCommand` / Fly `release_command`) — never from multi-replica startup.
- Health checks use `/health/ready` (readiness), not `/health/live`.
- All env vars exist in `src/config/env.schema.ts`.
- No real credentials, database URLs, or secrets in the files.

**What the customer must configure:**

1. `JWT_SECRET` — generate with `openssl rand -base64 48` (minimum 32 chars), set in the platform dashboard/secrets.
2. `APP_BASE_URL` — the service's public `https://` URL (production refuses `http://`).
3. `DATABASE_URL` — injected by the platform's managed PostgreSQL (Render `fromDatabase`; Fly `fly postgres attach`). Must include `sslmode=require` or equivalent TLS.
4. Optional: `METRICS_ENABLED=true` to expose `/metrics` for Prometheus scraping. See [observability.md](observability.md) for the metrics contract, scrape configuration, and the generated Grafana dashboard (`npm run dashboards`). Grafana and Prometheus are customer-managed external services — Forge does not install or host them.

**Migration safety:** `npx prisma migrate deploy` applies pending migrations only. It never resets, never seeds, and runs exactly once per deploy (release step), so concurrent replicas cannot race. For a non-backward-compatible migration, deploy the backward-compatible schema change first, then the code change (expand/contract).

**Rollback:** if a deploy fails after migrations applied, `prisma migrate resolve` marks specific migrations; rolling back code does NOT roll back schema. Test rollbacks against a staging database first.

**What was NOT tested:** live deployment to Render or Fly.io (no platform account). Local validation covered file structure, command existence, env-var names, health paths, and secret absence.

---

## Support

- **Reporting channel**: ⚠️ **Not yet confirmed.** The URL previously listed here (`https://www.oxyide.com/support`) was verified during preparation of the support policy and is **not** a working support channel — the site serves a "Coming Soon" placeholder and `/support` returns content identical to any other path on that host. No mailbox, form, or ticket system is published. See [docs/support.md](support.md) §2 for the exact decision required before this can be filled in.
- **Documentation**: See `docs/` directory — start with [docs/development.md](development.md) for the developer guide, [docs/architecture.md](architecture.md) for system architecture, and [docs/reference-module.md](reference-module.md) for the canonical module walkthrough.
