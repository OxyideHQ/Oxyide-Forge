# Database Migrations

> **Status:** This procedure is CURRENT. The lifecycle below was proven on a
> fresh database in (`migrate deploy` → clean `migrate status` → repeat
> deployment → drift/failure behavior). Follow it exactly; do not improvise
> production migration steps.

## Purpose

Define the single authoritative PostgreSQL/Prisma migration operating
procedure for Oxyide Forge: how migrations are created, reviewed, applied,
verified, diagnosed, and kept consistent with the database. A production
engineer follows this document without guessing.

## Scope and Ownership

- In scope: `prisma/schema.prisma`, `prisma/migrations/`, all `prisma migrate`
 invocations, drift handling, migration failure handling, migration testing
 targeting.
- Out of scope: backup scheduling/automation (procedure and backup CLI in
 `docs/backup-recovery.md`), automated rollback (future), expand/contract
 execution (future), CI pipelines (future). Where those matter, this document
 states the operator responsibility instead of pretending the system provides
 them.
- Owners: the engineer authoring a schema change (creation + review); the
 release operator (production application + verification).

## Source of Truth

Three distinct things, three distinct roles:

| Artifact | Role | Location |
|---|---|---|
| `prisma/schema.prisma` | Intended schema (desired state) | Version-controlled |
| `prisma/migrations/` | Migration history (how to get there, step by step) | Version-controlled; **the deployment source of truth** |
| `_prisma_migrations` table | Applied-state record (what this database already ran) | Lives in each database, never edited by hand |

Production schema changes are delivered **only** through committed migration
files applied with `prisma migrate deploy`. The schema file alone never
updates production, and the history table is a record — not source code.

## Migration Lifecycle

```text
PRISMA SCHEMA CHANGE
 ↓
CREATE MIGRATION
 ↓
REVIEW GENERATED SQL
 ↓
APPLY IN DEVELOPMENT
 ↓
TEST
 ↓
COMMIT (schema + migration together)
 ↓
PRODUCTION DEPLOYMENT (`migrate deploy`)
 ↓
 ┌────┴────┐
 SUCCESS FAILURE
 │ │
 ▼ ▼
 VERIFY STOP → INVESTIGATE → RECOVERY PLAN
 │ (never blind retry, never silent repair)
 ▼
COMPLETE
```

## 1. Modify Prisma Schema

Edit `prisma/schema.prisma` only. Do not hand-write SQL first; the migration
tooling generates it. Keep the change minimal and scoped to one intent.

## 2. Create Migration

The repository's supported command (development only):

```bash
npx prisma migrate dev --name <descriptive_name>
```

This generates `prisma/migrations/<timestamp>_<descriptive_name>/migration.sql`
and applies it to the development database. It may create databases and uses
a shadow database as part of development behavior — that is exactly why it is
never a production command (§20).

## 3. Review Migration

Generated migration ≠ approved migration. Every generated file must be read
before commit. The full checklist is below (§10); at minimum confirm the SQL
does what the schema change intended and nothing else.

## 4. Validate Migration

```bash
npx prisma validate
npx prisma migrate status
```

Status must account for every repository migration on the development
database. Resolve discrepancies before committing.

## 5. Apply in Development

`migrate dev` already applied the migration when it was created. If the
development database was reset or replaced since, re-apply with the same
command and re-verify status.

## 6. Verify Development

Run the application and the test suite against the migrated development
database. Exercise every affected path (auth registration/login, user CRUD,
role reads).

## 7. Commit Migration

Commit `prisma/schema.prisma` and the new `prisma/migrations/<...>/`
directory together, in one change. A schema change without its migration (or
vice versa) is incomplete.

## 8. Deploy Application + Migration

Follow the Production Workflow below. Migration files ship with the release;
`prisma migrate deploy` runs against production before application start.

## 9. Verify Production

Follow the Verification section below. Deployment is complete only after a
clean status, verified schema, and passing health checks.

## Migration Naming

The repository convention is the Prisma-generated form (verified against the
committed files):

```text
20260919145131_init
20260919205337_add_role_to_user
^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^
timestamp descriptive slug (communicates intent)
```

`YYYYMMDDHHMMSS` ordering keeps history chronological. Never rename an
existing migration. Never rewrite migration history. Slugs must communicate
intent (`add_role_to_user`, not `update2`).

## Migration Review

Review every generated migration before commit. Generated SQL is not
automatically production-safe.

Inspect: `CREATE/ALTER/DROP TABLE`, `ADD/DROP COLUMN`, `ALTER COLUMN`,
`CREATE/DROP INDEX`, `UNIQUE` constraints, foreign keys, nullability changes,
default changes, data transformations, locking implications, table-rewrite
implications, long-running operations, destructive operations, and
compatibility with the currently deployed application code.

For destructive or high-risk changes: require explicit human review, consider
deployment sequencing, consider the expand/contract approach (Expand /
Contract Strategy below) — do not casually deploy.

### Review Checklist

- [ ] Migration matches the intended schema change, nothing more
- [ ] No accidental table/column drops
- [ ] No accidental data loss
- [ ] Index changes reviewed
- [ ] Unique constraints reviewed
- [ ] Foreign keys reviewed (including referential actions)
- [ ] Nullability reviewed
- [ ] Default changes reviewed
- [ ] Large-table impact considered (size, locks, rewrites, duration)
- [ ] Existing deployed application remains compatible
- [ ] New application code is compatible with the old schema where required
- [ ] Rollout ordering considered
- [ ] Migration is deterministic (no timestamps/randomness in SQL)
- [ ] Migration is committed together with the schema change
- [ ] Tests cover the affected behavior

