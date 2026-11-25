# Installation

The single detailed installation guide for Oxyide Forge. Every command block
is labeled with the shell it runs in — pick your section and copy verbatim.
`README.md` links here instead of duplicating these steps.

Supported shells and their labels in this guide:

| Label | Environment |
|---|---|
| `PowerShell` | Windows PowerShell 5.1+ / PowerShell 7+ |
| `Command Prompt` | Windows `cmd.exe` |
| `macOS / Linux` | Terminal / Bash (also WSL2 and Git Bash) |

> **Verified vs untested.** Forge is developed, tested, and CI-gated on Linux.
> The Windows and macOS commands below use only documented shell behavior and
> the project's own Node.js tooling, but they have not been executed on those
> platforms in this environment — see [Compatibility](compatibility.md) for the
> honest platform matrix. If a command fails on your machine, [Troubleshooting](troubleshooting.md)
> has the shell-specific remedies.

## 1. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | >= 20.19.0 | enforced by `engines`; setup refuses anything older |
| npm | ships with Node | always install with `npm ci` (the lockfile is `package-lock.json`) |
| PostgreSQL | 17+ | **required** — there is no bundled database process |
| Redis | — | optional; the app runs fully without it when `REDIS_URL` is unset |
| Docker | any recent Desktop release | optional; only needed for the Compose database path |

Check yours first (same command, every shell):

```powershell
# PowerShell
node --version
npm --version
```

```text
:: Command Prompt
node --version
npm --version
```

```bash
# macOS / Linux
node --version
npm --version
```

## 2. Get the code

Forge is distributed as a **ZIP download**, not a Git repository.

```powershell
# PowerShell — extract to a my-backend folder
Expand-Archive oxyide-forge-v1.0.0.zip -DestinationPath my-backend
cd my-backend\oxyide-forge-v1.0.0
```

```text
:: Command Prompt — tar ships with Windows 10+; otherwise use Explorer right-click > Extract All
tar -xf oxyide-forge-v1.0.0.zip
cd oxyide-forge-v1.0.0
```

```bash
# macOS / Linux
unzip oxyide-forge-v1.0.0.zip -d my-backend
cd my-backend
```

> The ZIP contains source only — no `node_modules`, no `.env`, no Git history.
> (If you received a Git URL instead, `git clone <url> my-backend` also works,
> and additionally enables the pre-commit hook install during setup.)

## 3. Provision PostgreSQL

Pick exactly one option. Any PostgreSQL 17+ instance works.

### Option A — bundled Compose database (easiest with Docker)

Starts `postgres:17-alpine` with a persistent volume. The database listens on
**host port 5433** (container port 5432). Compose refuses to start without
`POSTGRES_PASSWORD`, so set it first — in the same terminal you run Compose
from, because it is read from the process environment, not from `.env`.

```powershell
# PowerShell
$env:POSTGRES_PASSWORD = 'choose-a-local-password'
docker compose up -d postgres
```

```text
:: Command Prompt
set POSTGRES_PASSWORD=choose-a-local-password
docker compose up -d postgres
```

```bash
# macOS / Linux
export POSTGRES_PASSWORD='choose-a-local-password'
docker compose up -d postgres
```

> The service name is `postgres` (see `docker-compose.yml`). `docker compose up -d db`
> fails — there is no service called `db`.

### Option B — an existing or managed PostgreSQL

Create a role and database with your provider's tooling, or with SQL:

```sql
-- SQL (run as a superuser, e.g. via psql)
CREATE ROLE forge WITH LOGIN PASSWORD 'choose-a-local-password';
CREATE DATABASE oxyide_starter OWNER forge;
```

Note the credentials for step 4. For a managed instance (RDS, Neon, Supabase,
or similar): use the provider's TLS-enabled connection string, keep
`sslmode=require` (production refuses to start without it), and confirm the
database is reachable from your machine before continuing. The application
never creates a managed database for you.

## 4. Configure the environment

Create `.env` from the template — without overwriting an existing file:

```powershell
# PowerShell
if (Test-Path .env) { Write-Host ".env exists - preserved" } else { Copy-Item .env.example .env }
```

```text
:: Command Prompt
if not exist .env copy .env.example .env
```

