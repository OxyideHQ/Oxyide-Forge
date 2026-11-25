# Troubleshooting

Evidence-backed fixes for the problems you are most likely to hit while installing and running Oxyide Forge. Every remedy here uses the actual implementation — there are no speculative steps.

> **Safety first.** None of these remedies use `prisma migrate reset`, `prisma migrate dev`, `DROP DATABASE`, or `docker compose down -v`. Those destroy data and are never the right first move. See [Database never migrates](#database-never-migrates) for the safe alternative.

---

## Contents

1. [Prerequisites and version problems](#prerequisites-and-version-problems)
2. [Windows shell problems](#windows-shell-problems)
3. [Database problems](#database-problems)
4. [Configuration and environment problems](#configuration-and-environment-problems)
5. [Build, test, and quality-gate problems](#build-test-and-quality-gate-problems)
6. [Git hook problems](#git-hook-problems)
7. [Docker and health-check problems](#docker-and-health-check-problems)
8. [Coverage reports](#coverage-reports)
9. [Still stuck?](#still-stuck)

---

## Prerequisites and version problems

### `npm run setup` exits immediately with "Node.js not found" or a version error

**Symptoms:** setup stops at the first step; `Node.js >=20.19.0` is printed.

**Cause:** Forge requires Node `>=20.19.0` (enforced by `engines` in `package.json` and checked by setup before anything else).

**Diagnose (every shell):**

```bash
node --version
npm --version
```

**Remedy:** install Node 20.19.0 or newer (or use a version manager such as `nvm`). Do not lower the requirement — the code depends on it.

---

## Windows shell problems

### `bash setup.sh` fails on Windows

**Symptoms:** `bash: command not found`, or PowerShell reports that `bash`,
`export`, `cp`, or `curl -s -o /dev/null` are not recognized.

**Cause:** `bash setup.sh` is macOS/Linux-only. On Windows the documented
onboarding command is `npm run setup` (PowerShell and Command Prompt) — same
workflow, no Bash required. See [Installation](installation.md).

**Remedy:** run `npm run setup` from the project folder instead.

### `export VAR=value` does nothing in PowerShell / Command Prompt

**Symptoms:** `export` is not recognized (PowerShell), or the variable has no
effect on the next command.

**Cause:** `export` is Unix-shell syntax. Each Windows shell has its own form —
and `.env` is preferable to all of them for anything permanent:

```powershell
# PowerShell — session-only override (wins over .env for that process)
$env:PORT = "4000"; npm run dev
```

```text
:: Command Prompt — persists for the session; && chains the next command
set PORT=4000 && npm run dev
```

```bash
# macOS / Linux — prefix applies to that command only
PORT=4000 npm run dev
```

### `curl -s -o /dev/null -w '%{http_code}'` fails in PowerShell

**Symptoms:** `Invoke-WebRequest` errors, or the format string prints literally.

**Cause:** in PowerShell, bare `curl` is an alias for `Invoke-WebRequest` —
the Unix flags never reach real curl. Use `curl.exe` with Windows-appropriate
flags (see [Installation](installation.md) §6):

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:3000/health/ready
```

### PowerShell refuses to run `scripts/package.ps1`

**Symptoms:** `... cannot be loaded because running scripts is disabled on this
system` (execution policy).

**Cause:** Windows blocks unsigned local scripts by default. This affects only
the release-workflow packager — customers never need it (they receive the ZIP).

**Remedy (release operators only):** bypass the policy for that one invocation
from an elevated prompt — never change the machine policy to run it:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

### `.sh` files edited on Windows fail with `command not found` or `set: Illegal option`

**Symptoms:** after editing `setup.sh` (or any `.sh`) on Windows, Bash reports
errors naming commands with a trailing `\r`.

**Cause:** the file was saved with CRLF line endings. Shipped shell scripts
must use LF (pinned by test). Configure Git or your editor to preserve LF for
`.sh` files, or convert back before running.

---

## Database problems

### The application will not start / readiness returns 503

**Symptoms:** `/health/live` returns `200` but `/health/ready` returns `503`.

**Cause:** PostgreSQL is the **only required dependency** for readiness. A `503` from `/health/ready` means the database is unusable, a configured optional dependency (Redis, when `REDIS_URL` is set) is unhealthy, or the process is shutting down.

**Diagnose:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health/ready
```

Both probes return an **empty body by design** — the status code is the entire signal, so no dependency detail is ever exposed. Check the server logs for the readiness failure reason.

**Remedy:** confirm PostgreSQL is running and that `DATABASE_URL` points at it (see next entry).

### Cannot reach PostgreSQL at host:port

**Symptoms:** setup (`npm run setup`, or `bash setup.sh` on Unix) fails at "Checking PostgreSQL availability…" with `Cannot reach PostgreSQL at <host>:<port>`.

**Cause:** a TCP connection to the host/port in `DATABASE_URL` failed.

> **What this check does and does not prove.** Setup opens a TCP socket to the host and port. It does **not** authenticate, and it does **not** confirm the database name exists. Setup will succeed against a reachable server even if your credentials are wrong; that failure then surfaces at startup as a configuration error. The check exists to fail fast on "the database simply is not running".

**Diagnose:**

```bash
# is anything listening?
nc -vz <host> <port>
```

**Remedy:** start the database, then re-run setup. If you are using the bundled Compose file:

```bash
# requires POSTGRES_PASSWORD to be exported first
export POSTGRES_PASSWORD='choose-a-local-password'
docker compose up -d postgres
```

The bundled database listens on host port **5433** by default (container port 5432), and requires `POSTGRES_PASSWORD` to be set — Compose refuses to start without it.

### Connection refused / authentication failed for password

**Symptoms:** startup fails with a Prisma connection error rather than a configuration error.

**Cause:** `DATABASE_URL` was reachable but the credentials or database name are wrong.

**Diagnose:** connect with the same credentials directly:

```bash
psql "postgresql://USER:PASSWORD@HOST:PORT/DATABASE" -c 'select 1;'
```

**Remedy:** correct `DATABASE_URL` and restart. For a local dev database you can create the role and database:

```bash
createuser forge --pwprompt
createdb oxyide_starter --owner forge
```

---

## Configuration and environment problems

### Startup fails with a configuration validation error

**Symptoms:** the process exits immediately and prints a fatal startup error naming a variable, e.g. `Fatal startup error: Invalid configuration (DATABASE_URL)` with a `DATABASE_URL: is missing.` detail line and a remediation naming `.env`.

**Cause:** every variable in `src/config/env.schema.ts` is validated at startup. **There is no insecure default for anything security-relevant** — missing or invalid values fail fast rather than falling back.

**Diagnose:** read the printed message; it names the exact variable and rule, for example:

| Message fragment | Cause | Remedy |
|---|---|---|
| `JWT_SECRET is required` | not set | set it; minimum **32 characters** |
| `JWT_SECRET must be at least 32 characters` | too short | generate a longer secret |
| `DATABASE_URL must use the PostgreSQL protocol` | wrong scheme | use `postgresql://` or `postgres://` |
| `sslmode must be 'require' or 'disable'` | unsupported TLS mode | use `require` or `disable` only — Prisma silently ignores `verify-ca`/`verify-full`, so Forge rejects them |
| `must include sslmode=require when NODE_ENV=production` | production without TLS | append `?sslmode=require` |
| `APP_BASE_URL must use https:// when NODE_ENV=production` | production base URL | use `https://` |
| `SWAGGER_UI_ENABLED requires OPENAPI_ENABLED` | UI without a document | set `OPENAPI_ENABLED=true` or `SWAGGER_UI_ENABLED=false` |
| `SMTP_HOST is required when any SMTP_* variable is set` | partial SMTP group | complete the group, or remove **all** `SMTP_*` variables |
| `SMTP credentials require smtps or starttls` | plaintext + credentials | use `smtps`/`starttls`, or drop credentials for a local relay |
| `CORS_ALLOWED_ORIGINS contains an empty origin` | stray/trailing comma | remove empty entries; each must be a bare `http(s)://host[:port]` |
| `HOST must be a valid host or IPv4 address` | bad bind address | use a hostname, IPv4, `0.0.0.0`, or `localhost` |
| `PORT must be a valid TCP port` | out of range | use 1–65535 |

### `REDIS_URL=""` will not start

**Cause:** an empty string is not "disabled". Forge rejects it deliberately so a typo cannot look like an intentional opt-out.

**Remedy:** unset the variable entirely (remove the line), or give it a real `redis://` / `rediss://` URL. The application runs fully without Redis.

### `DATABASE_URL` missing vs database unreachable — different problems

**Symptoms (missing):** immediate exit with `Invalid configuration (DATABASE_URL)` / `is missing.` — fix in `.env`, then restart.

**Symptoms (unreachable):** the process starts and serves traffic, but `/health/ready` returns `503` while `/health/live` returns `200`. The URL is configured; the server named in it is not answering, the credentials are wrong, or the database does not exist.

**Cause:** startup validation checks the *shape* of the configuration; readiness checks the *living dependency*. Do not "fix" a 503 by editing the URL format — diagnose which leg failed:

1. Missing → the fatal line names `DATABASE_URL` at boot. Set it in `.env`.
2. Wrong host/port → setup's TCP check (`Cannot reach PostgreSQL at host:port`) or a refused connection at boot. Confirm what is listening (per shell: `Test-NetConnection host -Port port` in PowerShell; `nc -vz host port` on macOS/Linux).
3. Wrong credentials or database name → Prisma authentication/database errors after boot. Connect directly with the same credentials (`psql "postgresql://USER:PASSWORD@HOST:PORT/DATABASE" -c 'select 1;'`), fix, restart. Never paste the real URL into logs or tickets.

### My `.env` change had no effect

**Cause:** `npm run dev` loads `.env`, but **`npm start` (production) reads only the process environment.** Values already present in the environment also win over `.env` — including ones you exported earlier in the same terminal and forgot about.

**Remedy:** for production, set real environment variables in your process manager rather than relying on a `.env` file. For a stale terminal override, close the terminal (Command Prompt `set` and PowerShell `$env:` persist for the session) or unset the variable, then restart the app.

### The unknown-variable warning at startup

**Cause:** Forge warns (on stderr) when an environment variable *looks like* a Forge setting but is not in the schema — for example `REDS_URL` instead of `REDIS_URL`.

**Remedy:** treat it as a typo check and rename the variable. See [Configuration](development.md#4-environment-configuration) for the full contract.

---

## Build, test, and quality-gate problems

### Database never migrates

**Symptoms:** tables are missing, or the app errors on an unknown table/column.

**Cause:** no migration ran. The application never migrates on startup — by design, so a multi-replica deploy cannot race or reset the database.

**Remedy (safe, non-destructive):**

```bash
npx prisma generate     # regenerate the client after a fresh install
npx prisma migrate deploy   # apply pending migrations only
```

`migrate deploy` applies pending migrations and nothing else. Use it for both local and production databases.

> `prisma migrate dev` is a **development-time** command that can prompt to reset a database when it detects drift. It is not part of the Forge onboarding or deployment workflow. Prefer `prisma migrate deploy`. If you believe a migration was applied incorrectly, take a backup and follow [Rollback & Recovery](rollback-recovery.md).

### `npm test` fails because the database is unavailable

**Symptoms:** integration suites error on connection rather than passing.

**Cause:** integration tests run against a **real PostgreSQL** database and fail fast when it is unreachable — they never silently skip.

**Diagnose:**

```bash
# is the test database reachable?
psql "$DATABASE_URL" -c 'select 1;'
```

**Remedy:** start PostgreSQL and confirm `DATABASE_URL` targets a database you are willing to have truncated. Integration suites **truncate tables** in the targeted database and refuse to run when `NODE_ENV=production`.

### `npm run architecture:check` fails

**Symptoms:** a rule such as `ARCH-ENF-013` reports a file pair.

**Cause:** an architecture rule was broken — for example a route importing a repository, a module importing another module's repository, or a `console.*` call.

**Remedy:** the message names both files and the rule. Fix the import layering rather than suppressing the rule. The rules are the product's core value; see [Architecture](architecture.md).

### My pre-commit hook is failing the build

**Symptoms:** `git commit` aborts with a typecheck/lint/architecture error.

**Cause:** the hook runs `npm run check` — typecheck, lint, architecture check — and stops at the first failure. It deliberately does **not** run tests or the build.

**Remedy:** fix the reported gate, or verify manually first:

```bash
npm run typecheck
npm run lint
npm run architecture:check
```

If you are certain a commit must go through unverified, `git commit --no-verify` skips the hook. CI still runs every gate.

---

## Git hook problems

### Commits are not running any checks

**Symptoms:** `git commit` succeeds even with broken code.

**Cause:** the Husky hook is installed by setup (`npm run setup`, or `bash setup.sh` on Unix). If you installed with a bare `npm ci`, the hook was never installed — Forge deliberately does **not** use an npm `prepare` lifecycle script, because the repository forbids all `pre*`/`post*`/`prepare`/`install` hooks.

**Diagnose:**

```bash
git config core.hooksPath   # expected: .husky/_
```

**Remedy:**

```bash
npx husky
```

Then `git commit` runs `npm run check` again.

### Extracted the ZIP and there is no `.git`

**Symptoms:** setup reports that it is skipping the hook install.

**Cause:** there are no hooks in a directory that is not a Git repository. This is expected and is not an error.

**Remedy:** run `git init` if you want version control, then `npx husky` to enable the hook.

---

## Docker and health-check problems

### The container starts but never becomes healthy

**Symptoms:** the container runs but the health check keeps restarting it.

**Cause:** the image's `HEALTHCHECK` polls `/health/ready`, which returns `503` while the database is unreachable. The image runs as a **non-root** user (`node`) and listens on port **3000**.

**Diagnose:**

```bash
docker compose logs -f app
docker inspect --format '{{json .State.Health}}' <container>
```

**Remedy:** make PostgreSQL reachable from inside the container and confirm `/health/ready` returns `200` there. Compose does not override the image health check, so the image definition is the one that runs.

### The app works locally but not in a container

**Cause:** `HOST=0.0.0.0` is required to accept connections from outside the container. `localhost` binds inside the container only.

**Remedy:** set `HOST=0.0.0.0` (already the default in `.env.example`).

### Platform examples (`render.yaml`, `fly.toml`)

**Cause:** these are **examples**, included as starting points. They have been validated locally for structure, commands, environment variables, and health paths, but have **not** been deployed to a live platform account.

**Remedy:** treat them as a starting point you must adapt — you own the database, secrets, and DNS. Migrations must run as a single pre-deploy step (`npx prisma migrate deploy`), never from application startup. See [Deployment](deployment.md).

---

## Coverage reports

### Where did the coverage report go?

Coverage is **informational only** — there is no minimum threshold and no percentage can fail anything.

```bash
npm run test:coverage
```

Reports are written to `coverage/`:

| File | Use |
|---|---|
| `coverage/lcov.info` | machine-readable, for tooling/CI later |
| `coverage/coverage-summary.json` | stable totals as JSON |
| `coverage/lcov-report/index.html` | browsable HTML report |

`coverage/` is git-ignored, so reports never show up in `git status`. Only first-party code under `src/` is measured; test files and `src/types/` are excluded.

### My changes did not change the coverage number

**Cause:** coverage is only produced when you explicitly run `npm run test:coverage`. Plain `npm test` does not generate a report.

---

## Still stuck?

1. Re-run setup with the failing step in view: `npm run setup` prints each step.
2. Check the API documentation for expected behaviour: `/docs` (Swagger UI, off in production) or `/openapi.json`.
3. Review the operational guides: [Development](development.md), [Deployment](deployment.md), [Migrations](migrations.md), [Transport Security](transport-security.md).

If something here is still wrong after following the steps, the guides linked above are the contract — see [Architecture Decision Records](architecture.md) for why each major decision was made.