The checklist reduces risk; it does not guarantee safety.

## Development Application

```text
schema change → create migration → review → apply in development → tests → commit
```

- Migrations apply incrementally; history is tracked in `_prisma_migrations`.
- Never hand-edit an applied migration file.
- An unshared, uncommitted migration may be regenerated through the normal
 `migrate dev` flow (delete the directory, adjust the schema, re-run).
- Once committed or shared, treat migration history as immutable (§31).

## Production Application

```text
1. build/test application
2. ship migration files with the release
3. run `prisma migrate deploy`
4. require clean `prisma migrate status`
5. verify the database (spot-check schema objects)
6. start/restart the application
7. verify health endpoints and affected paths
8. monitor
```

**Production uses migration deployment, not migration development.**
The exact command is `npx prisma migrate deploy`, verified against Prisma
6.12.0 in this repository.

### Production Prerequisites

- `DATABASE_URL` targets the intended production database (verify the value;
 never paste it into tickets or logs — placeholders only).
- Production TLS policy satisfied (`sslmode=require` is enforced by
 configuration; see `docs/deployment.md`).
- Migration files are from the exact release being deployed.
- A reviewed migration with passing development/test validation.
- Operator holds appropriate database privileges.
- A backup/recovery path is available if the operation requires one
 (operator responsibility; procedure and backup CLI in
 `docs/backup-recovery.md`, scheduling remains operator-owned).
- Deployment window and blast radius considered.

## Migration Status

```bash
npx prisma migrate status
```

What to look for:

| Output | Meaning | Action |
|---|---|---|
| `Database schema is up to date!` (exit 0) | Every repository migration is applied | Proceed |
| Pending migrations listed (exit ≠ 0) | History behind files | Deploy or investigate; do not start the app as if current |
| Failed migration reported (exit ≠ 0) | A migration failed | STOP → Failure procedure |
| History cannot be verified / DB unreachable (exit ≠ 0) | Unknown state | STOP → investigate connectivity and history |

Status verifies migration *history*. It does **not** verify physical schema
correctness: proved status stays clean when schema objects are changed
out-of-band (e.g., a dropped index). History checks and schema checks are
different; run both where it matters (see Drift Detection).

## Migration Verification

Separate from status. Proportional to risk.

Standard verification (every production migration):

1. `migrate deploy` succeeds.
2. `migrate status` is clean.
3. Expected tables/columns/constraints/indexes exist (spot-check against the
 migration SQL, not the whole database).
4. Application starts; `/health/live` and `/health/ready` return 200.
5. One affected application path is exercised end to end.
6. Logs show no unexpected database errors.

High-risk migrations add: extended health monitoring, staged rollout
observation, explicit rollback-readiness review (forward-fix plan, since no
automatic rollback exists).

## Migration Failure

Dedicated procedure. The first rule is **STOP** — do not retry blindly.

1. Stop the deployment. Do not continue as if migration succeeded.
2. Capture: migration name, full error text, command, target database identity
 (host/database name only — never credentials).
3. Run `prisma migrate status`; classify the state (§Failed Migration Recovery).
4. Determine whether the migration was applied, failed cleanly, or partially
 changed state (PostgreSQL transactional DDL rolls a failed migration back;
 see the caveat in Failed Migration Recovery).
5. Inspect actual database state (tables/constraints/indexes from the
 migration SQL).
6. Decide whether the application must remain stopped.
7. Choose a recovery path deliberately; never silently repair.
8. Verify history, schema, and application compatibility before resuming.
9. Resume deployment only after explicit verification.

## Failed Migration Recovery

Distinguish carefully — these are different situations:

- **A. Failed before application:** nothing changed; fix the cause, re-run.
 Safe to retry the same command after fixing the underlying problem.
- **B. Failed with transactional rollback:** PostgreSQL rolled the migration
 back (observed behavior for failed migration SQL in testing); history
 marks it failed. Recover by fixing forward or by explicit `resolve`
 (§Migrate Resolve) once the database state is verified unchanged.
- **C. Partial changes suspected:** stop and inspect. Not every conceivable
 operation is guaranteed atomic; verify object-by-object against the
 migration SQL before any recovery step.
- **D. Marked failed in history:** the database records the failure. Do not
 re-run blindly; follow the resolve procedure below.
- **E. Reported failure but actually applied:** verify first (`status` +
 schema inspection). Only then decide between forward-fix and resolve.

### Migrate Resolve

`prisma migrate resolve` is an **exceptional operator-only recovery tool**,
never a normal deployment command. Verified flags in Prisma 6.12.0:

- `--applied <name>` — records the migration as applied **without running
 its SQL**. Appropriate only when the operator has verified the schema
 changes are already present.
- `--rolled-back <name>` — records the migration as rolled back. Appropriate
 only when the operator has verified none of its changes are present.

Why it is dangerous: it changes migration *history*, not schema. It repairs
nothing by itself. Using `--applied` to silence a status error without
verifying the schema manufactures a lie the next deployment will inherit.
Prerequisites every time: known actual state, explicit justification,
post-recovery `migrate status` clean **plus** schema spot-checks.

## Prohibited Production Commands