```bash
# macOS / Linux
test -f .env || cp .env.example .env
```

Then set **at minimum** these two values in `.env` (use a text editor or VS Code):

```env
DATABASE_URL=postgresql://forge:YOUR_PASSWORD@127.0.0.1:5433/oxyide_starter
JWT_SECRET=a-random-secret-of-at-least-32-characters
```

- `DATABASE_URL` must point at the database from step 3. With Option A, only
  the password differs from the line above.
- `JWT_SECRET` must be **at least 32 characters**. There is no default and the
  app will not start without it. Generate one with Node (works in every shell):

```powershell
# PowerShell / Command Prompt / macOS / Linux — any shell with Node
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Every variable is validated at startup and failures name the variable — see
[Troubleshooting](troubleshooting.md#configuration-and-environment-problems).
Temporary per-run overrides (which win over `.env`) differ by shell:

```powershell
# PowerShell
$env:PORT = "4000"; npm run dev
```

```text
:: Command Prompt (set persists for the session; close the window to clear it)
set PORT=4000 && npm run dev
```

```bash
# macOS / Linux
PORT=4000 npm run dev
```

## 5. Run setup

One command installs dependencies (`npm ci`), creates `.env` if absent (**never**
overwrites it), checks the database is reachable, generates the Prisma client,
applies migrations (`prisma migrate deploy` — never reset, never seed), builds,
starts the dev server, and polls `/health/ready` until it returns `200`:

```powershell
# PowerShell / Command Prompt / macOS / Linux — identical everywhere
npm run setup
```

Unix equivalent (delegates to the same implementation):

```bash
# macOS / Linux
bash setup.sh
```

Useful variants (same on every shell — pass flags after `--` for `npm run setup`):

```text
npm run setup -- --check            Validate prerequisites only; changes nothing
npm run setup -- --skip-migrations  Skip prisma migrate deploy
npm run setup -- --port 4000        Serve on port 4000 instead of 3000
```

Stop the server with `Ctrl+C` (the script cleans up its child process).

> `npm run setup` installs the Husky pre-commit hook only inside a Git working
> tree. A ZIP extraction has no `.git`, so the hook is skipped there with a
> note — run `npx husky` yourself if you later `git init` the folder.

## 6. Verify

```powershell
# PowerShell — curl.exe, not curl (curl alone is an Invoke-WebRequest alias)
curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:3000/health/live
curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:3000/health/ready
```

```text
:: Command Prompt
curl.exe -s -o NUL -w "%{http_code}\n" http://localhost:3000/health/live
curl.exe -s -o NUL -w "%{http_code}\n" http://localhost:3000/health/ready
```

```bash
# macOS / Linux
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health/live
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health/ready
```

Expect `200` from both. `/health/live` means the process serves traffic;
`/health/ready` returns `200` only when PostgreSQL is usable (`503`
otherwise). Both return an **empty body by design** — the status code is the
entire signal. Interactive API docs: `http://localhost:3000/docs` (off in
production) or the raw document at `/openapi.json`.

## 7. Manual setup (equivalent, step by step)

If you prefer not to run the automated setup:

```powershell
# PowerShell
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm run dev
```

```text
:: Command Prompt — identical commands
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm run dev
```

```bash
# macOS / Linux — identical commands
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm run dev
```

Then verify with the commands in §6.

## 8. VS Code terminals

VS Code's integrated terminal runs **whichever shell you selected** (check the
dropdown: PowerShell, Command Prompt, Git Bash, WSL). A Windows VS Code window
using PowerShell follows the `PowerShell` blocks above; the same window
switched to Git Bash follows `macOS / Linux`. If a command fails, confirm the
active shell first — most "works in Terminal but not in VS Code" reports are a
shell mismatch, not a Forge problem.

## 9. When something fails

- [Troubleshooting](troubleshooting.md) — evidence-backed fixes, including a
  Windows-shell section and every `DATABASE_URL` failure mode.
- [Development](development.md) — daily loop, testing, module recipe.
- [Deployment](deployment.md) — production workflow and platform examples.
- [Support](support.md) — scope and (non-)SLA honesty; [Compatibility](compatibility.md)
  for the tested-vs-untested platform matrix.
