/**
 * Migration workflow integration tests (M2.3).
 *
 * These tests prove the Prisma migration lifecycle against an explicitly
 * provided DISPOSABLE database and never touch any other database. They are
 * opt-in: without OXYIDE_MIGRATION_TEST_URL the suite is visibly skipped.
 *
 * One-time operator setup (a PostgreSQL superuser or a role with CREATEDB):
 *
 *   CREATE DATABASE oxyide_migrate_test;
 *   -- optional, enables the drift-detection test:
 *   CREATE DATABASE oxyide_migrate_test_shadow;
 *
 * then run with:
 *
 *   OXYIDE_MIGRATION_TEST_URL=postgresql://user:pass@host:5432/oxyide_migrate_test
 *   OXYIDE_MIGRATION_SHADOW_URL=postgresql://user:pass@host:5432/oxyide_migrate_test_shadow
 *   npm test
 *
 * Safety contract (enforced below, never bypassed):
 * - the fixture database URL comes ONLY from OXYIDE_MIGRATION_TEST_URL;
 *   the ambient DATABASE_URL is never consulted as a fallback;
 * - NODE_ENV=production always refuses;
 * - shared/protected databases (postgres, oxyide_starter, oxyide_test,
 *   template0, template1) are always refused;
 * - drift mutations run only through guardedDriftCycle, which validates the
 *   explicit disposable target BEFORE any database I/O and restores state in
 *   a finally block (M2.3 incident class: unscoped shell URL);
 * - no CREATE/DROP DATABASE, no TRUNCATE, no seed invocation;
 * - `migrate resolve` is used ONLY inside the failed-migration test against
 *   the disposable fixture to restore it, never against a real database.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Resolve the Prisma CLI entry from the installed package metadata and spawn
// it directly with the current Node binary: no shell, no PATH lookup,
// portable across Windows and Unix-like systems.
function resolvePrismaCli(): string {
  const pkgPath = path.join(process.cwd(), 'node_modules', 'prisma', 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error('Prisma CLI not found: expected npm-installed dependencies.');
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin ? pkg.bin['prisma'] : undefined;
  if (!binRel) {
    throw new Error('Prisma CLI entry missing from installed prisma package metadata.');
  }
  return path.resolve(path.dirname(pkgPath), binRel);
}

const prismaCli = resolvePrismaCli();

function spawnPrismaCli(args: string[], databaseUrl: string): CliRun {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  return { status: result.status, output: `${stdout}\n${stderr}` };
}

const migrationTestUrl: string | undefined = process.env.OXYIDE_MIGRATION_TEST_URL;
const shadowTestUrl: string | undefined = process.env.OXYIDE_MIGRATION_SHADOW_URL;

if (!migrationTestUrl) {
  console.warn(
    'Migration integration tests were not executed because no explicit disposable ' +
      'migration-test database was configured (OXYIDE_MIGRATION_TEST_URL is unset). ' +
      'This is not full migration validation.',
  );
}

const PROTECTED_DATABASES = new Set([
  'postgres',
  'oxyide_starter',
  'oxyide_test',
  'template0',
  'template1',
]);

function databaseNameOf(url: string): string | null {
  try {
    const pathname = new URL(url).pathname.replace(/^\/+/, '');
    return pathname === '' ? null : pathname;
  } catch {
    return null;
  }
}

/**
 * Refuses any migration-test target that is not an explicitly provided,
 * non-production, non-shared disposable database. Throws on violation.
 */
export function assertSafeMigrationTarget(
  url: string | undefined,
  nodeEnv: string | undefined,
): asserts url {
  if (!url) {
    throw new Error('Refusing migration test: OXYIDE_MIGRATION_TEST_URL is not set.');
  }
  if (nodeEnv === 'production') {
    throw new Error('Refusing migration test with NODE_ENV=production.');
  }
  const name = databaseNameOf(url);
  if (!name || PROTECTED_DATABASES.has(name.toLowerCase())) {
    throw new Error(`Refusing migration test against protected database '${name ?? '(unparseable)'}'.`);
  }
}

type CliRun = {
  status: number | null;
  output: string;
};

function runPrisma(args: string[], databaseUrl: string): CliRun {
  return spawnPrismaCli(args, databaseUrl);
}