| Command | Category | Reason |
|---|---|---|
| `prisma migrate dev` | **PROHIBITED for normal production deployment** | Development authoring behavior (creates databases, uses shadow DB, generates migrations) |
| `prisma db push` | **PROHIBITED for normal production deployment** | Bypasses migration history entirely; acceptable only in throwaway local prototyping, never as the Forge deployment workflow |
| `prisma migrate reset` | **PROHIBITED, no exceptions in production** | Destructive (drops and recreates); development/test only |
| `prisma migrate resolve` | **EXCEPTIONAL operator-only recovery** (see above) | Changes history; requires verified state + justification |
| Manual `_prisma_migrations` edits | **PROHIBITED, no exceptions** | Fabricates history outside every verification mechanism |
| `prisma db seed` in production | **Refused by the repository** | Seed entry point exits non-zero in production; seed is not part of deployment |

## Seed Separation

Migration changes schema. Seed inserts data. They are separate operations
with separate commands and separate safety rules:

- `prisma migrate deploy` never invokes the seed.
- `npm run db:seed` / `npx prisma db seed` never runs migrations.
- Application startup invokes neither.
- Production seed execution is refused by `prisma/seed.ts`; seed is not part
 of the deployment sequence above.

## Schema Drift

Drift means the live database schema differs from what the committed
migration history represents. Causes include manual SQL, `db push`,
emergency changes, edited/deleted migration files, out-of-band tooling,
restores from inconsistent states, and incomplete recoveries. Drift is not
always someone's fault; the procedure is the same regardless of cause.

### Drift Detection

The validated mechanism (Prisma 6.12.0):

```bash
npx prisma migrate diff --from-migrations prisma/migrations --to-url "$DATABASE_URL" --shadow-database-url "$SHADOW_DATABASE_URL" --script
```

- A shadow database is **required** with `--from-migrations`; it must be
 empty and disposable.
- An empty migration script means no drift. A non-empty script describes the
 drift precisely (verified: a dropped index produced the exact `DROP INDEX`
 delta).
- `migrate status` does **not** detect this class of drift — it stayed clean
 with a missing unique index in testing. Always pair history checks
 with schema checks where correctness matters.

### Drift Handling

```text
DETECT → STOP NORMAL MIGRATION → IDENTIFY DIFFERENCE → CLASSIFY →
DETERMINE SOURCE → CHOOSE REPAIR PLAN → VERIFY → RESUME DEPLOYMENT
```

Never `db push` to "fix drift". Never delete migration records. Never edit
`_prisma_migrations` directly. Never blindly `migrate resolve`. Every repair
is deliberate, reviewed, and verified.

### Drift Classification

| Class | Example | Proceed? | Handling |
|---|---|---|---|
| A. Expected state | No diff | Yes | Normal deployment |
| B. Missing migration application | Pending in status | Only via `migrate deploy` | Standard path |
| C. Extra database object | Unknown table/index | **Stop** | Investigate source; remove or adopt deliberately |
| D. Missing database object | Dropped index/constraint | **Stop** | Investigate; restore via forward migration, never by editing history |
| E–G. Modified column/constraint/index | Altered definitions | **Stop** | Investigate; forward-fix migration after review |
| H. Manual production change | Emergency SQL | **Stop** | Reconcile deliberately (hotfix migration or documented resolve) |
| I. History inconsistency | History disagrees with files | **Stop** | Out-of-band reconciliation policy (§Out-of-Band Databases) |
| J. Unknown drift | Unclassifiable diff | **Stop** | Human investigation required; no automatic repair exists |

### Out-of-Band Databases

If tables exist but `_prisma_migrations` is missing or untrusted:

1. Do NOT blindly run `migrate deploy`.
2. Do NOT manually fabricate migration history.
3. Inspect the actual schema (tables, columns, constraints, indexes).
4. Compare with the expected migration result (`migrate diff`, above).
5. Back up the database before any reconciliation.
6. Determine whether the database is disposable.
7. If disposable, recreate it and run migrations from zero.
8. If non-disposable, require an explicit, reviewed reconciliation plan.
9. Never guess migration state.

## Manual SQL Policy

Normal schema changes go through migration files, no exceptions for routine
work. Emergency production SQL follows an exceptional process: minimal,
reviewed, logged change; afterwards the schema **must** be reconciled with
migration history through a deliberate migration or documented recovery —
permanent divergence is never silently accepted, and history is never edited
directly to paper over it.

## Migration Immutability

A committed or shared migration is immutable. Never edit an applied
production migration to "fix" it — corrections go in a **new** migration.
Failed migrations follow the failure/recovery procedure, not history edits.

## Deployment Compatibility

Application code and database schema can briefly exist at different release
stages. Before deploying, decide the order deliberately:

- Current additive migrations: migrate-then-start is safe (proven for the
 two committed migrations, which only create tables/columns/indexes).
- Future destructive or breaking changes: sequence explicitly
 (compatible-expand migration → new application → contract migration later),
 following the Expand / Contract Strategy below. Do not implement
 expand/contract infrastructure here, and do not casually deploy a
 breaking migration as if it were additive.

 following the Expand / Contract Strategy below. Do not implement
 expand/contract infrastructure here, and do not casually deploy a
 breaking migration as if it were additive.

## Expand / Contract Strategy

This section defines how to evolve a live PostgreSQL schema while old and
new application instances may temporarily coexist. It is procedure, not
infrastructure: no new framework, service, or abstraction is introduced.

Label convention used throughout: **REPOSITORY-PROVEN** means demonstrated
by the current schema, migrations, or tests in this repository.
**GENERAL PRODUCTION PATTERN** means the industry-safe procedure for cases
this schema has not exercised yet. Never mistake one for the other.

