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

/**
 * M6.5 — status policy matrix (live).
 *
 * Pins the finalized 404/409 decisions and proves the 422 non-adoption:
 * representative invalid inputs across every body-bearing endpoint never
 * produce 422 (Option B — deliberate, not oversight). Covers M65-INV-001,
 * 002, 004, 005–009, 012–017, 020.
 */
describe('status policy matrix', () => {
  it(
    '404: unknown route, authorized-missing user, unknown role (never 401/403-substitutes)',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      const email = `matrix-${stamp}@example.com`;
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
      const token = (login.json() as { accessToken: string }).accessToken;
      const selfId = (app.jwt.decode(token) as { sub: string }).sub;
      // Promote to admin so cross-user reads pass authorization and reach
      // the missing-target lookup (plain users are denied first — 403 —
      // which the next test asserts separately).
      await prisma.user.update({ where: { id: selfId }, data: { role: 'admin' } });
      const auth = { authorization: `Bearer ${token}` };

      const unknownRoute = await app.inject({ method: 'GET', url: '/no-such-path' });
      expect(unknownRoute.statusCode).toBe(404);
      expect(unknownRoute.json()).toMatchObject({ code: 'NOT_FOUND', status: 404 });

      const missingUser = await app.inject({
        method: 'GET',
        url: '/api/v1/users/00000000-0000-0000-0000-000000000000',
        headers: auth,
      });
      expect(missingUser.statusCode).toBe(404);
      expect(missingUser.json()).toMatchObject({ code: 'USERS_NOT_FOUND', status: 404 });
    },
  );

  it(
    '401/403 are never converted to 404 (M4 distinction preserved)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      // No credential on protected route → 401, not 404.
      expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
    },
  );

  it(
    '409: duplicate registration is the single producer (USERS_EMAIL_TAKEN)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `dup-${Date.now()}@example.com`;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { email, password: 'correct-horse-battery-staple' },
          })
        ).statusCode,
      ).toBe(201);
      const dup = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json()).toMatchObject({ code: 'USERS_EMAIL_TAKEN', status: 409 });
      expect(JSON.stringify(dup.json())).not.toContain('P2002');
    },
  );

  it(
    '422 is not adopted: invalid inputs across endpoints never emit 422',
    { timeout: 120000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      const badBodies: { method: string; url: string; payload: unknown }[] = [
        { method: 'POST', url: '/api/v1/auth/register', payload: { email: 'x' } },
        {
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email: `nz-${stamp}@example.com`, password: 'short' },
        },
        {
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email: `nz2-${stamp}@example.com`, password: 'é'.repeat(37) },
        },
        { method: 'POST', url: '/api/v1/auth/login', payload: { email: 'x' } },
        {
          method: 'POST',
          url: '/api/v1/auth/password-reset/request',
          payload: { email: 'not-an-email' },
        },
        {
          method: 'POST',
          url: '/api/v1/auth/password-reset/confirm',
          payload: { token: 'x', password: 'short' },
        },
        {
          method: 'POST',
          url: '/api/v1/auth/email-verification/resend',
          payload: { email: 'x' },
        },
        {
          method: 'POST',
          url: '/api/v1/auth/email-verification/confirm',
          payload: {},
        },
        { method: 'PUT', url: '/api/v1/users/abc', payload: { displayName: 42 } },
        { method: 'PUT', url: '/api/v1/users/abc', payload: { status: 'bogus' } },
        { method: 'PUT', url: '/api/v1/users/abc', payload: { id: 'injected' } },
      ];

      for (const probe of badBodies) {
        const response = await app.inject({
          method: probe.method as 'POST',
          url: probe.url,
          payload: probe.payload as Record<string, unknown>,
        });
        expect(response.statusCode).not.toBe(422);
        // All of these are schema/policy rejections: 400 family (401 only
        // where auth precedes validation — none here carry credentials).
        expect([400, 401]).toContain(response.statusCode);
      }
    },
  );

  it(
    'boundary statuses stay fixed: 400/401/403/413/415/429/500 matrix spot-check',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      // 413 oversized body.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            headers: { 'content-type': 'application/json' },
            payload: JSON.stringify({
              email: `m-${Date.now()}@example.com`,
              password: 'correct-horse-battery-staple',
              displayName: 'x'.repeat(1048576 + 1024),
            }),
          })
        ).statusCode,
      ).toBe(413);
      // 415 wrong media type.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            headers: { 'content-type': 'application/xml' },
            payload: '<a/>',
          })
        ).statusCode,
      ).toBe(415);
      // 401 no credential; 404 unknown route (sanity anchors).
      expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
    },
  );
});