function fixturePrismaClient(): PrismaClient {
  if (!migrationTestUrl) {
    throw new Error('Migration fixture URL is not configured.');
  }
  return new PrismaClient({ datasources: { db: { url: migrationTestUrl } } });
}

const DRIFT_DROP_INDEX = 'DROP INDEX "User_email_key";';
const DRIFT_RESTORE_INDEX = 'CREATE UNIQUE INDEX "User_email_key" ON "User"("email");';

export type DriftCycleResult = {
  driftScript: string;
};

/**
 * Performs one guarded drift-and-restore cycle against an EXPLICITLY provided
 * disposable target: drops a probe index, proves `migrate diff` detects the
 * drift, then restores the index. Validation precedes any database I/O —
 * without an explicit disposable URL this throws before any client is
 * constructed, so the ambient DATABASE_URL can never be consulted as a
 * fallback (M2.3 incident class: an unscoped shell URL once dropped an index
 * on the wrong database). Restoration runs in a finally block and its failure
 * is reported loudly, never swallowed.
 */
export async function guardedDriftCycle(
  explicitUrl: string | undefined,
  nodeEnv: string | undefined,
  shadowUrl: string | undefined,
): Promise<DriftCycleResult> {
  assertSafeMigrationTarget(explicitUrl, nodeEnv);
  if (!shadowUrl) {
    throw new Error('Refusing drift mutation: no shadow database URL was provided.');
  }
  const prisma = new PrismaClient({ datasources: { db: { url: explicitUrl } } });
  try {
    await prisma.$executeRawUnsafe(DRIFT_DROP_INDEX);
    try {
      const drifted = spawnSyncDiff(explicitUrl, shadowUrl);
      if (drifted.status !== 0 || !drifted.output.includes('DROP INDEX "User_email_key"')) {
        throw new Error('Drift was not detected after dropping the probe index.');
      }
      return { driftScript: drifted.output };
    } finally {
      await prisma.$executeRawUnsafe(DRIFT_RESTORE_INDEX);
    }
  } finally {
    await prisma.$disconnect();
  }
}

function copyMigrationsToTempDir(extraMigrations: Record<string, string>): string {
  const repoRoot = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-fixture-'));
  fs.copyFileSync(path.join(repoRoot, 'prisma', 'schema.prisma'), path.join(dir, 'schema.prisma'));
  const migrationsDir = path.join(dir, 'migrations');
  fs.mkdirSync(migrationsDir, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'prisma', 'migrations', 'migration_lock.toml'),
    path.join(migrationsDir, 'migration_lock.toml'),
  );
  for (const name of ['20260919145131_init', '20260919205337_add_role_to_user']) {
    fs.cpSync(path.join(repoRoot, 'prisma', 'migrations', name), path.join(migrationsDir, name), {
      recursive: true,
    });
  }
  for (const [name, sql] of Object.entries(extraMigrations)) {
    const extraDir = path.join(migrationsDir, name);
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(path.join(extraDir, 'migration.sql'), sql);
  }
  return dir;
}

const EXPECTED_MIGRATIONS = ['20260919145131_init', '20260919205337_add_role_to_user'];

