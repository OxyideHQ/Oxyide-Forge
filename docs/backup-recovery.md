# Database Backup & Recovery

> **Status:** Procedure **CURRENT** as documented below. Automated in-repo
> tooling covers backup creation and verification only
> (`scripts/db-backup.cjs`, tested). Scheduling, storage provisioning,
> monitoring integration, PITR infrastructure, and disaster execution are
> **operator responsibilities** — this document tells the operator exactly
> what to provide, not that Forge provides it.

## Purpose

Ensure every production PostgreSQL database behind Oxyide Forge has a
recoverable backup strategy, and that recovery is periodically **proven**
rather than assumed. A backup that has never been successfully restored is
an assumption, not a recovery mechanism.

## Scope

- In scope: logical backup procedure and tooling, backup verification,
 restore testing procedure, retention/encryption/storage requirements,
 failure handling, monitoring expectations, disaster-scenario guidance,
 migration compatibility.
- Out of scope (explicitly **not** provided): backup scheduling, alerting
 platforms, audit platforms, object-storage SDKs, PITR infrastructure,
 replication/failover/HA, multi-region operation, automatic restore,
 automatic rollback (decided case-by-case per `docs/rollback-recovery.md`),
 backup execution inside application code.

## What Is Backed Up (Data Categories)

Against the current schema (`User`, `Credential`, `Session`, `RefreshToken`, `PasswordResetToken`, `EmailVerificationToken`, `LoginThrottle`):

| Category | Content | Backup requirement |
|---|---|---|
| Application data | `User` rows (email, displayName, status, role, timestamps); `Credential` rows (ids, `userId`, `passwordHash`, timestamps) | **Required.** Emails are PII; password hashes are secret-class (never plaintext, still sensitive) — production-grade access control applies |
| Session / credential-lifecycle state | `Session` + `RefreshToken` rows (live, consumed, revoked families and lineage); `PasswordResetToken` + `EmailVerificationToken` rows (active/consumed); `LoginThrottle` rows (failure windows) | **Required with the application data.** Revocation markers are security state: a restore that drops them resurrects revoked sessions and consumed credentials. After any point-in-time restore older than live revocations, revoke all sessions and force reauthentication per ADR-008 before serving traffic |
| Schema + migration state | Tables, constraints, indexes, `_prisma_migrations` history | **Required.** A backup without history complicates recovery against migration-gated deploys (see Migration Compatibility) |
| Configuration / secrets | `.env`, `JWT_SECRET`, `DATABASE_URL` | **Never in the database dump by design**; governed separately (never committed, see Secrets Management below) |
| Ephemeral abuse-control state | `LoginThrottle` windows, `User.lockedUntil` markers | **Restored as stored, then re-evaluated:** expired windows/markers recover on the next request by design; a stale *live* lock restores as locked and expires naturally (≤30 min) or via password reset. No operator unlock step exists |

## Source of Truth

`prisma/migrations/` remains the schema source of truth (see
`docs/migrations.md`). A backup is a **point-in-time copy of a database**,
not a substitute for migration history: restoring never replaces the
`migrate deploy` / `migrate status` workflow, it only changes which database
that workflow inspects.

## RPO (Recovery Point Objective)

RPO is the maximum acceptable data loss measured in time. Forge sets **no
business RPO** — it is operator-defined. The framework:

- **Dump-only posture (what this repo provides):** RPO equals the backup
 interval. Baseline guidance is a **daily** logical backup (RPO ≤ 24h);
 tighten only with a matching schedule the operator actually runs.
- **Lower RPO** requires WAL archiving + base backups (operator
 infrastructure, see WAL / PITR). Do not claim minute-level recovery from
 daily dumps.
- Actual RPO is determined by the **oldest unverified gap**, not the
 schedule: a missed backup extends RPO until the next verified one.

## RTO (Recovery Time Objective)

