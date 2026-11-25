# Rollback & Recovery Strategy

> **Status:** Decision procedure **CURRENT**. This document tells the operator
> how to decide between compatible application rollback, forward-fix, and
> verified backup restoration. It creates no automation: every recovery action
> below is an explicit, human-approved operator step.

## Purpose

Give a production engineer facing a failed deployment, failed migration, or
data incident a deterministic path from "what happened?" to verified
recovery — without guessing, without assuming reversal is safe, and without
touching migration history to hide failure.

## Scope

- In scope: application rollback decisions, migration-failure handling,
 partial-migration handling, expand/contract recovery, forward-fix
 procedure, backup-restoration decision-making, recovery-point selection,
 data-loss classification, compatibility verification, incident runbook.
- Out of scope (explicitly **not** provided): automatic rollback, automatic
 restore, down migrations, migration undo frameworks, replication/failover/
 HA, multi-region recovery, backup scheduling/execution (see
 `docs/backup-recovery.md`), backup procedures beyond selection/verification
 (implements no backup mechanics).

## Terminology

| Term | Meaning — never interchangeable |
|---|---|
| Application rollback | Deploying a previous application version. Touches code, not data |
| Database rollback | Returning database state to an earlier state. Prisma has no generic reverse-migration mechanism — treat the phrase with suspicion |
| Database restore | Reconstructing database state from a verified backup into a target |
| Forward-fix | A new compatible change (migration and/or release) that corrects current state without reversing history |
| Disaster recovery | Resuming service after major infrastructure/data loss (restores + rebuilds + re-verifies everything) |

## Central Rule

**Do not assume every production failure should be rolled back.** First
establish actual state, then choose between compatible application rollback,
forward-fix, or verified restoration. The default is never "rollback
immediately."

## Capability Audit (What Forge Actually Provides)

| Capability | Exists | Proven | Automated | Owner |
|---|---|---|---|---|
| Application redeployment (previous release) | Yes (standard deploy) | Yes, routine | No — operator deploys | Operator |
| Migration rollback (generic reverse) | **No** — no down migrations exist | N/A | No | N/A |
| Backup restore (mechanics + verification) | Yes | Yes, disposable proof | No — operator runs | Operator |
| Forward-fix (new corrective migration/release) | Yes (normal change process) | Yes, routine | No — human-authored | Operator/author |
| Migration resolution (`resolve --applied/--rolled-back`) | Yes, exceptional tool | Yes, disposable proof | No — human-gated | Operator |
| Backup selection guidance | Yes (this document + backup-recovery.md) | Procedure only | No | Operator |
| Restore verification procedure | Yes | Yes, disposable proof | No — operator runs | Operator |
| Schema compatibility verification | Yes (`migrate status`, diff, spot-checks) | Yes | No — operator runs | Operator |
| Data verification queries | Yes (documented shapes) | Procedure only | No | Operator |

## Application Rollback Strategy

A previous release may be redeployed **only** when the old application is
compatible with the **current** database state:

1. Establish database state first: migration history (`migrate status`),
 applied schema objects, backfill completion, contract status.
2. Check the old release against that state (§Compatibility Matrix).
3. If compatible: redeploy the old release, then verify health endpoints,
 critical paths, and error rates.
4. If incompatible: do **not** redeploy old code — forward-fix or restore.

Rolling back code never rolls back data. A redeployed old release against a
contracted schema is an outage, not a recovery.

## Database-First Compatibility Check

Before any application rollback, answer in order:

1. What migration state exists (history + applied objects)?
2. Was expand performed? Is the schema a compatible superset?
3. Was contract performed? Is any structure the old code needs now gone?
4. Was backfill performed, partially, or not at all?
5. Did any data transformation occur, and is it reversible?
6. Does old code expect removed columns, types, or constraints?
7. Does old code write the old representation, and is that still accepted?
8. Does old code understand the new representation where it must?

Only a fully compatible answer set permits application rollback.

## Expand/Contract Recovery

- **Case A — expand completed, application failed:** keep the expanded
 schema; redeploy a compatible old release; investigate; forward-fix or
 retry the release later. Never contract to "clean up" a failed release.
- **Case B — backfill partially completed:** old code must tolerate partial
 population (a release requirement from). Do not contract; complete
 or reconcile the backfill deliberately.
- **Case C — application switched, contract not done:** old-application
 rollback may still be possible — verify per §Compatibility Matrix, never
 assume.
- **Case D — contract already applied:** old-application rollback is
 generally impossible. Recovery paths, in order of preference: a new
 forward-compatible release; a verified backup restore; reconstruction of
 removed structure via forward migration. All require human approval.

## Failed Migration Strategy