The compatibility model:

```text
OLD APPLICATION + OLD DATABASE
 ↓ EXPAND MIGRATION (additive only)
OLD + NEW APPLICATION SAFE on one database
 ↓ BACKFILL (separate phase)
DATA COMPLETE under both versions
 ↓ SWITCH APPLICATION (reads, then writes)
NEW APPLICATION ONLY
 ↓ CONTRACT MIGRATION (after all gates)
OLD STRUCTURE REMOVED
```

Critical rule: **no migration may make the database incompatible with a
still-running application version.** Evaluate every migration against the
current, previous, and next application version, the deployment order, and
rollback possibility.

### Current Schema Position (REPOSITORY-PROVEN)

- Models: `User`, `Credential` (1:1 via `Credential.userId → User.id`,
 `ON DELETE RESTRICT`, `ON UPDATE CASCADE`).
- Column types in use: `TEXT` (ids, email, names, status, role, hashes),
 `TIMESTAMP(3)` (timestamps), nullable `TEXT` (`displayName` only).
- No database enums exist: `status` values (`active`, `inactive`,
 `suspended`) are enforced by route schemas, not by the database; `role`
 defaults to `'user'` with role/permission semantics living in code
 (`src/modules/authorization/`), not in tables.
- Unique constraints: `User.email`, `Credential.userId` (each backed by a
 unique index). Primary keys: `User.id`, `Credential.id`.
- Repository access is single-row `findUnique`/`create`/`update`/`delete`
 through the shared Prisma client; no joins, no raw SQL, no advisory
 locks, no `LISTEN`/`NOTIFY`, no session state.
- Committed history is additive-only (enforced by
 `prisma/migrations.additive.test.ts`): table/index creation plus one
 nullable-safe `ADD COLUMN... NOT NULL DEFAULT`, which backfilled existing
 rows at migration time.

### Change-Type Matrix

| Change type | Current Forge example | Required strategy | Code change? | Migration change? |
|---|---|---|---|---|
| Additive column | `role` added with `NOT NULL DEFAULT` (REPOSITORY-PROVEN) | Expand nullable (or defaulted); backfill if needed; contract nothing | Only to use the field | Yes, one additive migration |
| Column rename | None (GENERAL PRODUCTION PATTERN) | 7-phase rename below; never single-step physical rename | Dual-read/write, then cleanup | Yes: expand migration, later contract migration |
| Column removal | None (GENERAL) | Remove code dependency → deploy → expire rollback window → verify → contract | Yes, before contract | Yes, contract migration only after gates |
| Type change | None (GENERAL) | New representation → backfill → switch → contract; validate every row converts without loss | Yes | Yes, expand + contract |
| NOT NULL constraint | `role` via default (REPOSITORY-PROVEN for empty-table-safe case) | Add nullable → backfill → verify no nulls → enforce (GENERAL for populated tables) | Maybe | Yes |
| UNIQUE constraint | `User.email` at table creation (REPOSITORY-PROVEN) | Verify no duplicates → create index → add constraint; consider locking on large tables (GENERAL) | No | Yes |
| Index add/remove | Unique indexes at creation (REPOSITORY-PROVEN) | Add freely; remove only after proving no query/permission depends on it (GENERAL) | No | Yes |
| Enum add/remove | None — no DB enums exist (REPOSITORY-PROVEN absence) | Add value: usually compatible; remove/rename value: expand/contract (GENERAL) | Yes | Yes |
| Foreign key add/change/remove | `Credential_userId_fkey` at creation (REPOSITORY-PROVEN) | Verify orphan rows first; consider locks on large tables; never drop integrity to ease migration (GENERAL) | No | Yes |
| Large-table migration | None (GENERAL) | Split into small additive steps; bounded backfill; separate index/constraint/contract operations | As needed | Yes, several small ones |

### Phase 1 — Expand

Make the database support the new application without breaking the old one:

- Add nullable columns, new tables, new indexes, non-breaking constraints.
- Prefer compatibility defaults only where the default is safe for old
 writers (a default changes what old inserts produce — review the actual
 SQL, do not assume Prisma schema defaults confer compatibility).
- The expand migration must not require the old application to understand
 the new schema. Old code paths keep working untouched.

### Phase 2 — Backfill (separate phase, no framework)

Backfill is an operational phase, not a migration feature and not a
framework. This repository provides no backfill engine; the operator runs
bounded, observable batches, for example conceptually:

```sql
-- Repeat until zero rows remain; each batch is its own transaction.
UPDATE "User" SET "new_column" = <derived value>
WHERE "new_column" IS NULL AND "id" > <last_seen_id>
ORDER BY "id" LIMIT <batch_size>;
```

Batch size is deployment-specific (no universal numbers here). Backfills must
be resumable (deterministic `WHERE new_column IS NULL`-style condition),
bounded (small transactions: lock duration, WAL, replication, vacuum, and
connection occupancy stay contained), idempotent (re-running changes
nothing already migrated), and interruptible, with progress measured as rows
remaining/completed. Never `UPDATE` a whole large table in one transaction.
Never corrupt already-migrated rows with a blind update.

### Phase 3 — Application Migration

Order of transition: old read/write → dual-compatible code → backfill →
new read → new write → old path disabled. Dual-write only where necessary:

- Use it when old and new representations must coexist, values cannot be
 derived deterministically at read time, both versions may write, and
 consistency between representations is required.
