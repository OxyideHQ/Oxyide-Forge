# Compatibility Policy

**Applies to:** Oxyide Forge 1.0.0
**Purpose:** state exactly what Forge requires, and — more importantly — **what has actually been tested.**

> **Read the evidence labels.** A requirement being *declared* in `package.json` is not the same as that version or platform having been *tested*. This document keeps those apart deliberately.

---

## 1. Evidence labels used in this document

| Label | Meaning |
|---|---|
| **DECLARED** | Stated by package metadata or configuration — enforced or documented, but not proof of testing |
| **VERIFIED LOCALLY** | Actually built and tested in the development environment described in §3 |
| **PLATFORM-VERIFIED** | Tested against a real, deployed service |
| **UNVERIFIED** | Not tested, or insufficient evidence exists |

---

## 2. Summary — one honest line

**Forge has been built and tested on exactly one environment: Linux, Node 20.19.2, npm 9.2.0, PostgreSQL 17, on x86_64.** Every other platform, runtime version, and hosting target is **DECLARED or UNVERIFIED**.

---

## 3. The tested environment

| Component | Value |
|---|---|
| OS / kernel | Linux (x86_64) |
| Node.js | **v20.19.2** |
| npm | 9.2.0 |
| PostgreSQL | 17.11 |
| Docker | 26.1.5 (overlay2) |
| Container base | `node:20-alpine` |

Everything marked **VERIFIED LOCALLY** below was tested only in this environment.

---

## 4. Runtime requirements

### Node.js

| | Detail |
|---|---|
| **DECLARED** | `>=20.19.0` — `package.json` → `engines.node`, enforced by `setup.sh` |
| **VERIFIED LOCALLY** | v20.19.2 |
| **UNVERIFIED** | Node 21, 22, 23, 24, or any version other than 20.19.2 |
| **UNVERIFIED** | Any version **below** 20.19.0 — deliberately unsupported, not "probably fine" |

> A declared `engines` range is **not** evidence that the whole range was tested. Node 22+ has **not** been tested with this repository.

### Package manager

| | Detail |
|---|---|
| **DECLARED** | npm. The repository ships `package-lock.json` (lockfile **v3**) |
| **UNVERIFIED** | pnpm, Yarn, or Bun — no lockfile for them exists, and none was tested |
| **Note** | `package.json` declares **no** `packageManager` field, so npm is required by convention, not by tooling enforcement |

Use `npm ci` for reproducible installs. It is what `setup.sh` runs and what the deployment examples use.

---

## 5. Framework and toolchain versions

| Component | **DECLARED** (from `package.json`) | **VERIFIED LOCALLY** | Note |
|---|---|---|---|
| Fastify | `^5.1.0` | 5.x | Major pinned; any 5.x is permitted by the range |
| Prisma | `6.12.0` (exact) | 6.12.0 | Pinned exactly — not a range |
| TypeScript | `^5.7.0` | 5.9.3 | Build-time only |
| Vitest | `^2.1.0` | 2.1.9 | Dev dependency |
| ESLint | `^9.17.0` | 9.39.5 | Dev dependency |
| Zod | `^3.25.0` | 3.x | Config validation |
| Pino | `^9.3.0` | 9.x | Logging |
| bcrypt | `^6.0.0` | 6.x | **Native module — see §7** |

> **Unpinned minors are untested.** A `^5.1.0` range means a newer 5.x *may* install. That is a range, not a guarantee — the lockfile pins the exact resolved tree, which is why `npm ci` is the supported install.

---

## 6. Database

| | Detail |
|---|---|
| **DECLARED** | PostgreSQL **17+** (`README`, `docker-compose.yml` → `postgres:17-alpine`) |
| **VERIFIED LOCALLY** | PostgreSQL **17.11** |
| **UNVERIFIED** | PostgreSQL 14, 15, 16 — earlier majors were never tested |
| **UNVERIFIED** | Any managed PostgreSQL provider (RDS, Neon, Supabase, Fly Postgres) |

### Connection requirements

Enforced by `src/config/env.schema.ts` at startup — these are **DECLARED and enforced**, not advisory:

| Rule | Detail |
|---|---|
| Protocol | `postgresql://` or `postgres://` only |
| **Production TLS** | `NODE_ENV=production` **requires** `sslmode=require`. The app refuses to start without it |
| `sslmode` values | Only `require` or `disable`. `verify-ca` / `verify-full` are **rejected** because Prisma silently ignores them |
| Pool parameters | `connection_limit`, `pool_timeout`, `connect_timeout` must be positive integers, at most once each |
| `APP_BASE_URL` | Must be `https://` in production |
| `JWT_SECRET` | Required, minimum **32 characters**, no default |

---

## 7. Docker

| | Detail |
|---|---|
| **DECLARED** | `node:20-alpine`, multi-stage build; runtime user `USER node` (non-root) |
| **VERIFIED LOCALLY** | Image built and run on Linux/x86_64. Readiness gating, health transitions, and graceful SIGTERM shutdown all observed |
| **VERIFIED LOCALLY** | `docker-compose.yml` stack reaches `/health/ready` 200 with the bundled database |
| **UNVERIFIED** | Apple Silicon (arm64) — no multi-arch build exists |
| **UNVERIFIED** | macOS or Windows Docker hosts |

> **Native-module caveat (DEPLOY-002).** `bcrypt` is a native module and Prisma ships platform-specific engines. Only Linux/x86_64 has been verified. On another architecture, `bcrypt` must be rebuilt or a compatible binary selected, and Prisma may need `prisma generate` for the target platform. This is a known unverified risk, not a solved problem.

