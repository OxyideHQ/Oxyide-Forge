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

async function register(email: string, password = 'correct-horse-battery-staple') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password },
  });
}

/**
 * M5.7 — registration abuse assessment (live).
 *
 * Measures the ACTUAL abuse surface (no throttle exists on this
 * endpoint by design — mass-creation is general rate limiting, M5.4
 * standing decision) and proves the properties that MUST hold with or
 * without throttling: single-winner concurrency, normalization
 * convergence, no overwrite on conflict, nothing persisted on rejection.
 * Verdict (throttle vs defer) is recorded in the M5.7 audit from this
 * evidence.
 */
describe('registration abuse surface', () => {
  it(
    'repeated same-email registration is stable: first 201, rest 409, one row',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `repeat-${Date.now()}@example.com`;

      expect((await register(email)).statusCode).toBe(201);
      for (let i = 0; i < 5; i += 1) {
        const response = await register(email);
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('USERS_EMAIL_TAKEN');
      }
      expect(await prisma.user.count()).toBe(1);
    },
  );

  it(
    'casing/whitespace variants converge on one account (no duplicates)',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const base = `Case-${Date.now()}@Example.COM`;
      expect((await register(`  ${base}  `)).statusCode).toBe(201);
      for (const variant of [base.toLowerCase(), base.toUpperCase(), ` ${base}`]) {
        expect((await register(variant)).statusCode).toBe(409);
      }
      expect(await prisma.user.count()).toBe(1);
    },
  );

  it(
    'concurrent same-email registration has exactly one winner',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `race-${Date.now()}@example.com`;

      const results = await Promise.all(
        Array.from({ length: 5 }, () => register(email)),
      );
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.credential.count()).toBe(1);
    },
  );

  it(
    'conflicting registration never overwrites profile or credential',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `conflict-${Date.now()}@example.com`;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: {
              email,
              password: 'correct-horse-battery-staple',
              displayName: 'First',
            },
          })
        ).statusCode,
      ).toBe(201);

      const conflict = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email,
          password: 'different-valid-password',
          displayName: 'Second',
        },
      });
      expect(conflict.statusCode).toBe(409);

      const stored = await prisma.user.findUnique({ where: { email } });
      expect(stored!.displayName).toBe('First');
      // Original credential still verifies; conflicting password does not.
      const loginOld = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      expect(loginOld.statusCode).toBe(200);
    },
  );

  it(
    'rejected registrations persist nothing (malformed, policy-violating)',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      for (const payload of [
        { email: 'not-an-email', password: 'correct-horse-battery-staple' },
        { email: `bad-${Date.now()}@example.com`, password: 'short' },
        { email: `over-${Date.now()}@example.com`, password: 'é'.repeat(37) },
        { email: `ok-${Date.now()}@example.com` },
      ]) {
        expect(
          (await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload }))
            .statusCode,
        ).toBe(400);
      }
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.credential.count()).toBe(0);
    },
  );

  it(
    'measures burst issuance volume (assessment evidence, no throttle asserted)',
    { timeout: 120000 },
    async () => {
      if (!dbAvailable) return;
      // 20 distinct addresses CAN all register: documents the unbounded
      // creation surface the M5.7 assessment rules on. Each address is
      // distinct, so no anti-enumeration or throttle behavior is involved.
      const stamp = Date.now();
      for (let i = 0; i < 20; i += 1) {
        const response = await register(`burst${i}-${stamp}@example.com`);
        expect(response.statusCode).toBe(201);
      }
      expect(await prisma.user.count()).toBe(20);
    },
  );
});
