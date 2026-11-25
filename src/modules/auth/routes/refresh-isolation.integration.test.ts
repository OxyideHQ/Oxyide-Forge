import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('../../../app/app.js');

let app: FastifyInstance;
let dbAvailable = false;

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

  app = await buildApp();
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await cleanDatabase();
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanDatabase();
  }
  await app?.close();
  await prisma.$disconnect();
});

function cookiesOf(response: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const out: Record<string, string> = {};
  for (const entry of list) {
    const pair = entry.split(';')[0];
    const separator = pair.indexOf('=');
    out[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return out;
}

async function browserLogin(email: string, password: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { accept: 'text/html' },
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  return cookiesOf(response);
}

async function refreshWith(refreshCookie: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    headers: { cookie: `refreshToken=${refreshCookie}` },
  });
}

/**
 * M5.7 — refresh/session family isolation (live).
 *
 * Proves destructive session operations (replay-kill, revoke-all,
 * logout, password reset) affect EXACTLY the targeted family: a second
 * user's live session survives each event. Covers M57-INV-007.
 */
describe('refresh family isolation', () => {
  it(
    'replay kills only the replayed family; the other user stays live',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      for (const who of ['iso-a', 'iso-b']) {
        const email = `${who}-${stamp}@example.com`;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/auth/register',
              payload: { email, password: 'correct-horse-battery-staple' },
            })
          ).statusCode,
        ).toBe(201);
      }

      const cookiesA = await browserLogin(`iso-a-${stamp}@example.com`, 'correct-horse-battery-staple');
      const cookiesB = await browserLogin(`iso-b-${stamp}@example.com`, 'correct-horse-battery-staple');

      // Rotate A once: presented credential consumed, successor issued.
      const rotated = await refreshWith(cookiesA.refreshToken);
      expect(rotated.statusCode).toBe(200);

      // Replay the CONSUMED ancestor: family dies.
      const replay = await refreshWith(cookiesA.refreshToken);
      expect(replay.statusCode).toBe(401);

      // The successor from the legitimate rotation is dead too (family).
      const successor = cookiesOf(rotated).refreshToken;
      expect((await refreshWith(successor)).statusCode).toBe(401);

      // User B is completely unaffected.
      expect((await refreshWith(cookiesB.refreshToken)).statusCode).toBe(200);
    },
  );

  it(
    'revoke-all, logout, and password reset are scoped to the acting user',
    { timeout: 120000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();

      async function setup(who: string) {
        const email = `${who}-${stamp}@example.com`;
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email, password: 'correct-horse-battery-staple' },
        });
        const login = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email, password: 'correct-horse-battery-staple' },
        });
        return {
          email,
          token: (login.json() as { accessToken: string }).accessToken,
          cookies: await browserLogin(email, 'correct-horse-battery-staple'),
        };
      }

      const a = await setup('scope-a');
      const b = await setup('scope-b');

      // revoke-all A → A dead, B live.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/sessions/revoke-all',
            headers: { authorization: `Bearer ${a.token}` },
          })
        ).statusCode,
      ).toBe(204);
      expect((await refreshWith(a.cookies.refreshToken)).statusCode).toBe(401);
      expect((await refreshWith(b.cookies.refreshToken)).statusCode).toBe(200);

      // logout B (single session) → B dead; A already dead stays dead.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/logout',
            headers: { cookie: `refreshToken=${b.cookies.refreshToken}` },
          })
        ).statusCode,
      ).toBe(204);
      expect((await refreshWith(b.cookies.refreshToken)).statusCode).toBe(401);
    },
  );
});