---

## 8. Deployment targets

| Platform | Configuration | Verified? |
|---|---|---|
| **Local process** | `npm run dev` / `npm start` | **VERIFIED LOCALLY** |
| **Docker / Compose** | `Dockerfile`, `docker-compose.yml` | **VERIFIED LOCALLY** |
| **Render** | `render.yaml` | **UNVERIFIED** — statically checked only |
| **Fly.io** | `fly.toml` | **UNVERIFIED** — statically checked only |

> **No deployment to Render or Fly.io has ever been performed from this repository.** There was no platform account available. The configuration files are structurally validated — commands exist, env-var names match the schema, health paths are real, no secrets are committed — but **static validation is not a deployment**. See [Support Policy](support.md) §10.

### What every platform must do

Regardless of target, the deployment must:

1. Build with `npm ci` and generate Prisma Client.
2. Run `npx prisma migrate deploy` **once**, before the new version serves traffic.
3. Start the server with `HOST=0.0.0.0` so it is reachable outside its own container.
4. Provide `DATABASE_URL` (with `sslmode=require` in production) and `JWT_SECRET` (≥ 32 chars).
5. Probe `/health/ready` for traffic gating and `/health/live` for restart decisions.
6. Send `SIGTERM` and allow the drain to complete.

The application **never migrates at startup** and has no startup wait loop. A container that is `running` may still be un-ready — gate traffic on `/health/ready`. See [Deployment](deployment.md) → *Running the container directly*.

---

## 9. Configuration surface

| | Detail |
|---|---|
| **DECLARED and enforced** | 17 environment variables, validated by Zod at startup. Invalid values **prevent startup** with a message naming the field |
| **VERIFIED LOCALLY** | Default, production, and invalid configurations all exercised |
| Optional groups | Redis, SMTP (five variables, one coherent group), CORS — each all-or-nothing; a partial group is rejected |
| Strict booleans | `OPENAPI_ENABLED`, `SWAGGER_UI_ENABLED`, `METRICS_ENABLED` accept **only** `true` / `false`. `1`, `yes`, and others are rejected rather than silently coerced |

Full contract: [`development.md` §4](development.md) and `.env.example`.

---

## 10. Compatibility summary matrix

Only the entries below are claimed. Nothing else is supported.

| Component | Declared | Verified locally | Platform-verified |
|---|---|---|---|
| Node 20.19.2 | `>=20.19.0` | ✅ | — |
| Node 20.x (other minors) | `>=20.19.0` | ❌ | ❌ |
| Node 21+ | ❌ not declared | ❌ | ❌ |
| npm (with lockfile v3) | by convention | ✅ | — |
| pnpm / Yarn / Bun | ❌ | ❌ | ❌ |
| PostgreSQL 17 | 17+ | ✅ 17.11 | ❌ |
| PostgreSQL 14–16 | ❌ | ❌ | ❌ |
| Linux x86_64 | — | ✅ | — |
| macOS (any shell) | — | ❌ | ❌ |
| Windows (any shell) | — | ❌ | ❌ |
| macOS / Linux Bash, WSL2, Git Bash (`bash setup.sh`) | by convention | ❌ runs here only on Linux CI | ❌ |
| Windows PowerShell (`npm run setup`) | `package.json` → `setup` | ❌ not executed on Windows here | ❌ |
| Windows Command Prompt (`npm run setup`) | `package.json` → `setup` | ❌ not executed on Windows here | ❌ |
| arm64 / Apple Silicon | — | ❌ | ❌ |
| Docker (Linux/x86_64) | `node:20-alpine` | ✅ | — |
| Render | — | ❌ config only | ❌ |
| Fly.io | — | ❌ config only | ❌ |

**Nothing in the `Platform-verified` column has been tested.** There was no platform account available, so no deployment to a hosting provider has ever been performed from this repository. A `DECLARED` or `❌` entry is a statement about intent or absence of evidence — it is never a claim that the combination was exercised.

---

## 11. If you need something not listed here

Forge is a foundation with a deliberately narrow verified surface. If your requirement depends on a platform, runtime, or architecture not marked **VERIFIED LOCALLY**, treat it as **unproven** and test it yourself before committing to it.

No compatibility guarantee is offered beyond this table, and none should be inferred from a declared version range.

---

## 12. Support lifecycle — how compatibility changes are handled

Removing a supported runtime or configuration is a customer-facing breaking change and is handled as one:

- The removal is announced in `CHANGELOG.md` at least one MINOR release before it takes effect, and the last supporting release is named.
- Each release remains available under the MIT License. There is no purchase or update entitlement; future fixes and releases are not guaranteed. See [Updates & Maintenance](updates.md).
- Breaking changes are documented per [Versioning & Release Policy](versioning.md) §4; there is no separate status page, and no end-of-life date is currently defined for any release.
- This matrix is maintained alongside the code: a newly tested environment is promoted from UNVERIFIED to VERIFIED LOCALLY only with executed evidence, never by assertion.

---

## 13. Related documents

- [Support Policy](support.md) — scope and response expectations
- [Versioning & Release Policy](versioning.md) — how updates reach you
- [Security Reporting Policy](security.md) — reporting a vulnerability
- [Deployment](deployment.md) — platform configuration and readiness gating
- [`development.md`](development.md) — environment variable contract