describe.skipIf(!migrationTestUrl)('prisma migration workflow', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    assertSafeMigrationTarget(migrationTestUrl, process.env.NODE_ENV);
    prisma = fixturePrismaClient();
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new Error(
        'PostgreSQL unavailable: migration tests require the disposable database at OXYIDE_MIGRATION_TEST_URL.',
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it(
    'deploys all migrations to a fresh database with recorded history',
    async () => {
      if (!migrationTestUrl) throw new Error('unreachable: suite skipped without URL');
      // Accepts both a fresh database (migrations applied now) and an
      // already-migrated one (repeat-safe second deploy). The history and
      // schema assertions below prove the end state either way.
      const deploy = runPrisma(['migrate', 'deploy'], migrationTestUrl);
      expect(deploy.status).toBe(0);
      expect(deploy.output).toMatch(/successfully applied|no pending migrations/i);

      const history = (await prisma.$queryRawUnsafe(
        'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at',
      )) as Array<{ migration_name: string }>;
      expect(history.map((row) => row.migration_name)).toEqual(EXPECTED_MIGRATIONS);

      const tables = (await prisma.$queryRawUnsafe(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('User', 'Credential')",
      )) as Array<{ tablename: string }>;
      expect(tables.map((row) => row.tablename).sort()).toEqual(['Credential', 'User']);

      const indexes = (await prisma.$queryRawUnsafe(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('User', 'Credential')",
      )) as Array<{ indexname: string }>;
      expect(indexes.map((row) => row.indexname).sort()).toEqual([
        'Credential_pkey',
        'Credential_userId_key',
        'User_email_key',
        'User_pkey',
      ]);

      const constraints = (await prisma.$queryRawUnsafe(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'f'",
      )) as Array<{ def: string }>;
      expect(constraints).toHaveLength(1);
      expect(constraints[0].def).toContain('REFERENCES "User"');
      expect(constraints[0].def).toMatch(/DELETE RESTRICT/i);
    },
    { timeout: 180000 },
  );

  it(
    'second deploy is repeat-safe and status is clean',
    async () => {
      if (!migrationTestUrl) throw new Error('unreachable: suite skipped without URL');
      const before = (await prisma.$queryRawUnsafe(
        'SELECT COUNT(*) AS n FROM "_prisma_migrations"',
      )) as Array<{ n: bigint }>;

      const deploy = runPrisma(['migrate', 'deploy'], migrationTestUrl);
      expect(deploy.status).toBe(0);
      expect(deploy.output).toMatch(/no pending migrations/i);

      const after = (await prisma.$queryRawUnsafe(
        'SELECT COUNT(*) AS n FROM "_prisma_migrations"',
      )) as Array<{ n: bigint }>;
      expect(String(after[0].n)).toBe(String(before[0].n));

      const status = runPrisma(['migrate', 'status'], migrationTestUrl);
      expect(status.status).toBe(0);
      expect(status.output).toMatch(/up to date/i);
    },
    { timeout: 180000 },
  );

  it(
    'detects a pending migration without mutating anything',
    async () => {
      if (!migrationTestUrl) throw new Error('unreachable: suite skipped without URL');
      const tempDir = copyMigrationsToTempDir({
        '99999999999999_probe_pending': '-- probe pending migration (never applied)',
      });
      try {
        const status = runPrisma(
          ['migrate', 'status', '--schema', path.join(tempDir, 'schema.prisma')],
          migrationTestUrl,
        );
        expect(status.status).not.toBe(0);
        expect(status.output).toContain('99999999999999_probe_pending');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      const clean = runPrisma(['migrate', 'status'], migrationTestUrl);
      expect(clean.status).toBe(0);
      expect(clean.output).toMatch(/up to date/i);
    },
    { timeout: 180000 },
  );

  it(
    'fails loudly when the database is unavailable',
    async () => {
      const unreachable = 'postgresql://127.0.0.1:59999/nonexistent';
      const deploy = runPrisma(['migrate', 'deploy'], unreachable);
      expect(deploy.status).not.toBe(0);
      expect(deploy.output).toMatch(/P1001|can't reach database server/i);
      const status = runPrisma(['migrate', 'status'], unreachable);
      expect(status.status).not.toBe(0);
      expect(status.output).toMatch(/P1001|can't reach database server/i);
    },
    { timeout: 180000 },
  );

  it(
    'recovers from a failed migration through explicit resolve on the disposable database',
    async () => {
      if (!migrationTestUrl) throw new Error('unreachable: suite skipped without URL');
      const tempDir = copyMigrationsToTempDir({
        '99999999999999_probe_broken': 'THIS IS NOT VALID SQL;',
      });
      const schemaArg = path.join(tempDir, 'schema.prisma');
      try {
        const deploy = runPrisma(['migrate', 'deploy', '--schema', schemaArg], migrationTestUrl);
        expect(deploy.status).not.toBe(0);

        const failed = runPrisma(['migrate', 'status', '--schema', schemaArg], migrationTestUrl);
        expect(failed.status).not.toBe(0);
        expect(failed.output).toMatch(/failed/i);

        const resolve = runPrisma(
          ['migrate', 'resolve', '--rolled-back', '99999999999999_probe_broken', '--schema', schemaArg],
          migrationTestUrl,
        );
        expect(resolve.status).toBe(0);
        expect(resolve.output).toMatch(/rolled back/i);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      const clean = runPrisma(['migrate', 'status'], migrationTestUrl);
      expect(clean.status).toBe(0);
      expect(clean.output).toMatch(/up to date/i);
    },
    { timeout: 180000 },
  );

  it.skipIf(!shadowTestUrl)(
    'reports no drift between migration files and the migrated database',
    async () => {
      if (!migrationTestUrl || !shadowTestUrl) throw new Error('unreachable: suite skipped without URL');
      const diff = spawnSyncDiff(migrationTestUrl, shadowTestUrl);
      expect(diff.status).toBe(0);
      expect(diff.output).toMatch(/empty migration/i);
    },
    { timeout: 180000 },
  );

  it.skipIf(!shadowTestUrl)(
    'guarded drift cycle detects drift and restores the fixture',
    async () => {
      if (!migrationTestUrl || !shadowTestUrl) throw new Error('unreachable: suite skipped without URL');
      const result = await guardedDriftCycle(migrationTestUrl, process.env.NODE_ENV, shadowTestUrl);
      expect(result.driftScript).toContain('DROP INDEX "User_email_key"');

      const restored = spawnSyncDiff(migrationTestUrl, shadowTestUrl);
      expect(restored.status).toBe(0);
      expect(restored.output).toMatch(/empty migration/i);

      const clean = runPrisma(['migrate', 'status'], migrationTestUrl);
      expect(clean.status).toBe(0);
      expect(clean.output).toMatch(/up to date/i);
    },
    { timeout: 180000 },
  );
});

function spawnSyncDiff(databaseUrl: string, shadowUrl: string): CliRun {
  return spawnPrismaCli(
    [
      'migrate',
      'diff',
      '--from-migrations',
      path.join(process.cwd(), 'prisma', 'migrations'),
      '--to-url',
      databaseUrl,
      '--shadow-database-url',
      shadowUrl,
      '--script',
    ],
    databaseUrl,
  );
}

describe('migration target safety', () => {
  it('refuses production', () => {
    expect(() =>
      assertSafeMigrationTarget('postgresql://db:5432/app', 'production'),
    ).toThrow(/production/i);
  });

  it('refuses protected shared databases', () => {
    for (const name of ['postgres', 'oxyide_starter', 'oxyide_test', 'template0', 'template1']) {
      expect(() => assertSafeMigrationTarget(`postgresql://db:5432/${name}`, 'test')).toThrow(
        /protected/i,
      );
    }
  });

  it('refuses a missing URL', () => {
    expect(() => assertSafeMigrationTarget(undefined, 'test')).toThrow(/not set/i);
  });

  it('rejects an empty target', () => {
    expect(() => assertSafeMigrationTarget('', 'test')).toThrow(/not set/i);
  });

  it('rejects an unparseable target', () => {
    expect(() => assertSafeMigrationTarget('not-a-url', 'test')).toThrow(/protected|unparseable/i);
  });

  it('rejects drift mutation without an explicit disposable target (M2.3 incident class)', async () => {
    const savedMigrationUrl = process.env.OXYIDE_MIGRATION_TEST_URL;
    const savedDatabaseUrl = process.env.DATABASE_URL;
    process.env.OXYIDE_MIGRATION_TEST_URL = '';
    process.env.DATABASE_URL = 'postgresql://127.0.0.1:5433/oxyide_starter';
    try {
      await expect(guardedDriftCycle(undefined, 'test', undefined)).rejects.toThrow(
        /OXYIDE_MIGRATION_TEST_URL is not set/,
      );
    } finally {
      if (savedMigrationUrl === undefined) {
        delete process.env.OXYIDE_MIGRATION_TEST_URL;
      } else {
        process.env.OXYIDE_MIGRATION_TEST_URL = savedMigrationUrl;
      }
      if (savedDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = savedDatabaseUrl;
      }
    }
  });

  it('rejects drift mutation against a protected target', async () => {
    await expect(
      guardedDriftCycle('postgresql://db:5432/oxyide_starter', 'test', undefined),
    ).rejects.toThrow(/protected/i);
  });

  it('rejects drift mutation in production', async () => {
    await expect(
      guardedDriftCycle('postgresql://db:5432/oxyide_migrate_probe', 'production', undefined),
    ).rejects.toThrow(/production/i);
  });

  it('accepts an explicitly provided disposable database', () => {
    expect(() =>
      assertSafeMigrationTarget('postgresql://db:5432/oxyide_migrate_test', 'test'),
    ).not.toThrow();
  });
});