- Skip it when a nullable addition plus deterministic backfill suffices,
 when a database default safely covers old writers, or when the new
 structure needs no immediate population.

Where dual-write is used, document write ordering, failure semantics, source
of truth, reconciliation, verification, and eventual removal. No generic
dual-write framework is created.

During partial backfill the new code must tolerate both states (populated
and unpopulated rows). Never switch reads to the new column before the
application handles incomplete population.

### Phase 4 — Contract (gates first)

Contract only when every gate holds:

- [ ] GATE 1: no deployable application version reads or writes the old structure
- [ ] GATE 2: the rollback window closed (contract ends safe application rollback)
- [ ] GATE 3: the new application is stable in production
- [ ] GATE 4: backfill is complete and verified
- [ ] GATE 5: data verification complete (conversion without loss where applicable)
- [ ] GATE 6: old structure provably unused (code search; query/log evidence where available)
- [ ] GATE 7: the contract migration itself reviewed (it is destructive by definition)
- [ ] GATE 8: operational recovery plan understood (forward-fix; no automatic rollback exists)

Then — and only then — remove the old column/index/constraint/table,
tighten nullability, and remove compatibility code. Never contract merely
because the new application deployed once: deployment completion and
compatibility-window completion are different events.

### Rollback Window

Application rollback ≠ database rollback. After expand, the database
supports both versions, so a failed new release can roll back to the old
application safely. After contract, the old application may no longer be
compatible — **contract ends the safe application rollback window.** State
this explicitly in every contract review.

### Column Rename

Never ship `ALTER TABLE... RENAME COLUMN` as a single production step while
old versions may exist. A physical rename breaks old code immediately;
follow the logical rename instead:

1. Phase 1: add the new column (nullable).
2. Phase 2: application supports old + new.
3. Phase 3: backfill new from old.
4. Phase 4: switch writes to new.
5. Phase 5: switch reads to new.
6. Phase 6: verify the old path is unused.
7. Phase 7: contract the old column (gated).

### Column Removal

1. Remove every application dependency on the column.
2. Deploy and let it bake.
3. Allow the rollback window to expire.
4. Verify no old instances can exist (operator/deployment platform must
 establish this; Forge provides no version registry and none is created
 here).
5. Contract the column through the gates above. With coexisting versions,
 contract only after the oldest compatible version is impossible.

### Type Changes

High-risk: `INTEGER → BIGINT`, `TEXT → VARCHAR`, `TEXT → JSON`, string →
enum, nullable → non-nullable, precision changes. For each ask: can old and
new versions both read and write? Can conversion fail, lose information, or
prove irreversible? Will PostgreSQL rewrite or lock the table, invalidate an
index? Do not claim every type change is safely doable in place. Prefer new
representation → backfill → switch → contract, and verify beforehand that
every existing row converts deterministically with no truncation, no
precision loss, no invalid values, and equivalent application semantics.
Prisma schema validation alone never proves this; the PostgreSQL conversion
behavior must be understood.

### Constraint Changes

- `NOT NULL`: add nullable → backfill → verify zero nulls → enforce. Never
 add `NOT NULL` to a populated column without completing the first three
 steps (the `role` precedent was safe only because `DEFAULT 'user'`
 backfilled every row atomically at migration time).
- `UNIQUE`: verify no duplicates first, consider index creation and locking
 on large tables, then add. Never constrain data that does not satisfy it.
- `CHECK` and foreign keys: same verify-first discipline; for foreign keys
 also verify orphan rows and lock implications, and never drop referential
 integrity merely to make a migration easier.

### Index Changes

Add freely; replace and remove carefully. Before dropping an index verify no
query depends on it, no unique constraint or foreign-key behavior requires
it, a replacement exists where needed, application versions are compatible,
and performance impact is acceptable. Never drop an index merely because the
Prisma schema no longer declares it. For large production tables consider
PostgreSQL's concurrent index capabilities — but Prisma-generated SQL does
not automatically produce the safest concurrent strategy, so generated
migrations requiring it need manual review and possibly hand-authored SQL
(committed as the migration, never edited after application).

### Enum Changes

No database enums exist in this schema (`status`/`role` are application-level
strings), so all of the following is GENERAL PRODUCTION PATTERN: adding a
value is usually compatible; removing or renaming a value is destructive —
expand with a compatible representation, migrate the application, backfill,
remove old usage, then contract. Never assume Prisma makes enum removal
safe or reversible. If PostgreSQL-version-specific enum behavior matters for
a future change, document the requirement then; nothing is invented here.

### Foreign-Key Changes

Adding: verify orphan rows first. Changing `ON DELETE`/`ON UPDATE`: verify
application correctness under the new action (the current `RESTRICT`/`CASCADE`
pair exists precisely so credential cleanup ordering is enforced — see the
users removal transaction). Removing: never, to ease migration. Large tables:
consider lock implications. Referential integrity is a correctness property,
not migration friction.

### Large Tables

No measured thresholds exist in this repository, so `small` / `medium` /
`large` are operational concepts, not numbers. Before migrating a large or
hot table assess: row count, size, index count, traffic, transaction
duration, expected locks, WAL, replication, autovacuum, disk space, latency,
and deployment window. Prefer many small additive steps over one enormous
migration: never combine ALTER + backfill + index + constraint + contract in
a single change. Split index, constraint-tightening, and contract operations
into separately deployable, separately verifiable migrations.

### Locking and Transaction Boundaries

