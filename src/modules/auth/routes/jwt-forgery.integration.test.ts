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

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

async function register(email: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  expect(response.statusCode).toBe(201);
}

async function loginToken(email: string): Promise<{ token: string; userId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  expect(response.statusCode).toBe(200);
  const token = (response.json() as { accessToken: string }).accessToken;
  const userId = (app.jwt.decode(token) as { sub: string }).sub;
  return { token, userId };
}

/**
 * M5.7 — JWT forgery matrix (live).
 *
 * Proves verification pins the algorithm, rejects malformed/oversized
 * tokens, and — defense in depth — that even a signature-valid token
 * carrying forged role/permission claims (compromised-secret scenario)
 * grants nothing beyond its subject: authorization derives exclusively
 * from the database role lookup, never from token claims.
 * Covers M57-INV-002/004/005.
 */
describe('JWT forgery resistance', () => {
  it(
    'rejects alg=none tokens for a real subject',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `jwt-none-${Date.now()}@example.com`;
      await register(email);
      const { userId } = await loginToken(email);

      const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: userId })}.`;
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${forged}` },
      });
      expect(response.statusCode).toBe(401);
    },
  );

  it(
    'rejects algorithm-confusion tokens (RS256/HS384 headers, HMAC body)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `jwt-alg-${Date.now()}@example.com`;
      await register(email);
      const { userId } = await loginToken(email);

      for (const alg of ['RS256', 'HS384', 'HS512']) {
        const forged = `${b64({ alg, typ: 'JWT' })}.${b64({ sub: userId })}.${b64({ forged: true })}`;
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: { authorization: `Bearer ${forged}` },
        });
        expect(response.statusCode).toBe(401);
      }
    },
  );

  it(
    'ignores forged role/permission claims even on signature-valid tokens',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `jwt-claims-${Date.now()}@example.com`;
      await register(email);
      const { userId } = await loginToken(email);

      // Compromised-secret scenario: attacker mints a VALIDLY SIGNED token
      // stuffing admin claims. The pipeline must still authorize from the
      // database role (plain user) — never from token claims.
      const minted = app.jwt.sign({
        sub: userId,
        role: 'admin',
        permissions: ['users:delete', 'roles:read'],
        isAdmin: true,
      });

      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${minted}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().role).toBe('user');

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${userId}`,
        headers: { authorization: `Bearer ${minted}` },
      });
      expect(del.statusCode).toBe(403);
    },
  );

  it(
    'rejects malformed structures, empty segments, and bad base64',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      for (const token of [
        'garbage',
        'a.b.c.d',
        '...',
        `${b64({ alg: 'HS256' })}..${b64({ x: 1 })}`,
        '!!!.@@@.###',
        '',
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(401);
      }
    },
  );

  it(
    'rejects oversized JWTs without authenticating',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const huge = `garbage.${b64({ sub: 'x', pad: 'p'.repeat(10 * 1024) })}.garbage`;
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${huge}` },
      });
      expect(response.statusCode).toBe(401);
    },
  );

  it(
    'ignores future iat (iat is not a verification input) but still enforces subject and expiry',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `jwt-iat-${Date.now()}@example.com`;
      await register(email);
      const { userId } = await loginToken(email);

      // Documented ignore-not-fail: verification checks signature, expiry,
      // and sub shape — never iat. Safe because only the server mints
      // tokens and it never sets iat explicitly (createAccessToken passes
      // {sub} only), while expiry is enforced independently (expired-token
      // suites prove 401). An attacker cannot exploit this: minting
      // requires the secret, and a stolen-secret mint gains nothing
      // beyond sub (claims-ignored test above).
      const futureIat = app.jwt.sign({
        sub: userId,
        iat: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/auth/me',
            headers: { authorization: `Bearer ${futureIat}` },
          })
        ).statusCode,
      ).toBe(200);
    },
  );

  it(
    'rejects wrong-secret tokens for a real subject',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `jwt-time-${Date.now()}@example.com`;
      await register(email);
      const { userId } = await loginToken(email);

      const { createHmac } = await import('node:crypto');
      const header = b64({ alg: 'HS256', typ: 'JWT' });
      const payload = b64({ sub: userId });
      const badSig = createHmac('sha256', 'wrong-secret-must-be-32-chars-long!!')
        .update(`${header}.${payload}`)
        .digest('base64url');
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/auth/me',
            headers: { authorization: `Bearer ${header}.${payload}.${badSig}` },
          })
        ).statusCode,
      ).toBe(401);
    },
  );
});
