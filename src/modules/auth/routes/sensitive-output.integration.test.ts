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
const { usersService } = await import('../../users/users.service.js');

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

/** Values that must never appear in the inspected output. */
const FORBIDDEN = [
  'passwordHash',
  // JSON-key form: the English word "credentials" legitimately appears in
  // the generic 401 detail prose, so only a serialized FIELD is a leak.
  '"credential"',
  'tokenHash',
  'JWT_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  '$2b$',
  'replace-with-at-least-32-characters',
];

function expectNoLeak(serialized: string, plaintextPassword: string): void {
  for (const marker of FORBIDDEN) {
    expect(serialized).not.toContain(marker);
  }
  expect(serialized).not.toContain(plaintextPassword);
}

const PUBLIC_USER_KEYS = [
  'createdAt',
  'displayName',
  'email',
  'id',
  'role',
  'status',
  'updatedAt',
].sort();

/**
 * M5.5 — sensitive-output protection (live).
 *
 * Sweeps every security-sensitive endpoint for accidental leakage of
 * passwords, hashes, tokens, credentials, and connection secrets, and
 * pins exact public response shapes so new fields cannot slip out
 * unnoticed. Intentional credential deliveries (access token in JSON for
 * non-browser clients, HttpOnly cookies) are asserted as the ONLY token
 * crossings, each with its documented transport.
 */
describe('sensitive output boundaries', () => {
  it(
    'registration returns exactly the public user shape with no leakage',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const password = 'correct-horse-battery-staple';
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: `sweep-reg-${Date.now()}@example.com`, password },
      });

      expect(response.statusCode).toBe(201);
      expect(Object.keys(response.json()).sort()).toEqual(PUBLIC_USER_KEYS);
      expectNoLeak(JSON.stringify(response.json()), password);
    },
  );

  it(
    'non-browser login returns only {accessToken} with no leakage',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `sweep-login-${Date.now()}@example.com`;
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

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password },
      });

      expect(response.statusCode).toBe(200);
      // Documented token crossing: access token in JSON for non-browser
      // clients is the ONLY credential in this body.
      expect(Object.keys(response.json())).toEqual(['accessToken']);
      const serialized = JSON.stringify(response.json());
      expectNoLeak(serialized, password);
      expect(serialized).not.toContain('refreshToken');

      // The access token decodes to exactly {sub, iat, exp} — no password,
      // hash, email, or role smuggled into claims.
      const [, payloadB64] = (response.json() as { accessToken: string }).accessToken.split('.');
      const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'sub']);
    },
  );

  it(
    'browser login returns the public user with cookies carrying no password material',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `sweep-cookie-${Date.now()}@example.com`;
      const password = 'correct-horse-battery-staple';
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email, password },
      });

      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json()).sort()).toEqual(PUBLIC_USER_KEYS);
      expectNoLeak(JSON.stringify(response.json()), password);
      const setCookie = JSON.stringify(response.headers['set-cookie'] ?? '');
      expectNoLeak(setCookie, password);
      expect(setCookie).not.toContain('refreshToken=undefined');
    },
  );

  it(
    'authenticated user reads return exactly the public shape',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `sweep-me-${Date.now()}@example.com`;
      const password = 'correct-horse-battery-staple';
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password },
      });
      const token = (
        await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } })
      ).json().accessToken as string;
      const userId = (app.jwt.decode(token) as { sub: string }).sub;

      for (const url of ['/api/v1/auth/me', `/api/v1/users/${userId}`]) {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
        expect(Object.keys(response.json()).sort()).toEqual(PUBLIC_USER_KEYS);
        expectNoLeak(JSON.stringify(response.json()), password);
      }
    },
  );

  it(
    'repository user reads never carry credential material at runtime',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `sweep-repo-${Date.now()}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct-horse-battery-staple' },
      });

      // Hostile-shape proof: even with a live credential row present, the
      // generic user reads expose no hash material. `lockedUntil` IS present
      // here by design — it is internal lockout state consumed by the
      // throttle service, and the exact-keys tests above prove it never
      // crosses the HTTP boundary (toPublicUser excludes it).
      for (const row of [
        await usersService.findByEmail(email),
        await usersService.findById(
          (await usersService.findByEmail(email))!.id,
        ),
      ]) {
        expect(row).not.toBeNull();
        const serialized = JSON.stringify(row);
        expect(serialized).not.toContain('passwordHash');
        expect(serialized).not.toContain('tokenHash');
        expect(serialized).not.toContain('$2b$');
        expect(serialized).not.toContain('"credential"');
      }
    },
  );

  it(
    'error bodies never echo passwords, tokens, or connection secrets',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const password = 'correct-horse-battery-staple';

      // 409: existing email, no password echo.
      const email = `sweep-err-${Date.now()}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password },
      });
      const conflict = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password },
      });
      expect(conflict.statusCode).toBe(409);
      expectNoLeak(JSON.stringify(conflict.json()), password);

      // 400 policy rejection: names the bound, never the value.
      const over = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: `over-${Date.now()}@example.com`, password: 'é'.repeat(37) },
      });
      expect(over.statusCode).toBe(400);
      expect(over.json().code).toBe('AUTH_INVALID_PASSWORD');
      expect(JSON.stringify(over.json())).not.toContain('é'.repeat(37));

      // 401/404: no credential or existence material.
      const unauth = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      expect(unauth.statusCode).toBe(401);
      expectNoLeak(JSON.stringify(unauth.json()), password);
    },
  );
});