Schema changes acquire locks; do not claim PostgreSQL migration is always
online or that nullable additions are always zero-impact. Consider active
transactions, long queries, concurrent writes, index operations, and rewrites
in review. Do not assume every DDL combination is safe in one transaction and
do not assume Prisma's migration transaction behavior guarantees zero
downtime — a migration with special transactional requirements gets explicit
review. Precise per-operation lock analysis belongs to that review, not to
generic promises here.

### Deployment Order

Two supported shapes; choose by actual compatibility, neither is universal:

- Normal additive: migration → compatible application → backfill → switch →
 contract later.
- Where the application must lead: compatible application → expand schema →
 rollout → backfill → switch → contract.

### Rolling and Partial Deployment

Assume old and new instances coexist (v1 beside v2); the database must serve
both throughout. Blue/green deployment does not remove this requirement —
cutover still has a coexistence window. If only some instances upgraded, the
new schema stays compatible with old ones. If new instances fail, old ones
keep operating until contract. If expansion succeeded but the application
deployment failed, do NOT contract to "clean up": the expanded schema is a
compatible superset; leave it until understood.

### Expand Failure vs Contract Failure

Expand failure: STOP. Determine what applied (transactional DDL usually rolls
back — verify, do not assume), confirm application compatibility with actual
state, retry only when safe; never proceed to contract; never delete history.
Use the failure procedure. Contract failure is different: the obsolete
structure usually still exists, so the application often keeps working — do
not retry blindly; investigate; a failed contract is frequently safer than a
failed expand precisely because nothing was removed yet.

### Rollback Limitations

Expand is usually forward-compatible; contract is often irreversible;
transformations may be lossy. "Rollback" therefore means one of: redeploy the
old application while the expanded schema remains; restore compatibility;
forward-fix migration; restore from backup if data was destructively changed.
Backup procedure and tooling live in `docs/backup-recovery.md`; rollback and
recovery decisions live in `docs/rollback-recovery.md` — this strategy
promises neither automatic rollback nor automatic restore, and relies on
neither.

### Data Loss Classification

Destructive operations — `DROP COLUMN`, `DROP TABLE`, row `DELETE`s, lossy
type conversions, enum value removals — require explicit review,
verification, contract-phase gating, and rollback-limitation acknowledgment.
They are never ordinary deployment steps.

### Migration Safety Matrix

| Change | Expand | Backfill | App transition | Contract | Risk |
|---|---|---|---|---|---|
| Add nullable column | Add nullable | Populate, verify | Use when ready | N/A (nothing to remove) | Low |
| Add column + NOT NULL | Add nullable or defaulted | Backfill, verify zero nulls | Use when ready | Enforce NOT NULL only after gates | Low–medium |
| Rename column | Add new nullable | Copy old→new, verify | Dual-read/write → new only | Drop old after gates | Medium |
| Remove column | N/A (dependency removal is the "expand") | N/A | Remove all uses, deploy, wait | Drop after gates | High (irreversible) |
| Type change | Add new representation | Convert + verify every row | Switch reads/writes | Remove old after gates | High |
| Add NOT NULL | (covered above) | Backfill + verify | None needed | Enforce after gates | Medium |
| Add unique/index | Create index | Verify no duplicates first | None needed | N/A | Low–medium (locks on large tables) |
| Remove index | Verify no dependency | N/A | None needed | Drop after gates | Medium (performance) |
| Add FK | Verify orphans | N/A | None needed | N/A | Low–medium (locks) |
| Remove FK | Prove integrity kept elsewhere | N/A | None needed | Drop after gates | High (correctness) |
| Add enum value | Add value | N/A | Use when ready | N/A | Low |
| Remove enum value | New representation/value | Migrate + verify zero usage | Switch fully | Remove after gates | High |

Only the additive rows are REPOSITORY-PROVEN today; all others are GENERAL
SAFE PATTERNS as labeled in each section.

### Representative Example (ILLUSTRATIVE — not implemented)

Suppose `User.displayName` must become a structured `firstName`/`lastName`
pair. Nothing below is applied; no migration exists for it.

- Phase 1 (expand migration): `ADD COLUMN "firstName" TEXT`,
 `ADD COLUMN "lastName" TEXT`, both nullable. Old code untouched and valid.
- Phase 2 (application): read `displayName`, falling back to
 `firstName`/`lastName` when populated; write both representations.
- Phase 3 (backfill): bounded, resumable batches split the existing
 `displayName` value, `WHERE "firstName" IS NULL`, verifying row counts
 before and after.
- Phase 4 (application): switch reads to the new columns once backfill is
 verified complete, then switch writes; disable the old path.
- Phase 5 (verify): rollback window expires, no old-version instances remain,
 no code references `displayName`.
- Phase 6 (contract migration, gated): `DROP COLUMN "displayName"`.

Had this been implemented, Phase 1 and Phase 6 would be separate immutable
migrations, never one combined step.

### Prisma-Specific Notes (verified against 6.12.0 in this repo)

- Prisma generates migrations from schema diffs; it does not design
 expand/contract sequences. The engineer owns compatibility.
- Prisma does not infer renames: a renamed field generates `DROP COLUMN` +
 `ADD COLUMN` (data loss by default). Review catches this; the rename
 procedure above replaces it.
- Generated SQL determines PostgreSQL behavior — approve the SQL, never just
 the schema diff.
- Migration files, once applied or shared, are immutable; phases are separate
 migrations.

### Observability

Observe with existing mechanisms (no new platform is built here): migration
duration, lock waits, query latency, error rate, backfill progress and rows
remaining, application version distribution during rollout, and old-path
usage where available. What cannot be observed must be verified by explicit
checks before contract.