STOP. Do not rerun blindly. Determine: migration name, `migrate status`
state, whether SQL partially executed, transaction behavior (PostgreSQL
transactional DDL normally rolls a failed migration back — verify, do not
assume for every operation type), schema state, application state, history
state, data state. Use status plus direct inspection. Never edit history to
hide the failure. Follow `docs/migrations.md` failure procedure; this
document governs what happens *after* the state is known.

## Partial Migration Strategy

A migration that applied partially (or whose atomicity cannot be proven for
its specific statements) is **unknown state until inspected**. Compare every
expected object against the live database, classify applied vs missing,
then either complete deliberately (forward) or restore from a verified
backup. Retrying `migrate deploy` over unknown partial state without
inspection is prohibited — understand first, then act.

## Forward-Fix Strategy

Treat forward-fix as a first-class recovery path: when production data is
structurally valid, a new compatible migration and/or release is usually
safer than reversal (no data loss window, history stays truthful, reviewable
as normal change).

Illustrative (not repository history): a migration backfills 20% of rows
with a wrong source column. Do not edit the applied migration; do not blindly
rerun it. Instead: identify affected rows, confirm the correct deterministic
source, author a corrective idempotent migration/backfill, verify counts
before/after, then continue the application transition.

Prefer forward-fix when data is structurally valid, corrections are
deterministic, compatibility holds, and reversal would risk more. Prefer
restore when data is irreversibly corrupted, required information is
destroyed, current state is untrustworthy, or no deterministic repair exists.

## Backup Restore Strategy

Restore is a **last-resort data operation**: it discards legitimate writes
made after the recovery point (unless PITR, which this repo does not
provide). Criteria for considering restore: irreversible destructive
migration, large-scale incorrect transformation, corruption, accidental
deletion, unreconstructible integrity, no trusted state. Never restore
merely because a deployment failed — fix forward or roll the application
back where compatible.

Mechanics (not duplicated here): `docs/backup-recovery.md` — verified
artifact selection, isolated-target restore, schema/data/history
verification, duration recording, target destruction.

## Recovery Point Selection

Needed inputs: incident time, corruption-start estimate, last known-good
backup, migration and application deployment times, WAL availability (none
here), restore-test evidence. **The newest backup is not automatically
correct** — a backup taken after corruption started contains corruption.
Select the newest backup that predates the corruption window with margin,
and state the accepted data-loss window explicitly.

## Data Loss Classification

- **NO DATA LOSS:** compatible application rollback on unchanged data.
- **MINOR ACCEPTED LOSS:** explicitly bounded, approved writes discarded by
 a chosen recovery point.
- **RPO-BOUNDED LOSS:** loss within the documented backup interval.
- **SIGNIFICANT LOSS:** beyond RPO or involving sensitive scope — escalate.
- **UNKNOWN LOSS:** exact loss cannot be determined — say so, investigate,
 never hide uncertainty behind a "recovery complete" claim.

## Destructive Migration Recovery

`DROP COLUMN`/`DROP TABLE`, destructive type/enum changes, deletions: after
contract, application rollback is generally impossible. Options in order:
(1) forward reconstruction (new migration rebuilding what can be rebuilt);
(2) verified restore (accepting the data-loss window); (3) hybrid (restore
isolated copy → extract validated data → controlled reinsertion). Reversal
by SQL alone is sufficient only when provably lossless — document the proof,
do not assert it. contract gates plus a verified backup are
prerequisites, never substitutes, for destructive work.

## Rolling / Partial Deployment Failure

With v1 + v2 instances coexisting: if v2 fails and compatibility holds,
stop v2 and continue v1. At 30%/50%/80% rollout the database must still
serve both versions; a failed halfway rollout never triggers contract, and
redeploying v1 never itself restores compatibility — verify it. If
compatibility is broken, do not blindly redeploy v1; establish state first
(same decision tree as any incident).

## Contract Failure

If a contract migration fails, determine whether the old structure remains:
if yes, the application usually keeps working — investigate without panic,
do not blindly retry. If partially destructive, inspect actual state
object-by-object; never assume transactional rollback covered every
statement. A failed contract is often safer than a failed expand precisely
because removal may not have happened.

## Migration History Safety

Never repair an incident by editing `_prisma_migrations` (no row deletes,
renames, checksum rewrites, or faked applied status). `migrate resolve` is
exceptional operator tooling for verified states only — never to make
`status` look clean. History must remain the trustworthy record every other
procedure reads.

## Compatibility Matrix

Read with windows: application version alone is never enough — the
database schema state must be known alongside it.

| Application | DB before expand | DB expanded (no contract) | DB contracted |
|---|---|---|---|
| N (old) | Compatible (normal operation) | Compatible **iff** expand preserved old structures | **Incompatible** — do not deploy |
| N+1 (new) | Compatible only if it tolerates missing new structures (usually not the tested path) | Compatible (dual-capable code) | Compatible (new structures only) |

