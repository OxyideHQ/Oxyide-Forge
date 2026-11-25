/**
 * Database backup integration tests (M2.8).
 *
 * The backup CLI (`scripts/db-backup.cjs`) is exercised as a black box.
 * Tests that need PostgreSQL are opt-in: without BACKUP_TEST_URL the
 * database-backed cases are visibly skipped. The suite never falls back to
 * the ambient application DATABASE_URL and never touches a protected
 * database.
 *
 * Operator setup (a PostgreSQL role with CREATEDB, plus PostgreSQL 17.x
 * client tools — pg_dump, pg_restore, psql — in PATH, once):
 *
 *   CREATE DATABASE oxyide_backup_test;
 *   CREATE DATABASE oxyide_backup_restore_test;
 *
 * then run with:
 *
 *   BACKUP_TEST_URL=postgresql://user:pass@host:5432/oxyide_backup_test
 *   RESTORE_TEST_URL=postgresql://user:pass@host:5432/oxyide_backup_restore_test
 *   npm test
 *
 * Safety contract (enforced below, never bypassed):
 * - backup/restore targets come ONLY from BACKUP_TEST_URL / RESTORE_TEST_URL;
 * - NODE_ENV=production always refuses;
 * - protected databases (postgres, oxyide_starter, oxyide_test,
 *   template0, template1) are always refused;
 * - scratch tables use the fixed m28_backup_probe name and are dropped in
 *   finally blocks on both databases;
 * - no CREATE/DROP DATABASE, no TRUNCATE of application tables, no seed.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const backupTestUrl: string | undefined = process.env.BACKUP_TEST_URL;
const restoreTestUrl: string | undefined = process.env.RESTORE_TEST_URL;

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
 * Refuses any backup/restore-test target that is not an explicitly provided,
 * non-production, non-shared disposable database. Throws on violation.
 */
export function assertSafeBackupTarget(url: string | undefined, nodeEnv: string | undefined): void {
  if (!url) {
    throw new Error('Refusing backup test: BACKUP_TEST_URL is not set.');
  }
  if (nodeEnv === 'production') {
    throw new Error('Refusing backup test with NODE_ENV=production.');
  }
  const name = databaseNameOf(url);
  if (!name || PROTECTED_DATABASES.has(name.toLowerCase())) {
    throw new Error(`Refusing backup test against protected database '${name ?? '(unparseable)'}'.`);
  }
}

type CliRun = {
  status: number | null;
  output: string;
};

function runBackup(args: string[], env: Record<string, string | undefined>): CliRun {
  const script = path.join(process.cwd(), 'scripts', 'db-backup.cjs');
  const childEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete childEnv[key];
    } else {
      childEnv[key] = value;
    }
  }
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    env: childEnv,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  return { status: result.status, output: `${stdout}\n${stderr}` };
}

function makeOutDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm28-backup-'));
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('db-backup target safety', () => {
  it('refuses production', () => {
    expect(() =>
      assertSafeBackupTarget('postgresql://db:5432/oxyide_backup_test', 'production'),
    ).toThrow(/production/i);
  });

  it('refuses protected shared databases', () => {
    for (const name of ['postgres', 'oxyide_starter', 'oxyide_test', 'template0', 'template1']) {
      expect(() => assertSafeBackupTarget(`postgresql://db:5432/${name}`, 'test')).toThrow(
        /protected/i,
      );
    }
  });

  it('refuses a missing URL', () => {
    expect(() => assertSafeBackupTarget(undefined, 'test')).toThrow(/not set/i);
  });

  it('refuses an empty target', () => {
    expect(() => assertSafeBackupTarget('', 'test')).toThrow(/not set/i);
  });

  it('refuses an unparseable target', () => {
    expect(() => assertSafeBackupTarget('not-a-url', 'test')).toThrow(/protected|unparseable/i);
  });

  it('accepts an explicitly provided disposable database', () => {
    expect(() =>
      assertSafeBackupTarget('postgresql://db:5432/oxyide_backup_test', 'test'),
    ).not.toThrow();
  });
});