### Operational Runbook

```text
BEFORE EXPAND: review SQL → verify compatibility → STOP if uncertain
EXPAND: deploy migration → verify status + schema → STOP on failure
APPLICATION: deploy compatible code → verify health → STOP on errors
BACKFILL: run bounded batches → verify counts → STOP on inconsistency
SWITCH: reads → verify → writes → verify → disable old path
OBSERVE through the rollback window → STOP contracting on any regression
VERIFY old versions gone → VERIFY gates 1–8 → CONTRACT → VERIFY
```

### Stop Conditions

Stop when: any migration fails; lock waits exceed the accepted operational
window; conversion errors appear; backfill cannot stay consistent; any old
application still needs the old schema; the new application mishandles
partially migrated data; verification fails; error rates rise unexpectedly;
database capacity is under pressure; or rollback compatibility is uncertain.
No numeric thresholds are prescribed here — the repository has no measured
operational limits; windows are set per deployment, not per starter.

### Current vs Future vs Operator (scope)

- CURRENTLY PROVIDED BY FORGE: Prisma migrations, `migrate deploy`, `migrate
 status`, drift detection, migration safety tooling, additive-only history
 (guard-tested), and now this strategy document.
- STRATEGY USERS FOLLOW: everything above on this page.
- OPERATOR RESPONSIBILITY: targets, backups, privileges, windows, monitoring,
 version-distribution truth, and every human gate.
- FUTURE: backfill engine (none exists — batches are operator-run),
 version registry (none exists), automatic contract gating, automatic
 rollback (strategy: `docs/rollback-recovery.md`; no automation exists),
 online migration orchestration, backup scheduling and
 automation (procedure and backup CLI exist — see `docs/backup-recovery.md`).

## Large-Table Review Notes

For migrations touching large or hot tables, the reviewer additionally
considers: table size, lock duration, index build behavior, concurrent
traffic, rewrite operations, long-running transactions, deployment windows,
and monitoring. No repository-specific optimization technique is prescribed
here; the requirement is that the review happens and is recorded with the
change.

## Migration Testing

The repository proves its migration lifecycle with `prisma/migrate.integration.test.ts`:

- Fresh-database deployment, repeated deployment, clean status, history
 verification, pending detection, failure + explicit recovery, drift
 clean-case — all against explicitly declared disposable databases.
- Targeting safety (preserved): tests require
 `OXYIDE_MIGRATION_TEST_URL` (plus `OXYIDE_MIGRATION_SHADOW_URL` for drift);
 the ambient `DATABASE_URL` is never a fallback; production, shared,
 protected, missing, empty, and unparseable targets are refused before any
 I/O; without the variables the suite is visibly skipped (which is not full
 validation). Drift mutations run only through the guarded helper that
 restores state in a `finally` block.

## Migration History

- `prisma/migrations/` (version-controlled): `20260919145131_init`,
 `20260919205337_add_role_to_user`,
 `20260928164759_add_session_refresh_token` (: additive `Session` +
 `RefreshToken` tables with unique token-hash, session, and expiry indexes
 and `RESTRICT`/`CASCADE` foreign keys — new tables/indexes/constraints only,
 no existing object touched), and
 `20260929001631_add_refresh_rotation_state` (: three nullable columns —
 `RefreshToken.consumedAt`, `RefreshToken.supersededBy` (+ unique index),
 `Session.revokedAt` — plus the self-referential `TokenSuccession` FK
 (`ON DELETE SET NULL`, deletion-order safe) — no existing object altered),
 and
 `20260929092017_add_refresh_token_revoked_at` (: one nullable column —
 `RefreshToken.revokedAt` — no existing object altered), and
 `20260929054005_add_password_reset_token` (: additive
 `PasswordResetToken` table with unique token-hash and userId indexes and a
 `RESTRICT`/`CASCADE` foreign key — new table/indexes/constraint only, no
 existing object touched), and
 `20260929065057_add_email_verification` (: nullable `User.emailVerifiedAt`
 column plus additive `EmailVerificationToken` table with unique token-hash
 and userId indexes and a `RESTRICT`/`CASCADE` foreign key — existing rows
 read NULL as never-verified, no existing object altered), and
 `20260929082007_add_login_throttle` (: additive `LoginThrottle` table
 with primary-key `key`, `failureCount`, `windowStartedAt`, `expiresAt`, and
 an `expiresAt` index for opportunistic cleanup — new table/index only, no
 existing object touched), and
 `20260929112728_add_user_locked_until` (: one nullable column —
 `User.lockedUntil` — existing rows read NULL as unlocked, no existing
 object altered, no index: every access is via the unique-email lookup),
 in chronological order.
- Note: the migration file was hand-authored in exact Prisma dialect
 because `migrate dev` requires an interactive TTY for the unique-constraint
 confirmation and the automation shell provides none; equivalence was proven
 by `migrate deploy` + clean `migrate status` + object-by-object
 information-schema verification (see the audit report).
- `_prisma_migrations` (per database): records applied migrations with
 timestamps and checksums; a clean `migrate status` additionally validates
 file integrity.
- The two must correspond. Mismatch means investigation, never direct edits.

## Production Target Safety

Normal production deployment **intentionally** targets production — that is
its job, governed by the procedure, prerequisites, and verification above.
Migration *test tooling* is the opposite case: it must target only explicitly
declared disposable databases per the safety contract. Do not confuse the two
models, and do not weaken either.