RTO is the maximum acceptable time to restore service. No guaranteed RTO is
stated — actual RTO **must be measured** from restore exercises. Factors:
backup size, restore throughput, database size, WAL volume (if PITR),
infrastructure provisioning, migration count, network throughput,
verification time, application startup, DNS/load-balancer changes. Timings
recorded during this milestone's disposable proof are data points, not an
SLA (see Restore Test Results in the report).

## Backup Types

| Type | Captures | Good for | Limitations |
|---|---|---|---|
| Logical (`pg_dump`, this repo's baseline) | Schema + data as SQL or archive | Portability, selective restore, small/medium DBs, version-fluid restores | Slower at scale; restore replays all writes; no sub-transaction PITR by itself |
| Physical (base backup) | Data directory bytes | Large DBs, fast restore, PITR foundation | Version- and platform-sensitive; needs WAL + tooling; operator infrastructure |
| WAL archiving / PITR | Continuous change stream | Sub-backup-interval RPO, point-in-time targets | Requires archive storage, retention discipline, restore tooling, regular rehearsal |
| Storage snapshots | Disk state | Fast capture, whole-volume rollback | Crash-consistent only without DB cooperation; still needs restore testing; platform-specific |

No type is universally superior. Forge standardizes on **logical dumps** as
the baseline every deployment can execute; anything beyond is operator
infrastructure documented below, not code in this repo.

## Logical Backup Strategy

- Format: `pg_dump --format=custom` (compressed archive; supports selective
 and parallel restore via `pg_restore -j`). Plain SQL is acceptable for
 inspection/debugging but is not the interchange baseline. Directory format
 is the documented alternative for large databases (parallel dump/restore);
 not implemented here.
- Content: full database (schema, data, ownership, privileges, sequences).
 No table exclusions in V1 — the schema is two application tables plus
 migration history; exclusions would be a reviewed, documented exception.
- Extensions/large objects: none in the current schema; revisit if added.
- Implemented by `scripts/db-backup.cjs` (see Operator Scripts); the exact
 commands are also documented for manual execution (see Runbook).

## Physical Backup / WAL / PITR Boundary

Physical backups, WAL archiving, and PITR are **operator infrastructure**,
correctly distinguished from PostgreSQL merely *having* a WAL:

- WAL archiving requires: `archive_mode = on`, an `archive_command`,
 archive storage with retention, base backups, and rehearsed restore.
- None of the above exists in this repository, and none is claimed.
- If a deployment needs sub-daily RPO or PITR, the operator provisions it;
 the logical baseline in this document remains the portable fallback.

## Retention Strategy

Retention policy **must be explicit** — never rely on storage defaults.
Guidance (operator sets exact numbers; defaults below are starting points,
not compliance claims):

- Daily dumps retained 7–14 days (covers incidents discovered within days,
 e.g. a bad migration noticed late in the week).
- Weekly dumps retained 4–8 weeks; monthly retained 3–12 months per
 business/legal need.
- Retention must survive accidental deletion: the newest verified backup
 must never be the only copy deletable by a single action or credential.
- Never delete an older backup until its replacement is verified (create →
 verify → mark complete → retain → expire, in that order).
- Corruption windows outlive discovery: keep enough history to restore
 *before* an incident started, not merely before it was noticed.

## Storage Strategy

- A backup must **never exist only on the database host** (host/disk loss
 would take both).
- Separate storage class and separate failure domain; geographic separation
 for disaster-grade copies. Generic examples (not mandates): object storage
 with versioning/object-lock, a separate backup volume, managed backup
 storage. No provider SDK is added to this repo; the deployment environment
 chooses.
- 3-2-1 as a resilience principle (3 copies, 2 media classes, 1 off-site),
 plus an immutable/offline copy where ransomware or credential compromise
 is in the threat model. Stated as principle, not compliance certification.
- Access isolation: backup readers/writers are distinct roles from database
 administrators where the organization supports it.

## Encryption and Secrets

- Encrypt in transit (TLS to object storage / `sslmode=require` semantics
 where applicable) and at rest (provider-side encryption minimum).
- Keys live in the secret manager / operator vault — **never next to the
 backups, never in Git, never hard-coded**.
- Never place `DATABASE_URL`, passwords, tokens, or certificates in backup
 scripts, docs, committed config, CI logs, or examples. Operator tooling
 takes credentials from the environment (`BACKUP_DATABASE_URL`, never an
 ambient application `DATABASE_URL` fallback).
- `scripts/db-backup.cjs` logs host/database/timestamp/size/duration only;
 failure output is redacted by construction (tested with sentinel secrets).

## Credential Model

- Backup execution identity: least-privilege role able to read all tables
 and schema (`CONNECT` + `SELECT` broadly, or the standard dump role for
 the deployment). No `SUPERUSER` for routine dumps.
- Restore execution identity: necessarily broader (create objects, set
 owners) — runs only against explicitly declared disposable targets in
 testing, or under the production recovery procedure with human approval.
- Backup credentials and restore credentials are distinct where practical;
 compromise of either triggers the Security Incident procedure below.

## Backup Verification (Mandatory, Not Optional)

Every backup artifact must pass, in order:

1. Exit code 0 from the backup command (any other result = failure, never
 treated as success).
2. Artifact exists, non-empty, size plausible against source characteristics
 (no universal minimums; compare with the source, not a constant).
3. Checksum matches the manifest (`sha256`, recorded at creation).
4. `pg_restore --list` parses the archive (structural validity, not proof
 of recoverability — both are required, they prove different things).
5. Manifest is valid JSON with: UTC timestamp, environment label, database
 name, PostgreSQL server version, Prisma/migration versions, backup type,
 size, checksum, duration.

A backup failing any step is **not recoverable** and must never satisfy
retention ("we have Tuesday's backup").

## Restore Testing

Periodic, mandatory, on isolated targets — never by overwriting production:

1. Select a verified backup (prefer the newest *verified* one, not merely
 the newest file).
2. Provision an isolated PostgreSQL target (separate database; never the
 live database as the first verification step).
3. Restore (`pg_restore`; parallel `-j` where measured useful).
4. Verify: exit code, connectivity, expected tables/constraints/indexes,
 `_prisma_migrations` history present, row counts plausible, representative
 queries succeed (auth lookup shape, FK joins `User↔Credential` and
 `Session↔RefreshToken`, revocation markers (`revokedAt`, `consumedAt`)
 present where live state requires them), migration
 status understood (`migrate status` as inspection, not as an auto-fix).
5. Record durations (backup, restore, verification) for RTO planning.
6. Destroy or quarantine the disposable target afterward.

Restore-test frequency is its own policy, independent of backup frequency;
test often enough that recovery is proven, not assumed. Key metric:
**time since last verified recoverable backup.**

## Migration Compatibility

- Restored databases carry their own `_prisma_migrations` history — never
 edit it, never `migrate resolve` it as part of restore (see
 `docs/migrations.md`; resolve is exceptional recovery only).
- Determine restored schema version + target application version first;
 apply only the controlled `migrate deploy` path if the restored state
 must move forward. Recovery never bypasses migration rules.
- Backups taken mid-expand/contract may legitimately contain old+new
 columns — identify the compatible application version before serving
 traffic from restored state (see compatibility windows).
- Never run production seed after restore unless a recovery procedure
 explicitly requires it (separation preserved).

## Disaster Scenarios

| Scenario | Posture |
|---|---|
| A. Accidental row deletion | Restore-test flow into isolated target; extract/repair selectively; **supported by backup** |
| B. Accidental table deletion | Same as A at table scope |
| C. Bad application deployment | Fix forward preferred; backup bounds the blast radius |
| D. Failed migration | failure procedure first; backup is the backstop, not the plan |
| E. Database corruption | Isolated restore + verification; needs verified history depth (retention matters) |
| F/G. Host or disk loss | Only recoverable if copies live off-host (storage separation is load-bearing) |
| H. Credential compromise | Treat backup access as compromised; rotate backup credentials; review storage access; historical copies need incident handling (hashes are sensitive). After restore from a pre-compromise point, revoke all sessions and force reauthentication — a stale backup otherwise resurrects revoked families |
| H2. Stale-restore session resurrection | A restore older than live revocations re-activates revoked sessions/consumed credentials by construction | Same posture as H: revoke-all + forced reauthentication before serving traffic (ADR-008) |
| I. Backup storage loss | Only survivable via 3-2-1/off-site copies |
| J. Regional infrastructure loss | **Outside current Forge scope** — requires multi-region design (future infrastructure, operator-owned) |

## Failure Handling (Fail Closed)

Backup missing / failed / anomalously sized / unverifiable / storage
unreachable / retention failure / restore-test failure → **failure**, never
success. Partial artifacts must not look complete (write temp + atomic
rename; remove partials on failure). Unknown environment → fail.

## Monitoring Expectations (Integration Points, Not a Platform)

The deployment environment must observe, at minimum: expected backup
missing, backup failed, anomalous size, verification failed, storage
unavailable, retention failure, restore-test failed. Useful tracked facts:
last successful backup, last *verified* backup, backup age/duration/size,
restore-test age/duration, free backup storage. No alerting/metrics platform
is built here; these are the integration points the operator wires up.

## Operator Runbook (Backup → Verified Restore)

```text
1. Confirm target: explicit BACKUP_DATABASE_URL (never ambient fallback).
2. Run backup (scripts/db-backup.cjs --url... --out... [--env label]).
3. Require exit 0; on any other code STOP (see Failure Handling).
4. Verify artifact: manifest valid, checksum matches, pg_restore --list parses.
5. Store safely (separate storage; encryption; retention entry).
6. Restore test (isolated target): restore → schema/data/history checks →
 representative queries → record durations → destroy target.
7. Record evidence (timestamp, artifact id, verification + restore results,
 operator identity). No audit platform is built; keep the record where
 operations are tracked.
```

## Production Checklist

- [ ] Explicit backup target configured (no ambient fallback anywhere)
- [ ] Schedule defined and owned (outside this repo by design)
- [ ] Separate, encrypted storage with retention policy recorded
- [ ] Credentials via environment/vault; least-privilege backup identity
- [ ] Verification mandatory on every artifact
- [ ] Restore test rehearsed; durations recorded for RTO planning
- [ ] Monitoring integration points wired (missing/failed/unverifiable)
- [ ] Disaster table reviewed for this deployment (J explicitly accepted or planned)
- [ ] Migration compatibility understood (history travels with restores)

## Current vs Future vs Operator

- **IMPLEMENTED (this repo):** backup CLI with manifest + verification +
 redacted logging + fail-closed exits; guard/naming/redaction/gitignore
 tests; opt-in disposable backup/restore integration tests.
- **VERIFIED (this milestone, disposable DBs):** full backup → restore →
 verify cycle with measured timings (evidence in the report).
- **DOCUMENTED (procedure only):** schedules, retention numbers as guidance,
 RPO/RTO framework, disaster table, runbook, monitoring expectations.
- **OPERATOR RESPONSIBILITY:** scheduling, storage, encryption-at-rest
 provider config, secret management, monitoring wiring, PITR infra, HA,
 cloud specifics, disaster execution.
- **NOT IMPLEMENTED:** scheduler, automation, alerting/audit platforms,
 object-storage SDKs, PITR infrastructure, replicas/failover, automatic
 restore or rollback.

## Related Documentation

- `docs/migrations.md` — migration procedure (backup checkpoints reference this document, not vice versa)
- `docs/deployment.md` — deployment guidance (links here for backup/recovery)
- `docs/architecture.md` — system architecture and design decisions
- `prisma/migrate.integration.test.ts` — executable migration lifecycle proofs
