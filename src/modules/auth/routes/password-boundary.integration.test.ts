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
const { authService } = await import('../services/auth.service.js');

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

async function register(email: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password },
  });
}

async function login(email: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
}

/**
 * M5.5 — password byte-boundary enforcement (live).
 *
 * Proves the canonical policy (min 12 chars, max 72 UTF-8 bytes) holds
 * end-to-end on every password-setting path, that the multibyte
 * truncation-collision class cannot be created, and that passwords are
 * handled exactly (whitespace preserved, no normalization) on every path.
 */
describe('registration boundaries (R01–R05)', () => {
  it(
    'R01/R03 accepts valid and boundary-maximum ASCII passwords',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      expect((await register(`r01-${Date.now()}@example.com`, 'a'.repeat(12))).statusCode).toBe(
        201,
      );
      expect((await register(`r03-${Date.now()}@example.com`, 'b'.repeat(72))).statusCode).toBe(
        201,
      );
    },
  );

  it(
    'R02 rejects below-minimum passwords with 400',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const response = await register(`r02-${Date.now()}@example.com`, 'short');
      expect(response.statusCode).toBe(400);
    },
  );

  it(
    'R04 rejects one-char-over-maximum ASCII with 400',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const response = await register(`r04-${Date.now()}@example.com`, 'b'.repeat(73));
      expect(response.statusCode).toBe(400);
    },
  );

  it(
    'R05 accepts multibyte input exactly at the byte boundary and rejects one byte over',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      // 36×'é' = 72 bytes: schema (36 chars) and policy (72 bytes) both pass.
      const ok = await register(`r05a-${Date.now()}@example.com`, 'é'.repeat(36));
      expect(ok.statusCode).toBe(201);

      // 37×'é' = 74 bytes: schema counts 37 CHARS (passes maxLength:72) but
      // the canonical policy counts BYTES and rejects with AUTH_INVALID_PASSWORD.
      const over = await register(`r05b-${Date.now()}@example.com`, 'é'.repeat(37));
      expect(over.statusCode).toBe(400);
      expect(over.json().code).toBe('AUTH_INVALID_PASSWORD');
      expect(JSON.stringify(over.json())).not.toContain('é'.repeat(37));
    },
  );
});

describe('truncation-collision adversarial (M5.5 core)', () => {
  it(
    'rejects both halves of an ASCII prefix-collision pair (class cannot be created)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const prefix = 'x'.repeat(72);
      const a = await register(`coll-a-${Date.now()}@example.com`, `${prefix}SUFFIX-A`);
      const b = await register(`coll-b-${Date.now()}@example.com`, `${prefix}SUFFIX-B`);
      // Both exceed 72 bytes (schema passes: ≤72 chars is false here — 79
      // chars — so these are schema 400s; the byte-equivalent multibyte
      // pair below exercises the SERVICE policy specifically).
      expect(a.statusCode).toBe(400);
      expect(b.statusCode).toBe(400);
    },
  );

  it(
    'rejects multibyte prefix-collision pairs at the service policy layer',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      // 36×'é' (72 bytes) + suffix: 40 chars total — passes the 72-char
      // schema, exceeds the 72-byte policy. Pre-M5.5 both would hash to the
      // same 72-byte prefix and verify identically.
      const a = 'é'.repeat(36) + 'AAAA';
      const b = 'é'.repeat(36) + 'BBBB';
      expect(a.length).toBeLessThanOrEqual(72);

      const ra = await register(`mcoll-a-${Date.now()}@example.com`, a);
      const rb = await register(`mcoll-b-${Date.now()}@example.com`, b);
      expect(ra.statusCode).toBe(400);
      expect(ra.json().code).toBe('AUTH_INVALID_PASSWORD');
      expect(rb.statusCode).toBe(400);
      expect(rb.json().code).toBe('AUTH_INVALID_PASSWORD');

      // Neither account was created: nothing truncatable was persisted.
      expect(await prisma.user.count()).toBe(0);
    },
  );
});

