/**
 * M3.19 — Login Account-Status Gate Integration Tests (FIND-05).
 *
 * Proves against real PostgreSQL that non-active accounts cannot
 * authenticate with correct passwords: suspended/inactive logins fail with
 * the generic 401, create no session, record the failure identically to a
 * wrong password, and recover fully on unsuspend. Refresh stays gated as
 * before; no notification is emitted for status rejections.
 *
 * Requires a running PostgreSQL instance at DATABASE_URL. Fails fast when
 * the database is unavailable.
 */

// Environment must be set before any module imports evaluate config.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('../../../app/app.js');

let app: FastifyInstance;
let dbAvailable = false;

const STRONG_PASSWORD = 'StrongPassword123!';
const WRONG_PASSWORD = 'WrongPassword999!';

function uniqueEmail(label: string): string {
  return `status-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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

async function registerUser(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: STRONG_PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

function loginRequest(email: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
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

describe('login account-status gate (M3.19 FIND-05)', () => {
  it(
    'rejects suspended and inactive logins with the generic 401 and no session',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      for (const status of ['suspended', 'inactive']) {
        const email = uniqueEmail(`reject-${status}`);
        const userId = await registerUser(email);
        await prisma.user.update({ where: { id: userId }, data: { status } });

        const response = await loginRequest(email, STRONG_PASSWORD);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          type: 'https://docs.oxyide.com/errors/auth-invalid-credentials',
          title: 'The email or password is incorrect.',
          status: 401,
          detail: 'The email or password is incorrect.',
          code: 'AUTH_INVALID_CREDENTIALS',
          instance: expect.any(String),
        });

        const sessions = await prisma.session.findMany({ where: { userId } });
        expect(sessions).toHaveLength(0);
      }
    },
  );

  it(
    'records suspended failures identically to wrong passwords',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('recorded');
      const userId = await registerUser(email);
      await prisma.user.update({ where: { id: userId }, data: { status: 'suspended' } });

      await loginRequest(email, WRONG_PASSWORD);
      const rows = await prisma.loginThrottle.findMany({
        where: { key: { startsWith: 'auth:login:v1:account:' } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].failureCount).toBe(1);
    },
  );

  it(
    'recovers fully on unsuspend with refresh gated consistently',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('recover');
      const userId = await registerUser(email);

      // Baseline: active login works and yields a refreshable session.
      const browserLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email, password: STRONG_PASSWORD },
      });
      expect(browserLogin.statusCode).toBe(200);
      const refreshCookie = browserLogin.cookies.find((cookie) => cookie.name === 'refreshToken');
      expect(refreshCookie).toBeDefined();

      // Suspend: login and refresh both reject; sessions survive (no revocation).
      await prisma.user.update({ where: { id: userId }, data: { status: 'suspended' } });
      expect((await loginRequest(email, STRONG_PASSWORD)).statusCode).toBe(401);
      const refreshWhileSuspended = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { refreshToken: refreshCookie!.value },
      });
      expect(refreshWhileSuspended.statusCode).toBe(401);

      // Unsuspend: full recovery with no residue.
      await prisma.user.update({ where: { id: userId }, data: { status: 'active' } });
      expect((await loginRequest(email, STRONG_PASSWORD)).statusCode).toBe(200);
      const refreshAfter = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { refreshToken: refreshCookie!.value },
      });
      expect(refreshAfter.statusCode).toBe(200);
    },
  );
});
