/**
 * Connection configuration integration tests (M2.4).
 *
 * Proves the Prisma 6.12.0 connection mechanisms used by the production
 * contract against the test PostgreSQL database: pool parameters are honored,
 * exhaustion fails fast with P2024, establishment failures are bounded, and
 * sslmode=require is really enforced (not silently ignored).
 *
 * Follows the repository integration-test contract: fails fast when
 * PostgreSQL is unavailable, refuses NODE_ENV=production, performs no writes
 * (read-only queries plus a lock-free pg_sleep holder), and disconnects every
 * client it constructs.
 *
 * These tests require a running PostgreSQL instance at DATABASE_URL.
 * When the database is unavailable, the suite fails fast instead of
 * silently passing.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

const BASE_DATABASE_URL: string = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/oxyide_test';
const BASE_URL_NO_QUERY: string = BASE_DATABASE_URL.split('?')[0];

function urlWithParams(params: string): string {
  return `${BASE_URL_NO_QUERY}?${params}`;
}

function urlWithCredentials(user: string, password: string): string {
  const url = new URL(BASE_URL_NO_QUERY);
  url.username = user;
  url.password = password;
  return url.toString();
}

function closedPortUrl(): string {
  const url = new URL(BASE_URL_NO_QUERY);
  url.port = '59999';
  url.pathname = '/nonexistent';
  return url.toString();
}

const clients: PrismaClient[] = [];

function track(client: PrismaClient): PrismaClient {
  clients.push(client);
  return client;
}

function newClient(databaseUrl: string): PrismaClient {
  return track(new PrismaClient({ datasources: { db: { url: databaseUrl } } }));
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function countSleepers(client: PrismaClient): Promise<number> {
  const rows = (await client.$queryRawUnsafe(
    "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND query LIKE '%pg_sleep%'",
  )) as Array<{ n: bigint }>;
  return Number(rows[0]?.n ?? 0);
}

async function waitForHolder(client: PrismaClient, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await countSleepers(client)) >= 1) return;
    if (Date.now() > deadline) {
      throw new Error('holder query never started sleeping within 10s (environmental)');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

beforeAll(async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run integration tests with NODE_ENV=production: suites truncate tables.',
    );
  }
  const probe = track(new PrismaClient({ datasources: { db: { url: BASE_DATABASE_URL } } }));
  try {
    await probe.$queryRaw`SELECT 1`;
  } catch {
    throw new Error(
      'PostgreSQL unavailable: connection tests require a running database at DATABASE_URL.',
    );
  }
});

afterAll(async () => {
  await Promise.allSettled(clients.map((client) => client.$disconnect()));
});

describe('prisma connection configuration', () => {
  it('connects with explicit pool parameters', async () => {
    const prisma = newClient(
      urlWithParams('connection_limit=5&pool_timeout=5&connect_timeout=5'),
    );
    try {
      const rows = await prisma.$queryRawUnsafe('SELECT 1 AS one');
      expect(rows).toEqual([{ one: 1 }]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('rejects an invalid pool size at first query without leaking credentials', async () => {
    const prisma = newClient(`${urlWithCredentials('seeduser', 's3cret-pass')}?connection_limit=abc`);
    try {
      await prisma.$queryRawUnsafe('SELECT 1 AS one');
      expect.unreachable('invalid connection_limit must fail');
    } catch (error: unknown) {
      expect(errorCode(error)).toBe('');
      expect(errorMessage(error)).toMatch(/not supported in database URL/i);
      expect(errorMessage(error)).not.toContain('s3cret-pass');
      expect(errorMessage(error)).not.toContain('seeduser');
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
  });

  it('enforces sslmode=require against a non-TLS server', async () => {
    const prisma = newClient(urlWithParams('sslmode=require'));
    try {
      await prisma.$queryRawUnsafe('SELECT 1 AS one');
      expect.unreachable('sslmode=require against plaintext PostgreSQL must fail');
    } catch (error: unknown) {
      expect(errorMessage(error)).toMatch(/tls|ssl/i);
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
  });

  it(
    'pool exhaustion fails fast with P2024 and the pool recovers',
    async () => {
      const prisma = newClient(urlWithParams('connection_limit=1&pool_timeout=2'));
      const inspector = newClient(BASE_DATABASE_URL);
      try {
        // Warm up so the single pooled connection exists before contention.
        // A warmup failure propagates raw (setup problem, not a pool verdict).
        await prisma.$queryRawUnsafe('SELECT 1 AS one');

        const holder = prisma.$queryRawUnsafe(
          'SELECT count(*) AS n FROM (SELECT pg_sleep(6)) AS s',
        );
        holder.catch(() => undefined);
        // Gate on server-side truth: contend only once the holder provably
        // occupies the only connection, so no fixed stagger can race acquisition.
        await waitForHolder(inspector);

        const start = Date.now();
        const outcome = await prisma
          .$queryRawUnsafe('SELECT 1 AS one')
          .then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        if (outcome.ok) {
          const holding = await countSleepers(inspector);
          throw new Error(`pool did not constrain the contender (holder backends: ${holding})`);
        }
        expect(errorCode(outcome.error)).toBe('P2024');
        expect(errorMessage(outcome.error)).toMatch(/connection pool/i);
        expect(errorMessage(outcome.error)).not.toContain('s3cret-pass');
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(20000);

        await holder;
        const recovered = await prisma.$queryRawUnsafe('SELECT 1 AS one');
        expect(recovered).toEqual([{ one: 1 }]);
      } finally {
        await inspector.$disconnect().catch(() => undefined);
        await prisma.$disconnect().catch(() => undefined);
      }
    },
    { timeout: 60000 },
  );

  it(
    'connect_timeout bounds establishment failure',
    async () => {
      const prisma = newClient(`${closedPortUrl()}?connect_timeout=2`);
      const start = Date.now();
      try {
        await prisma.$queryRawUnsafe('SELECT 1 AS one');
        expect.unreachable('unreachable database must fail');
      } catch (error: unknown) {
        // Connection-establishment failures surface as
        // PrismaClientInitializationError WITHOUT a machine-readable code in
        // Prisma 6.12 (verified: neither .code nor .errorCode is set), so the
        // contract matches on error name plus host/port in the message.
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe('PrismaClientInitializationError');
        expect(errorMessage(error)).toContain('59999');
      }
      expect(Date.now() - start).toBeLessThan(60000);
    },
    { timeout: 60000 },
  );

  it('disconnects cleanly after failures and a fresh client still works', async () => {
    const prisma = newClient(urlWithParams('connection_limit=1&pool_timeout=1'));
    const inspector = newClient(BASE_DATABASE_URL);
    try {
      const holder = prisma.$queryRawUnsafe('SELECT count(*) AS n FROM (SELECT pg_sleep(4)) AS s');
      holder.catch(() => undefined);
      await waitForHolder(inspector);
      await expect(prisma.$queryRawUnsafe('SELECT 1 AS one')).rejects.toMatchObject({
        code: 'P2024',
      });
      await holder;
    } finally {
      await inspector.$disconnect().catch(() => undefined);
      await prisma.$disconnect();
    }

    const fresh = newClient(urlWithParams('connection_limit=1&pool_timeout=1'));
    try {
      const rows = await fresh.$queryRawUnsafe('SELECT 1 AS one');
      expect(rows).toEqual([{ one: 1 }]);
    } finally {
      await fresh.$disconnect();
    }
  }, { timeout: 60000 });
});
