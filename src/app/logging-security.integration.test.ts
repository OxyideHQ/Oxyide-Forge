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

/** Synchronous in-memory log capture: deterministic, no flush waits. */
const captured: string[] = [];
const captureStream = {
  write(chunk: unknown): boolean {
    captured.push(String(chunk));
    return true;
  },
};

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

  // The REAL application pipeline (routes, plugins, error handler) with
  // logs routed to capture instead of stdout. Serializers and redaction
  // apply identically — only the destination differs.
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

function logs(): string {
  return captured.join('\n');
}

/** Guards against vacuous absence assertions: capture must have worked. */
function expectCaptureValid(): void {
  expect(logs()).toContain('incoming request');
  expect(logs()).toContain('reqId');
}

/**
 * M5.6 — end-to-end logging security (live application pipeline).
 *
 * Exercises the actual request/error/security logging paths with
 * secret-bearing traffic and asserts on EMITTED output: useful fields
 * present (method/path-no-query/status/reqId), secrets absent everywhere.
 */
describe('application logging output', () => {
  it(
    'logs auth flows with useful context and zero secrets',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `logcap-${Date.now()}@example.com`;
      const password = 'correct-horse-battery-staple';

      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { email, password },
          })
        ).statusCode,
      ).toBe(201);

      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { authorization: 'should-be-ignored-bearer', 'user-agent': 'SweepAgent/9.9' },
        payload: { email, password: 'wrong-password-xyz' },
      });
      expect(login.statusCode).toBe(401);

      // Unknown route with a secret-shaped query (no endpoint reads query —
      // the pipeline must still not record it).
      await app.inject({
        method: 'GET',
        url: '/?token=QUERYSECRET123&password=QUERYSECRET456',
        headers: { cookie: 'stolen=abc' },
      });

      expectCaptureValid();
      const out = logs();
      // Useful context retained.
      expect(out).toContain('/api/v1/auth/register');
      expect(out).toContain('/api/v1/auth/login');
      expect(out).toContain('401');
      // Secrets absent: body password, auth/cookie/user-agent headers,
      // query-string secrets.
      for (const secret of [
        password,
        'wrong-password-xyz',
        'should-be-ignored-bearer',
        'SweepAgent',
        'QUERYSECRET123',
        'QUERYSECRET456',
        'stolen=abc',
      ]) {
        expect(out).not.toContain(secret);
      }
      // Shape proof: request log lines carry no headers object at all.
      for (const line of captured.filter((entry) => entry.includes('incoming request'))) {
        const logged = JSON.parse(line) as { req: Record<string, unknown> };
        expect(Object.keys(logged.req).sort()).toEqual(['method', 'remoteAddress', 'url']);
        expect(logged.req.url).not.toContain('?');
      }
    },
  );

  it(
    'logs application errors with safe shape and no secret props',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      // Validation failure carrying a secret-valued field name.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'not-an-email', password: 'short' },
      });
      expect(response.statusCode).toBe(400);

      expectCaptureValid();
      // Field names may appear (operational); values must not.
      expect(logs()).not.toContain('short');
      expect(logs()).toContain('reqId');
    },
  );
});