## Decision Matrix

| Incident | App rollback | Forward-fix | Restore | Primary concern |
|---|---|---|---|---|
| App bug, DB compatible | **Yes** — first choice | Alternative | No | Verify compatibility, then redeploy |
| Expand done, app failed | **Yes** (old release) | Later, deliberately | No | Keep expanded schema; do not contract |
| Partial backfill | Only if old code tolerates it | Complete/reconcile backfill | No | Compatibility with partial data |
| Bad data migration, deterministic repair | No (data wrong under both) | **Yes** — corrective migration | Only if repair impossible | Affected-row identification |
| Contract already applied | **No** (generally) | New compatible release, or | Verified restore | Irreversibility acknowledged |
| Migration failed pre-commit | N/A (nothing applied) | Fix cause, controlled retry | No | Establish state first |
| Migration partially applied | Only if state verified compatible | Complete deliberately | If untrustworthy | Unknown state — investigate |
| Accidental deletion | No | Only if reconstructible | **Yes** — verified point | Data-loss window |
| Corruption | No | Only if bounded + repairable | **Yes** — verified point | Trusted state |
| Unknown DB state | **No** | **No** | **No** | Investigate first — no option is safe blind |

No row is universally correct; conditions govern.

## Decision Tree

```text
INCIDENT → PRESERVE EVIDENCE → STOP HARM → CLASSIFY → IS DB STATE KNOWN?
 NO → INVESTIGATE (no recovery action is safe blind)
 YES → IS DATA VALID?
 YES → IS OLD APP COMPATIBLE? → YES: APPLICATION ROLLBACK possible
 → NO: FORWARD-FIX / COMPATIBLE RELEASE
 NO → CAN DATA BE DETERMINISTICALLY REPAIRED?
 YES → FORWARD-FIX
 NO → SELECT VERIFIED RECOVERY POINT → RESTORE ISOLATED → VERIFY
 (schema, data, history, compatibility) → CONTROLLED PROD RECOVERY
→ VERIFY RECOVERY → RESUME SERVICE
```

## Production Recovery Runbook

Minimum gates (all human-approved, never automated): incident classified;
recovery point selected with corruption timing considered; backup verified
(checksum + restore-test evidence, not just existence); recovery target
identified (isolated first, never production-overwrite as step one);
accepted data loss stated explicitly; application version identified as
compatible; migration state understood; procedure reviewed; traffic handling
decided (stop writes / maintenance mode / drain / isolate as the recovery
type requires); restore completed; data + application verified; monitoring
active. Only then declare recovery complete.

## Post-Recovery Verification

Database: connectivity, schema, tables, constraints, indexes, migration
history. Data: row counts, representative values, relationships, nullability,
integrity. Application: startup, readiness, critical queries,
authentication paths (`User↔Credential` coherence, `Session↔RefreshToken`
lineage with revocation markers intact, unique constraints
intact), write path, read path. Operations: logs, errors, latency, backup
freshness, monitoring. Then, and only then: recovery complete.

Health endpoints (`/health/live`, `/health/ready`) prove process
availability only — never mistake them for data-correctness proof.

## Incident Evidence

Preserve where practical without delaying urgent safety actions:
deployment and application versions, migration version and full output,
`migrate status` output, logs, timestamps, backup identifier, selected
recovery point and its justification, every operator action. No secrets in
evidence (DATABASE_URL, passwords, hashes stay out).

## Post-Incident Review

Record: what failed and why, recovery path used, data loss and downtime,
backup/restore/migration evidence references, corrective actions (procedure
fix, gate addition, review-checklist update — not new infrastructure by
default). Lightweight and filed, not platformed.

## Scripts / Code Added

None. This milestone is procedure: no rollback manager, no restore
automation, no down-migration framework, no coordinator. The only
executables involved are pre-existing, human-invoked Prisma CLIs and the backup tool.

## Current vs Future vs Operator (scope)

- PROVIDED: this decision framework, compatibility matrices, runbooks,
 gates, classification schemes.
- DOCUMENTED ELSEWHERE AND REUSED: migration execution, backup and
 restore mechanics, expand/contract strategy.
- OPERATOR-OWNED: every judgment call herein (recovery-point acceptance,
 write-stop decisions, production restore execution, traffic handling).
- FUTURE (explicitly not built): automatic rollback/restore/failover,
 replicas/HA, PITR infrastructure, backup scheduling, alerting/audit
 platforms, incident-management platform.

## Related Documentation

- `docs/migrations.md` — migration execution (this document never duplicates it)
- `docs/backup-recovery.md` — backup creation, verification, restore mechanics
- `docs/deployment.md` — deployment process and failure table
- `docs/architecture.md` — system architecture and design decisions