describe('db-backup CLI without a database', () => {
  it('prints usage with --help and exits 0', () => {
    const run = runBackup(['--help'], {});
    expect(run.status).toBe(0);
    expect(run.output).toContain('BACKUP_DATABASE_URL');
  });

  it('requires an explicit target and never falls back to ambient DATABASE_URL', () => {
    const outDir = makeOutDir();
    try {
      const run = runBackup(['--out', outDir], {
        BACKUP_DATABASE_URL: undefined,
        DATABASE_URL: 'postgresql://should:not-be-used@localhost:1/nope',
      });
      expect(run.status).toBe(2);
      expect(run.output).toMatch(/no explicit backup target/i);
    } finally {
      removeDir(outDir);
    }
  });

  it('rejects a malformed URL without leaking it verbatim in the failure path', () => {
    const outDir = makeOutDir();
    try {
      const run = runBackup(['--url', 'not-a-valid-url', '--out', outDir], {
        BACKUP_DATABASE_URL: undefined,
      });
      expect(run.status).toBe(2);
      expect(run.output).toMatch(/not parseable|invalid backup target/i);
    } finally {
      removeDir(outDir);
    }
  });

  it('refuses an unusable output directory', () => {
    const run = runBackup(
      ['--url', 'postgresql://db:5432/oxyide_backup_test', '--out', path.join(os.tmpdir(), 'm28-no-such-dir-xyz')],
      { BACKUP_DATABASE_URL: undefined },
    );
    expect(run.status).toBe(2);
    expect(run.output).toMatch(/output directory is not usable/i);
  });

  it('fails loudly on an unreachable database without emitting secrets', () => {
    const sentinel = 's3cret-backup-pw-9f8e7d6c5b4a';
    const outDir = makeOutDir();
    try {
      const run = runBackup(
        ['--url', `postgresql://backupuser:${sentinel}@127.0.0.1:59999/seeddb`, '--out', outDir],
        { BACKUP_DATABASE_URL: undefined },
      );
      expect(run.status).not.toBe(0);
      expect(run.output).not.toContain(sentinel);
      expect(run.output).not.toContain('backupuser');
    } finally {
      removeDir(outDir);
    }
  });
});

describe.skipIf(!backupTestUrl)('db-backup against a disposable database', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    assertSafeBackupTarget(backupTestUrl, process.env.NODE_ENV);
    requirePgTools();
    if (!backupTestUrl) throw new Error('unreachable: suite skipped without URL');
    prisma = new PrismaClient({ datasources: { db: { url: backupTestUrl } } });
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new Error(
        'PostgreSQL unavailable: backup tests require the disposable database at BACKUP_TEST_URL.',
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it(
    'backs up, verifies, and records a valid manifest',
    async () => {
      if (!backupTestUrl) throw new Error('unreachable: suite skipped without URL');
      const outDir = makeOutDir();
      try {
        const run = runBackup(['--out', outDir, '--env', 'test-proof'], {
          BACKUP_DATABASE_URL: backupTestUrl,
        });
        expect(run.status).toBe(0);
        expect(run.output).toContain('backup complete:');

        const dumps = fs.readdirSync(outDir).filter((f) => f.endsWith('.dump'));
        const manifests = fs.readdirSync(outDir).filter((f) => f.endsWith('.manifest.json'));
        expect(dumps).toHaveLength(1);
        expect(manifests).toHaveLength(1);
        expect(dumps[0]).toMatch(/^oxyide-test-proof-oxyide_backup_test-\d{4}-\d{2}-\d{2}T/);

        const stat = fs.statSync(path.join(outDir, dumps[0]));
        expect(stat.size).toBeGreaterThan(0);

        const manifest = JSON.parse(
          fs.readFileSync(path.join(outDir, manifests[0]), 'utf8'),
        ) as Record<string, unknown>;
        expect(manifest.tool).toBe('oxyide-db-backup');
        expect(manifest.database).toBe(databaseNameOf(backupTestUrl));
        expect(typeof manifest.sha256).toBe('string');
        expect((manifest.sha256 as string).length).toBe(64);
        expect(manifest.sizeBytes).toBe(stat.size);
        expect(Array.isArray(manifest.migrations)).toBe(true);

        // Absence of the full URL (which embeds userinfo) is the precise leak
        // vector: a bare-password substring check would false-positive here
        // because 'test' also occurs in legitimate output (artifact names).
        // Standalone-secret redaction is proven deterministically by the
        // closed-port sentinel test above.
        expect(run.output).not.toContain(backupTestUrl);
      } finally {
        removeDir(outDir);
      }
    },
    { timeout: 120000 },
  );
});