## DATABASE_URL Safety

- Examples use placeholders (`postgresql://USER:PASSWORD@HOST:PORT/DATABASE`)
 — never real credentials, never pasted into tickets or logs.
- Production `DATABASE_URL` must satisfy the enforced TLS policy
 (`sslmode=require`; see `docs/deployment.md`).
- Verify the value targets the intended database before every manual Prisma
 command; the guards protect automated tooling, not arbitrary shell usage.

## Incident Runbook (Migration Failure at 2 AM)

1. Stop the deployment. Do not retry blindly.
2. Capture: migration name, full error, command, target identity (host/name
 only — never credentials).
3. Run `prisma migrate status`; classify per Failed Migration Recovery above.
4. Inspect actual database state against the migration SQL.
5. Decide whether the application stays stopped.
6. Choose a recovery path (forward-fix by default; `resolve` only with
 verified state + justification).
7. Verify history (`status` clean), schema (spot-checks), and application
 compatibility.
8. Resume deployment only after explicit verification.

There is no automatic rollback. Recovery decisions (compatible application
rollback vs forward-fix vs verified restore) follow
`docs/rollback-recovery.md`; until decided, recovery is forward-fix or
deliberate resolve — both human decisions.

## Verification Checklists

Before:

- [ ] Correct release (migration files match the deployed version)
- [ ] Correct `DATABASE_URL` (intended database, verified value)
- [ ] Correct environment (TLS policy satisfied)
- [ ] Migration reviewed (checklist above complete)
- [ ] Application compatibility checked (old and new code vs schema)

During:

- [ ] `migrate deploy` succeeds without unexpected errors
- [ ] No failure state recorded

After:

- [ ] `migrate status` clean
- [ ] Expected schema objects verified
- [ ] Health checks pass (`/health/live`, `/health/ready`)
- [ ] Affected API path exercised
- [ ] Logs checked for database errors
- [ ] Deployment proceeds only now

High-risk migrations expand verification (extended monitoring, staged
observation, explicit rollback-readiness review).

## Command Reference

All commands verified against Prisma 6.12.0 in this repository:

| Command | Purpose | Environment | Safe? | Notes |
|---|---|---|---|---|
| `npx prisma migrate dev --name <n>` | Author a migration | Development only | Yes, in dev | Creates/applies migration; uses shadow DB; never production |
| `npx prisma migrate deploy` | Apply pending migrations | Production (+dev) | Yes | The production command; repeat-safe |
| `npx prisma migrate status` | Show history vs files state | Any | Yes (read-only effect) | Exit 0 only when clean; does not detect physical drift |
| `npx prisma migrate diff --from-migrations … --to-url … --shadow-database-url … --script` | Compare migrations vs live DB | Any with disposable shadow | Yes (read-only) | Shadow DB required; empty script = no drift |
| `npx prisma migrate resolve --applied/--rolled-back <name>` | Mark history after verified state | Exceptional recovery only | Only with verified state + justification | Changes history, repairs nothing by itself |
| `npx prisma db push` | Sync schema without history | Throwaway prototyping only | **No, in production** | Bypasses migration history entirely |
| `npx prisma migrate reset` | Drop, recreate, re-seed | Development/test only | **Never production** | Destructive by design |
| `npx prisma db seed` | Run `prisma/seed.ts` | Dev/test only | Yes, in dev/test | Refused in production; never part of migration deployment |
| `npx prisma generate` | Regenerate Prisma Client | Any | Yes | After install or schema changes |
| `npx prisma validate` | Validate schema file | Any | Yes (offline) | Syntax only, not drift |

## Current vs Future vs Operator Responsibility

- **CURRENT:** everything in this procedure as written (proven lifecycle,
 validated commands, enforced targeting guards).
- **FUTURE (explicitly not provided):** automatic rollback, automatic drift
 repair, automatic pre-migration backup, automatic migration approval, CI
 production gates, expand/contract execution, backup scheduling and automation.
 (Backup/restore *procedure* and backup CLI are provided — see
 `docs/backup-recovery.md`.)
- **OPERATOR RESPONSIBILITY:** correct target values, backups where required,
 privilege management, deployment windows, monitoring, and every human
 decision point marked above.

## Historical Record (Preserved)

The authorization below is historical context from the authentication
milestone. It is preserved byte-identical and does not describe current
procedure — the current procedure is everything above.

---

## Initial Migration

The approved `User` and `Credential` domain schema now exists in `prisma/schema.prisma`. The condition "until an approved domain schema/model exists" is satisfied.

**Authorized initial migration:** Create the initial migration containing ONLY the authentication domain models:

- `User` (id, email, displayName, status, createdAt, updatedAt)
- `Credential` (id, userId, passwordHash, createdAt, updatedAt)
- The documented one-to-one relationship between `User` and `Credential`

**Not authorized in this migration:**

- `Role`
- `Permission`
- `Session`
- `RefreshToken`
- MFA or other future authentication models
- Any non-authentication domain models

The initial migration is the foundation for the authentication milestone (5.6G). All subsequent migrations must preserve backward compatibility with this schema.

The `prisma/migrations` directory is the approved location for migration history.

---

## Related Documentation

- `docs/deployment.md` — production deployment procedure (references this document for migration operations)
- `docs/architecture.md` §10 — migration architecture facts
- `docs/engineering-standards.md` — review principles and error-handling rules
- `README.md` — concise setup summary
- `prisma/migrate.integration.test.ts` — executable migration lifecycle proofs
