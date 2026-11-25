/**
 * Seed integration tests (M2.2).
 *
 * The seed is exercised as a black box through `npm run db:seed` against the
 * test PostgreSQL database. Follows the repository integration-test contract:
 * fails fast when PostgreSQL is unavailable, truncates nothing, and cleans up
 * its own probe row so no test data leaks into the target database.
 *
 * These tests require a running PostgreSQL instance at DATABASE_URL.
 * When the database is unavailable, the suite fails fast instead of
 * silently passing.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testDatabaseUrl: string =
  process.env.DATABASE_URL ?? 'postgresql://localhost:5432/oxyide_test';
const testJwtSecret: string = process.env.JWT_SECRET ?? 'test-jwt-secret-seed-00000000000001';

const PROBE_EMAIL = 'seed-probe@example.com';
const SENTINEL_SECRET = 'seed-test-sentinel-secret-0123456789abcdef';
const CLOSED_PORT_URL = 'postgresql://seeduser:s3cret-pass@localhost:59999/seeddb';

const prisma = new PrismaClient({
  datasources: { db: { url: testDatabaseUrl } },
});

type SeedRun = {
  status: number | null;
  output: string;
};

function withSslRequire(databaseUrl: string): string {
  const base = databaseUrl.split('?')[0];
  return `${base}?sslmode=require`;
}

function childEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function runSeed(overrides: Record<string, string | undefined> = {}): SeedRun {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, ['run', 'db:seed'], {
    encoding: 'utf8',
    timeout: 120000,
    shell: process.platform === 'win32',
    env: childEnv({
      DATABASE_URL: testDatabaseUrl,
      JWT_SECRET: testJwtSecret,
      NODE_ENV: 'test',
      ...overrides,
    }),
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  return { status: result.status, output: `${stdout}\n${stderr}` };
}

async function tableCounts(): Promise<{ users: number; credentials: number }> {
  const users = await prisma.user.count();
  const credentials = await prisma.credential.count();
  return { users, credentials };
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    throw new Error(
      'PostgreSQL unavailable: seed tests require a running database at DATABASE_URL.',
    );
  }
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: PROBE_EMAIL } });
  await prisma.$disconnect();
});

describe('prisma seed', () => {
  it(
    'succeeds and reports completion',
    async () => {
      const run = runSeed();
      expect(run.status).toBe(0);
      expect(run.output).toContain('Seed completed successfully');
    },
    { timeout: 120000 },
  );

  it(
    'is idempotent and leaves unrelated application data untouched',
    async () => {
      await prisma.user.deleteMany({ where: { email: PROBE_EMAIL } });
      const before = await tableCounts();

      await prisma.user.create({
        data: { id: randomUUID(), email: PROBE_EMAIL, displayName: 'Seed Probe' },
      });

      const first = runSeed();
      expect(first.status).toBe(0);
      const second = runSeed();
      expect(second.status).toBe(0);

      const after = await tableCounts();
      expect(after.users).toBe(before.users + 1);
      expect(after.credentials).toBe(before.credentials);

      const probe = await prisma.user.findUnique({ where: { email: PROBE_EMAIL } });
      expect(probe).not.toBeNull();
      expect(probe?.displayName).toBe('Seed Probe');

      await prisma.user.deleteMany({ where: { email: PROBE_EMAIL } });
      const cleaned = await tableCounts();
      expect(cleaned).toEqual(before);
    },
    { timeout: 120000 },
  );

  it(
    'refuses production execution without touching data',
    async () => {
      const before = await tableCounts();
      const run = runSeed({
        NODE_ENV: 'production',
        DATABASE_URL: withSslRequire(testDatabaseUrl),
        APP_BASE_URL: 'https://app.example.com',
      });
      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(/production/i);
      const after = await tableCounts();
      expect(after).toEqual(before);
    },
    { timeout: 120000 },
  );

  it(
    'fails clearly when DATABASE_URL is missing',
    async () => {
      const run = runSeed({ DATABASE_URL: undefined });
      expect(run.status).not.toBe(0);
      expect(run.output).toContain('invalid environment configuration');
      // Validation must fire before any database interaction is attempted.
      expect(run.output).not.toContain('Seed started');
    },
    { timeout: 120000 },
  );

  it(
    'fails clearly on an invalid DATABASE_URL without echoing it',
    async () => {
      const run = runSeed({ DATABASE_URL: 'not-a-valid-url' });
      expect(run.status).not.toBe(0);
      expect(run.output).toContain('invalid environment configuration');
      expect(run.output).not.toContain('not-a-valid-url');
    },
    { timeout: 120000 },
  );

  it(
    'fails loudly on unreachable PostgreSQL without emitting secrets',
    async () => {
      const run = runSeed({ DATABASE_URL: CLOSED_PORT_URL, JWT_SECRET: SENTINEL_SECRET });
      expect(run.status).not.toBe(0);
      expect(run.output).not.toContain('s3cret-pass');
      expect(run.output).not.toContain(SENTINEL_SECRET);
      expect(run.output).not.toContain(CLOSED_PORT_URL);
    },
    { timeout: 120000 },
  );

  it(
    'never emits secrets on the success path',
    async () => {
      const run = runSeed({ JWT_SECRET: SENTINEL_SECRET });
      expect(run.status).toBe(0);
      expect(run.output).not.toContain(SENTINEL_SECRET);
      expect(run.output).not.toContain(testDatabaseUrl);
    },
    { timeout: 120000 },
  );
});