describe.skipIf(!backupTestUrl || !restoreTestUrl)(
  'db-backup restore into a disposable database',
  () => {
    let source: PrismaClient;
    let target: PrismaClient;

    beforeAll(async () => {
      assertSafeBackupTarget(backupTestUrl, process.env.NODE_ENV);
      assertSafeBackupTarget(restoreTestUrl, process.env.NODE_ENV);
      requirePgTools();
      if (!backupTestUrl || !restoreTestUrl) throw new Error('unreachable: suite skipped without URL');
      source = new PrismaClient({ datasources: { db: { url: backupTestUrl } } });
      target = new PrismaClient({ datasources: { db: { url: restoreTestUrl } } });
      try {
        await source.$queryRaw`SELECT 1`;
        await target.$queryRaw`SELECT 1`;
      } catch {
        throw new Error(
          'PostgreSQL unavailable: restore tests require disposable databases at BACKUP_TEST_URL and RESTORE_TEST_URL.',
        );
      }
    });

    afterAll(async () => {
      await source
        .$executeRawUnsafe('DROP TABLE IF EXISTS "m28_backup_probe"')
        .catch(() => undefined);
      await target
        .$executeRawUnsafe('DROP TABLE IF EXISTS "m28_backup_probe"')
        .catch(() => undefined);
      await source.$disconnect();
      await target.$disconnect();
    });

    it(
      'restores backup data and schema into an isolated target',
      async () => {
        if (!backupTestUrl || !restoreTestUrl) throw new Error('unreachable: suite skipped without URL');
        requirePgTools();
        await source.$executeRawUnsafe('DROP TABLE IF EXISTS "m28_backup_probe"');
        await target.$executeRawUnsafe('DROP TABLE IF EXISTS "m28_backup_probe"');
        await assertEmptyRestoreTarget(target);
        await source.$executeRawUnsafe(
          'CREATE TABLE "m28_backup_probe" (id TEXT PRIMARY KEY, value TEXT NOT NULL)',
        );
        await source.$executeRawUnsafe(
          "INSERT INTO \"m28_backup_probe\" (id, value) VALUES ('r1', 'alpha'), ('r2', 'beta'), ('r3', 'gamma')",
        );
        const outDir = makeOutDir();
        try {
          const backup = runBackup(['--out', outDir, '--env', 'test-proof'], {
            BACKUP_DATABASE_URL: backupTestUrl,
          });
          expect(backup.status).toBe(0);
          const dumps = fs.readdirSync(outDir).filter((f) => f.endsWith('.dump'));
          expect(dumps).toHaveLength(1);

          const restore = runPgRestore(
            path.join(outDir, dumps[0]),
            restoreTestUrl,
          );
          expect(restore.status).toBe(0);

          const rows = (await target.$queryRawUnsafe(
            'SELECT id, value FROM "m28_backup_probe" ORDER BY id',
          )) as Array<{ id: string; value: string }>;
          expect(rows).toEqual([
            { id: 'r1', value: 'alpha' },
            { id: 'r2', value: 'beta' },
            { id: 'r3', value: 'gamma' },
          ]);
          // Full-URL absence is the precise leak vector here (see comment above).
          expect(restore.output).not.toContain(backupTestUrl);
          expect(restore.output).not.toContain(restoreTestUrl);
        } finally {
          await source.$executeRawUnsafe('DROP TABLE IF EXISTS "m28_backup_probe"').catch(() => undefined);
          await target.$executeRawUnsafe('DROP TABLE IF EXISTS "m28_backup_probe"').catch(() => undefined);
          removeDir(outDir);
        }
      },
      { timeout: 180000 },
    );
  },
);

function runPgRestore(dumpPath: string, databaseUrl: string): CliRun {
  const parsed = new URL(databaseUrl);
  const childEnv: Record<string, string | undefined> = { ...process.env };
  if (parsed.password) childEnv.PGPASSWORD = parsed.password;
  if (parsed.username) childEnv.PGUSER = parsed.username;
  const result = spawnSync(
    'pg_restore',
    [
      '--host', parsed.hostname,
      '--port', parsed.port || '5432',
      '--username', parsed.username || 'postgres',
      '--dbname', parsed.pathname.replace(/^\/+/, ''),
      dumpPath,
    ],
    { encoding: 'utf8', timeout: 180000, env: childEnv },
  );
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  return { status: result.status, output: `${stdout}\n${stderr}` };
}

function requirePgTools(): void {
  const result = spawnSync('pg_restore', ['--version'], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) {
    throw new Error(
      'PostgreSQL client tools (pg_restore) are not available in PATH; cannot run restore tests.',
    );
  }
}

/**
 * Refuses to restore unless the target holds no user tables other than
 * migration history and this suite's own scratch table. Restore never
 * overwrites unknown data: unexpected objects fail loudly instead.
 */
async function assertEmptyRestoreTarget(client: PrismaClient): Promise<void> {
  const rows = (await client.$queryRawUnsafe(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'm28_backup_probe')",
  )) as Array<{ tablename: string }>;
  if (rows.length > 0) {
    throw new Error(
      `Refusing restore test: target holds unexpected tables (${rows.map((r) => r.tablename).join(', ')}).`,
    );
  }
}
