# Oxyide Forge — Release Contract

> **Status:** Normative for what a release *is*; implementation lives in the
> canonical scripts and workflows this document points to. Nothing here is
> duplicated logic — if this document and a script disagree, the script plus
> its test suite is authoritative.
> **Scope:** versioned source releases (`v*` tags + customer ZIP). Docker image
> build is **not** verified in this environment (carried).

## 1. How do I know this version is ready to release?

All of the following hold on the exact tree being released:

1. **CI is green** on `.github/workflows/ci.yml` (PR + `main`): deterministic
 install, migrations applied, then every gate — production audit, secret
 scan, SAST, typecheck, lint, tests, build, architecture check, SBOM
 validation. CI calls canonical `package.json` scripts; it implements no
 check of its own.
2. **Release validation passes**: `node scripts/release-validate.cjs --tag vX.Y.Z`
 (contents, version-vs-tag, SBOM freshness, evidence). Run by `release.yml`;
 runnable locally.
3. **Package version is the release identifier**: `package.json` `version`
 (currently `1.0.0`) matches the `v*` tag exactly (enforced by
 release validation) and matches the OpenAPI `info.version` (enforced by
 `swagger.plugin.test.ts`). No other identifier exists.
4. **No frozen contract changed without its freeze procedure** (error
 system, API, observability, health).

## 2. Mandatory release gates

| Gate | Canonical implementation | Enforced by |
|---|---|---|
| Typecheck | `npm run typecheck` | ci.yml, release.yml |
| Lint | `npm run lint` | ci.yml, release.yml |
| Tests (incl. contract suites) | `npm test` (serial, live PG) | ci.yml, release.yml |
| Architecture (16 rules) | `npm run architecture:check` | ci.yml, release.yml |
| Migrations applied | `npx prisma migrate deploy` | ci.yml, release.yml |
| OpenAPI validity | in-suite 3.1 meta-schema validation | via tests |
| Production build | `npm run build` → `node dist/main.js` | ci.yml, release.yml |
| Prod dependency audit (zero-tolerance) | `npm run security:dependencies` | ci.yml, release.yml |
| Secret scan | `npm run security:secrets` | ci.yml, release.yml |
| SAST | `npm run security:sast` | ci.yml, release.yml |
| SBOM generate + validate | `npm run security:sbom` | ci.yml, release.yml |
| Release trio validation | `node scripts/release-validate.cjs --tag` | release.yml |
| Artifact set integrity | `node scripts/dist-file-set.cjs --required` (required files + full migration history present) | release-validate.cjs, package.sh |

Every gate fails closed (nonzero exit, no suppression). Full trust-boundary
policy: `docs/release-contract.md`.

## 3. Version / package contract

- **Release identifier:** `package.json` `version` + matching `v*` tag.
 No tags exist in a fresh clone; the first release creates `v1.0.0`.
- **API version is independent:** `/api/v1` is the API major *compatibility*
 contract, not a release number. Package releases do not imply API versions;
 renaming an `operationId` or changing a route is breaking per
 `docs/api-conventions.md` §2 regardless of package version.
- **OpenAPI version is bound:** `info.version` must equal `package.json`
 version (test-enforced). Bumping the package without the document — or vice
 versa — fails CI.
- **No automatic versioning:** no semantic-release, no changelog generation,
 no version bumping. Version changes are deliberate human edits, reviewed
 like any contract change.

## 4. Application artifact contract

- **Build:** `npm run build` (`tsc -p tsconfig.json`) → `dist/`.
- **Entrypoint:** `node dist/main.js` (direct foreground process; no dotenv,
 no supervisor, no migrate/seed).
- **Runtime configuration:** environment only, through validated `src/config`.
 Production requires `DATABASE_URL` (with `sslmode=require`), `JWT_SECRET`
 (≥32 chars), `APP_BASE_URL` (`https://`); `REDIS_URL` optional
 (`redis://`/`rediss://`, never empty — empty is a configuration error).
- **Prisma runtime:** generated client via `@prisma/client` postinstall;
 `prisma/` shipped; single-client singleton preserved.
- **Migrations are explicit:** `npx prisma migrate deploy` by the operator;
 the application never migrates or seeds production
 (`docs/deployment.md`, `docs/migrations.md`).
- **Health expectations:** `/health/live` 200 (dependency-free);
 `/health/ready` 200/503 with `{}` bodies (frozen).

## 5. Container artifact contract

- **Dockerfile:** two-stage build, `USER node`, no added packages,
 `HEALTHCHECK` on `/health/ready` (loopback, `${PORT:-3000}`, BusyBox
 `wget`, 30s/5s/20s/4s/3). Full definition: `docs/deployment.md`.
- **Configuration:** supplied at runtime only; `.env` excluded from the build
 context (`.dockerignore`); no secrets in Dockerfile, healthcheck, or
 compose (asserted by test + verification script).
- **Artifact set:** the shipped file set is computed once, in
 `scripts/dist-file-set.cjs` (tracked files minus `.distignore`). Both this
 validation and `scripts/package.sh` consume it, so what was reviewed is what
 ships. The container files (`Dockerfile`, `.dockerignore`,
 `docker-compose.yml`) are **required** members, and the **complete** on-disk
 migration history must ship — not merely "some" migration. A required file
 that is untracked or excluded **blocks the release**.
- **Verification status (honest):**
 1. Statically verified: Dockerfile, context boundary, compose wiring,
 plus `src/app/deployment-contract.test.ts` and
 `scripts/distribution-artifact.test.ts`.
 2. Runtime-equivalent verified: `npm run verify:deployment` (47 checks:
 real boot, outage, same-PID recovery, SIGTERM). This step **fails** if
 `DATABASE_URL` is unset, because 15 of the 47 checks are the live
 lifecycle; `VERIFICATION_STATIC_ONLY=1` is the explicit, labelled opt-in
 for a definitions-only run.
 3. **Actual image build/runtime NOT verified here** (no Docker daemon;
 carried). Run `docker build` where a daemon exists; do not
 treat (1)+(2) as a substitute.

## 6. Responsibility separation

| Concern | Owner | Proves |
|---|---|---|
| Source correctness | CI (`ci.yml`) | the tree passes every gate |
| Release readiness | Release validation (`release-validate.cjs`, `release.yml`) | the tree satisfies this contract |
| Packagability | Production build + `verify:deployment` | the app builds, boots, and behaves |
| Deployment | Operator / platform (out of scope) | a validated release reaches infrastructure |

CI never deploys. Release validation never publishes on its own (the
`gh release create` step in `release.yml` publishes only from `v*` tags).
No cloud, registry, or production-database credentials exist in CI.

## 7. intentionally deferred (not part of this contract)

Automatic publishing, registries, signing/attestation, container scanning,
deployment automation, rollback automation, blue/green/canary, Kubernetes,
staging environments, changesets/semantic-release. Adding any of these
requires explicit approval and demonstrated need — not this milestone.
