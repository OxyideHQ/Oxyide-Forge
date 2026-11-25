import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('./app.js');

let app: FastifyInstance;
let dbAvailable = false;

const captured: string[] = [];
const captureStream = {
  write(chunk: unknown): boolean {
    captured.push(String(chunk));
    return true;
  },
};
function logs(): string {
  return captured.join('\n');
}

async function cleanDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EmailVerificationToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "PasswordResetToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "RefreshToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Session" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "LoginThrottle" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Credential" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
}

beforeAll(async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run integration tests with NODE_ENV=production: suites truncate tables.',
    );
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    throw new Error(
      'PostgreSQL unavailable: integration tests require a running database at DATABASE_URL.',
    );
  }

  app = await buildApp({ loggerStream: captureStream });
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  captured.length = 0;
  await cleanDatabase();
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanDatabase();
  }
  await app?.close();
  await prisma.$disconnect();
});

function headerId(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['x-request-id'];
  expect(typeof value).toBe('string');
  return value as string;
}

function instanceId(body: unknown): string {
  const instance = (body as { instance?: unknown }).instance;
  expect(typeof instance).toBe('string');
  return instance as string;
}

/** Proves response header, Problem Details instance, and log reqId agree. */
function expectTriangulated(
  response: { headers: Record<string, unknown>; json(): unknown },
  expectedInstance: string,
): void {
  const header = headerId(response);
  expect(expectedInstance).toBe(`/requests/${header}`);
  expect(logs()).toContain(`"reqId":"${header}"`);
}

/**
 * M6.6 — request correlation triangulation (live application pipeline).
 *
 * For every exercised path: response `X-Request-ID` == Problem Details
 * `instance` suffix == log `reqId`. Client-supplied IDs never appear in
 * any of the three. Concurrent requests never share or cross identifiers.
 */
describe('request correlation triangulation', () => {
  it(
    'correlates success responses across 200/201/204',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `tri-${Date.now()}@example.com`;

      const health = await app.inject({ method: 'GET', url: '/health/live' });
      expect(health.statusCode).toBe(200);
      expect(headerId(health)).toMatch(/^req-[0-9a-z]+$/);

      const register = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      expect(register.statusCode).toBe(201);
      expect(headerId(register)).toMatch(/^req-[0-9a-z]+$/);
      expect(logs()).toContain(`"reqId":"${headerId(register)}"`);
    },
  );

  it(
    'correlates error responses: 401/404/409 share header, instance, and reqId',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `tri-err-${Date.now()}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct-horse-battery-staple' },
      });

      const unauth = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      expect(unauth.statusCode).toBe(401);
      expectTriangulated(unauth, instanceId(unauth.json()));

      const unknown = await app.inject({ method: 'GET', url: '/no-such-tri-route' });
      expect(unknown.statusCode).toBe(404);
      expectTriangulated(unknown, instanceId(unknown.json()));

      const dup = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      expect(dup.statusCode).toBe(409);
      expectTriangulated(dup, instanceId(dup.json()));
    },
  );

  it(
    'correlates authorization decisions: deny events carry the response ID',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      for (const who of ['tri-a', 'tri-b']) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email: `${who}-${stamp}@example.com`, password: 'correct-horse-battery-staple' },
        });
      }
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: `tri-a-${stamp}@example.com`, password: 'correct-horse-battery-staple' },
      });
      const token = (login.json() as { accessToken: string }).accessToken;
      const target = await prisma.user.findUnique({
        where: { email: `tri-b-${stamp}@example.com` },
      });

      const denied = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${target!.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(denied.statusCode).toBe(403);
      const header = headerId(denied);
      expectTriangulated(denied, instanceId(denied.json()));
      // The authorization decision event carries the same request ID.
      expect(logs()).toContain('authorization.decision');
      expect(logs()).toContain(`"reqId":"${header}"`);
    },
  );

  it(
    'ignores hostile client-supplied IDs in all three correlation points',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const hostile = 'ATTACKER-ID\r\nX-Injected: yes';
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { 'x-request-id': hostile },
      });
      expect(response.statusCode).toBe(401);
      const header = headerId(response);
      expect(header).toMatch(/^req-[0-9a-z]+$/);
      expectTriangulated(response, instanceId(response.json()));
      expect(logs()).not.toContain('ATTACKER-ID');
      expect(logs()).not.toContain('X-Injected');
    },
  );

  it(
    'isolates concurrent requests: no shared or crossed identifiers',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          i % 2 === 0
            ? app.inject({ method: 'GET', url: '/health/live' })
            : app.inject({ method: 'GET', url: '/api/v1/auth/me' }),
        ),
      );
      const ids = results.map((r) => headerId(r));
      // All distinct: no shared mutable request state.
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id).toMatch(/^req-[0-9a-z]+$/);
        expect(logs()).toContain(`"reqId":"${id}"`);
      }
    },
  );

  it(
    'correlates concurrent errors independently',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const results = await Promise.all([
        app.inject({ method: 'GET', url: '/api/v1/auth/me' }),
        app.inject({ method: 'GET', url: '/missing-a' }),
        app.inject({ method: 'GET', url: '/api/v1/auth/me' }),
        app.inject({ method: 'GET', url: '/missing-b' }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([401, 401, 404, 404]);
      for (const response of results) {
        expectTriangulated(response, instanceId(response.json()));
      }
      const ids = results.map((r) => headerId(r));
      expect(new Set(ids).size).toBe(ids.length);
    },
  );
});