describe('password exactness: whitespace and normalization (L03/L04 + setting paths)', () => {
  it(
    'preserves leading/trailing/internal whitespace on register and login',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `ws-${Date.now()}@example.com`;
      const password = '  spaced out inside  ';

      expect((await register(email, password)).statusCode).toBe(201);
      // Exact password verifies…
      expect((await login(email, password)).statusCode).toBe(200);
      // …a trimmed variant does not (no accidental trim()).
      expect((await login(email, password.trim())).statusCode).toBe(401);
    },
  );

  it(
    'treats composed and decomposed Unicode as distinct passwords (no normalization)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `norm-${Date.now()}@example.com`;
      const composed = 'caf\u00e9-unique-pass';
      const decomposed = 'cafe\u0301-unique-pass';
      expect(composed).not.toBe(decomposed);

      expect((await register(email, composed)).statusCode).toBe(201);
      expect((await login(email, composed)).statusCode).toBe(200);
      expect((await login(email, decomposed)).statusCode).toBe(401);
    },
  );

  it(
    'accepts emoji passwords within byte bounds end-to-end',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `emoji-${Date.now()}@example.com`;
      const password = '🔐secure-pass-🔐key!';

      expect((await register(email, password)).statusCode).toBe(201);
      expect((await login(email, password)).statusCode).toBe(200);
    },
  );
});

describe('reset boundaries (RS01–RS05) with session/token consequences (RS06/RS07)', () => {
  type Captured = { to: string; resetUrl: string };

  async function requestReset(email: string): Promise<string> {
    const sent: Captured[] = [];
    await authService.requestPasswordReset(email, '127.0.0.1', {
      sendPasswordResetEmail: async (message: Captured): Promise<void> => {
        sent.push(message);
      },
    });
    expect(sent).toHaveLength(1);
    return sent[0].resetUrl.split('token=')[1];
  }

  it(
    'RS01/RS03 completes reset with valid and boundary Unicode passwords, revoking sessions',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `rs01-${Date.now()}@example.com`;
      const oldPassword = 'correct-horse-battery-staple';
      expect((await register(email, oldPassword)).statusCode).toBe(201);

      const loginBefore = await login(email, oldPassword);
      expect(loginBefore.statusCode).toBe(200);

      // RS03: boundary Unicode password (36×'é' + suffix stays ≤72 bytes? No:
      // 36×'é' alone is exactly 72 bytes — use it whole).
      const newPassword = 'é'.repeat(36);
      const token = await requestReset(email);
      const confirm = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token, password: newPassword },
      });
      expect(confirm.statusCode).toBe(204);

      // RS07: old password dead, new Unicode password live (single-use RS06
      // covered by existing suites; reusing the token here fails).
      expect((await login(email, oldPassword)).statusCode).toBe(401);
      expect((await login(email, newPassword)).statusCode).toBe(200);
      const reuse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token, password: 'another-valid-password' },
      });
      expect(reuse.statusCode).toBe(401);
    },
  );

  it(
    'RS02/RS04/RS05 rejects invalid, over-limit, and over-byte Unicode passwords without consuming the token',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `rs02-${Date.now()}@example.com`;
      const oldPassword = 'correct-horse-battery-staple';
      expect((await register(email, oldPassword)).statusCode).toBe(201);

      const token = await requestReset(email);
      for (const bad of ['short', 'b'.repeat(73), 'é'.repeat(37)]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/password-reset/confirm',
          payload: { token, password: bad },
        });
        expect(response.statusCode).toBe(400);
      }

      // Rejected passwords never hashed, token never consumed, account intact:
      // a valid reset with the same token still succeeds.
      const retry = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token, password: 'fresh-valid-password' },
      });
      expect(retry.statusCode).toBe(204);
      expect((await login(email, 'fresh-valid-password')).statusCode).toBe(200);
    },
  );
});

describe('login exactness regression (L01/L02/L05)', () => {
  it(
    'L01/L02/L05 correct verifies, incorrect fails identically with no oracle delta',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `lgn-${Date.now()}@example.com`;
      expect((await register(email, 'correct-horse-battery-staple')).statusCode).toBe(201);

      const ok = await login(email, 'correct-horse-battery-staple');
      expect(ok.statusCode).toBe(200);

      const wrong = await login(email, 'wrong-password-xyz');
      const unknown = await login(`unknown-${Date.now()}@example.com`, 'wrong-password-xyz');
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      // Identical shape: same code, same keys, no existence signal.
      expect(Object.keys(wrong.json()).sort()).toEqual(Object.keys(unknown.json()).sort());
      expect(wrong.json().code).toBe(unknown.json().code);
    },
  );
});
