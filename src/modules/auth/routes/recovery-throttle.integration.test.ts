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

async function register(email: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  expect(response.statusCode).toBe(201);
}

async function requestReset(email: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/password-reset/request',
    payload: { email },
  });
}

/**
 * Enumeration-parity comparison (M6.3): identical except per-occurrence
 * `instance` IDs (unique by design, no distinguishing signal).
 */
function expectParityBodies(first: unknown, second: unknown): void {
  const firstRecord = first as Record<string, unknown>;
  const secondRecord = second as Record<string, unknown>;
  expect(typeof firstRecord.instance).toBe('string');
  expect(typeof secondRecord.instance).toBe('string');
  const { instance: _dropA, ...restA } = firstRecord;
  const { instance: _dropB, ...restB } = secondRecord;
  void _dropA;
  void _dropB;
  expect(restA).toEqual(restB);
}

async function resendVerification(email: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/email-verification/resend',
    payload: { email },
  });
}

/**
 * M5.4 — recovery-issuance frequency control (live).
 *
 * Proves the two unauthenticated email-issuing endpoints reject
 * over-limit volume with 429 before any user lookup or issuance runs,
 * identically for known and unknown addresses (no enumeration oracle),
 * with per-endpoint namespaces and race-safe burst bounds.
 */
describe('password-reset request throttle', () => {
  it(
    'allows 5 requests then rejects the 6th with 429 for a known address',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `reset-throttle-${Date.now()}@example.com`;
      await register(email);

      for (let i = 0; i < 5; i += 1) {
        const response = await requestReset(email);
        expect(response.statusCode).toBe(204);
      }

      const throttled = await requestReset(email);
      expect(throttled.statusCode).toBe(429);
      const body = throttled.json();
      expect(body.code).toBe('AUTH_TOO_MANY_ATTEMPTS');
      expect(JSON.stringify(body)).not.toContain(email);
    },
  );

  it(
    'throttles unknown addresses identically to known ones (no oracle)',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const known = `known-${Date.now()}@example.com`;
      await register(known);
      const ghost = `ghost-${Date.now()}@example.com`;

      for (let i = 0; i < 5; i += 1) {
        expect((await requestReset(known)).statusCode).toBe(204);
        expect((await requestReset(ghost)).statusCode).toBe(204);
      }

      const knownThrottled = await requestReset(known);
      const ghostThrottled = await requestReset(ghost);

      // Identical rejection except per-occurrence instance: same status,
      // same code, same shape, and neither body names the attempted address.
      // (`instance` is unique per occurrence by design and carries no
      // distinguishing signal — see expectParityBodies.)
      expect(knownThrottled.statusCode).toBe(429);
      expect(ghostThrottled.statusCode).toBe(429);
      expectParityBodies(ghostThrottled.json(), knownThrottled.json());
      expect(JSON.stringify(ghostThrottled.json())).not.toContain('ghost');
      expect(JSON.stringify(knownThrottled.json())).not.toContain('known');
    },
  );

  it(
    'bounds concurrent bursts: 10 simultaneous requests issue at most 5',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `reset-burst-${Date.now()}@example.com`;
      await register(email);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => requestReset(email)),
      );
      const allowed = results.filter((r) => r.statusCode === 204).length;
      const rejected = results.filter((r) => r.statusCode === 429).length;

      expect(allowed).toBe(5);
      expect(rejected).toBe(5);
      for (const r of results.filter((x) => x.statusCode === 429)) {
        expect(r.json().code).toBe('AUTH_TOO_MANY_ATTEMPTS');
      }
    },
  );

  it(
    'keeps per-address buckets independent under one shared source IP',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      // Six distinct addresses from the same inject IP: none may observe
      // another address's consumption.
      for (let i = 0; i < 6; i += 1) {
        const response = await requestReset(`spray-${Date.now()}-${i}@example.com`);
        expect(response.statusCode).toBe(204);
      }
    },
  );

  it(
    'ignores X-Forwarded-For when selecting the throttle key',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `spoof-${Date.now()}@example.com`;

      // Rotating spoofed forwarded headers must not move the bucket: the
      // socket IP selects the key, so all six consume one account bucket.
      for (let i = 0; i < 5; i += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/password-reset/request',
          headers: { 'x-forwarded-for': `10.0.0.${i}` },
          payload: { email },
        });
        expect(response.statusCode).toBe(204);
      }

      const throttled = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        headers: { 'x-forwarded-for': '10.9.9.9' },
        payload: { email },
      });
      expect(throttled.statusCode).toBe(429);
    },
  );
});

describe('email-verification resend throttle', () => {
  it(
    'allows 5 resends then rejects the 6th with 429',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `verify-throttle-${Date.now()}@example.com`;
      await register(email);

      for (let i = 0; i < 5; i += 1) {
        const response = await resendVerification(email);
        expect(response.statusCode).toBe(204);
      }

      const throttled = await resendVerification(email);
      expect(throttled.statusCode).toBe(429);
      expect(throttled.json().code).toBe('AUTH_TOO_MANY_ATTEMPTS');
    },
  );

  it(
    'uses a namespace isolated from password-reset (no cross-talk)',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `isolated-${Date.now()}@example.com`;
      await register(email);

      for (let i = 0; i < 5; i += 1) {
        expect((await requestReset(email)).statusCode).toBe(204);
      }
      expect((await requestReset(email)).statusCode).toBe(429);

      // The resend namespace is untouched by reset consumption.
      expect((await resendVerification(email)).statusCode).toBe(204);
    },
  );
});
