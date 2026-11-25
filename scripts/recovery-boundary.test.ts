import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * M13.9 — recovery boundary regression suite.
 *
 * The central M13.9 rule is that application rollback and database rollback
 * are different operations, and that no destructive recovery is automatic.
 * This suite pins the boundary structurally: no automation identifiers for
 * self-repair exist in shipped code, destructive commands appear nowhere in
 * any operator-executed path, the backup tool refuses ambient targets, the
 * additive-history guard exists, and the deployment doc states checkpoints,
 * the failure matrix, and the no-automatic-rollback rule in one place.
 *
 * Style follows the M12.8 documentation-drift precedent (membership and
 * exact strings, never prose formatting). No database, Docker, or network
 * is required. Live migration/drift/recovery behavior is proven by
 * `prisma/migrate.integration.test.ts` and `verify-deployment.cjs` where a
 * database exists; this suite pins the static guarantees those cannot.
 */

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..');

const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

/** Non-test TypeScript sources plus shipped shell/packaging code. */
function shippedCodeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, suffixes: string[]): void => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs, suffixes);
        continue;
      }
      if (suffixes.some((suffix) => abs.endsWith(suffix)) && !abs.endsWith('.test.ts')) {
        out.push(abs);
      }
    }
  };
  walk(path.join(root, 'src'), ['.ts']);
  walk(path.join(root, 'scripts'), ['.cjs', '.sh']);
  walk(path.join(root, 'prisma'), ['.ts']);
  return out;
}

const OPERATOR_PATHS = [
  'Dockerfile',
  'docker-compose.yml',
  'package.json',
  'scripts/package.sh',
] as const;

describe('no automatic destructive recovery exists', () => {
  it('no self-repair automation identifiers in shipped code', () => {
    // A function named autoRestore/autoRollback would be the mechanism this
    // milestone forbids. Its absence is the guarantee; docs may discuss the
    // concept, code may not implement it.
    const offenders = shippedCodeFiles().filter((abs) =>
      /autoRestore|autoRollback|downMigration|autoResolve/i.test(readFileSync(abs, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it.each(['migrate reset', 'db push'])('%s appears in no operator-executed path', (forbidden) => {
    const bodies = [
      ...shippedCodeFiles().map((abs) => readFileSync(abs, 'utf8')),
      ...OPERATOR_PATHS.map((rel) => read(rel)),
    ].join('\n');
    expect(bodies.includes(forbidden)).toBe(false);
  });

  it('migrate resolve is documented as exceptional-only, never a deployment step', () => {
    // `docs/migrations.md` owns the resolve procedure; the deployment doc
    // must present it as exceptional recovery, never as a step. Whitespace
    // is normalized: prose reflow must not break the invariant.
    const prose = read('docs/deployment.md').replace(/\s+/g, ' ');
    expect(prose.includes('never a deployment step')).toBe(true);
  });
});

describe('rollback cannot smuggle migration, seed, or ambient-target behavior', () => {
  it('compose recovery path runs no seed', () => {
    const appService = read('docker-compose.yml').split(/^ {2}app:/m)[1] ?? '';
    expect(appService.includes('seed')).toBe(false);
  });

  it('the backup tool refuses ambient targets', () => {
    // Recovery tooling that silently fell back to the application
    // DATABASE_URL could back up — or worse, restore over — the wrong
    // database. The explicit-target refusal is the boundary.
    const backup = read('scripts/db-backup.cjs');
    expect(backup.includes('BACKUP_DATABASE_URL')).toBe(true);
    expect(backup.includes('the ambient application DATABASE_URL is never used')).toBe(true);
  });

  it('the additive-history guard exists (rollback safety rests on it)', () => {
    // Application rollback against a migrated schema is safe today only
    // because every migration is additive. That property is enforced by
    // `prisma/migrations.additive.test.ts` — this test pins the guard's
    // existence so it cannot silently disappear, without re-implementing it.
    expect(read('prisma/migrations.additive.test.ts').length).toBeGreaterThan(0);
    expect(read('docs/migrations.md').includes('additive')).toBe(true);
  });
});

describe('deployment documentation states the recovery contract in one place', () => {
  const deployment = read('docs/deployment.md');

  it('names every recovery checkpoint CP1 through CP9', () => {
    // Scoped to the checkpoint section: the failure matrix below legitimately
    // references checkpoints (e.g. "CP5→CP9 re-verified"), so a whole-document
    // substring match cannot tell a defined checkpoint from a passing mention.
    const section = read('docs/deployment.md').split('### Recovery checkpoints')[1] ?? '';
    const table = section.split('### ')[0];
    for (const checkpoint of ['CP1', 'CP2', 'CP3', 'CP4', 'CP5', 'CP6', 'CP7', 'CP8', 'CP9']) {
      expect(table.includes(checkpoint), `missing checkpoint ${checkpoint}`).toBe(true);
    }
  });

  it('states the no-automatic-rollback rule', () => {
    expect(/no automatic rollback/i.test(deployment)).toBe(true);
  });

  it('routes migration failures to the owning failure procedure', () => {
    expect(deployment.includes('docs/migrations.md')).toBe(true);
    expect(deployment.includes('docs/rollback-recovery.md')).toBe(true);
  });

  it('requires both liveness and readiness for recovery success', () => {
    // Liveness alone proves the process is alive, never that recovery
    // succeeded. The checkpoint section must demand both probes.
    expect(deployment.includes('/health/live')).toBe(true);
    expect(deployment.includes('/health/ready')).toBe(true);
  });

  it('rollback-recovery.md frames automatic recovery as not provided', () => {
    // Markdown emphasis splits the phrase ("explicitly **not** provided"),
    // so match the words, not the literal adjacency.
    const recovery = read('docs/rollback-recovery.md').replace(/\*/g, '');
    expect(recovery.includes('automatic rollback')).toBe(true);
    expect(recovery.includes('not provided')).toBe(true);
  });
});
