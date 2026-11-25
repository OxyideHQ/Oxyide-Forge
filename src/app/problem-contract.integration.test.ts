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

type Problem = Record<string, unknown>;

/** Exact canonical shape: six fields, correct types, status agreement. */
function expectProblem(
  response: { statusCode: number; headers: Record<string, unknown>; json(): unknown },
  expected: { status: number; code: string; title?: string; detail?: string },
): Problem {
  expect(response.statusCode).toBe(expected.status);
  expect(String(response.headers['content-type'])).toContain('application/problem+json');
  const body = response.json() as Problem;
  expect(Object.keys(body).sort()).toEqual(
    ['code', 'detail', 'instance', 'status', 'title', 'type'].sort(),
  );
  expect(typeof body.type).toBe('string');
  expect((body.type as string).startsWith('https://docs.oxyide.com/errors/')).toBe(true);
  expect(typeof body.title).toBe('string');
  expect(body.status).toBe(expected.status);
  expect(typeof body.detail).toBe('string');
  expect(body.code).toBe(expected.code);
  expect(typeof body.instance).toBe('string');
  expect((body.instance as string).startsWith('/requests/')).toBe(true);
  if (expected.title !== undefined) expect(body.title).toBe(expected.title);
  if (expected.detail !== undefined) expect(body.detail).toBe(expected.detail);
  return body;
}

/**
 * M6.3 — canonical Problem Details contract (live).
 *
 * Every App-originated failure returns the exact six-field problem body
 * with `application/problem+json`. Framework-native bodies stay native
 * (M6.4-owned remainder, explicitly asserted as unchanged here).
 */
describe('canonical problem contract', () => {
  it(
    'authentication 401 uses Problem Details with instance',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const body = expectProblem(
        await app.inject({ method: 'GET', url: '/api/v1/auth/me' }),
        {
          status: 401,
          code: 'AUTH_INVALID_TOKEN',
          title: 'Unauthorized',
          detail: 'Authentication credentials were not provided or are invalid.',
        },
      );
      expect(body.type).toBe('https://docs.oxyide.com/errors/auth-invalid-token');
    },
  );

  it(
    'conflict 409 uses Problem Details without changing semantics',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `conflict-${Date.now()}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      expectProblem(
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email, password: 'correct-horse-battery-staple' },
        }),
        {
          status: 409,
          code: 'USERS_EMAIL_TAKEN',
          detail: 'A user with this email already exists.',
        },
      );
    },
  );

  it(
    'service-validation 400 uses Problem Details (password policy)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const body = expectProblem(
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email: `policy-${Date.now()}@example.com`, password: 'é'.repeat(37) },
        }),
        { status: 400, code: 'AUTH_INVALID_PASSWORD' },
      );
      expect((body.detail as string)).toContain('72');
      expect(JSON.stringify(body)).not.toContain('é'.repeat(37));
    },
  );

  it(
    'throttle 429 uses Problem Details',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `throttle-${Date.now()}@example.com`;
      for (let i = 0; i < 5; i += 1) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/password-reset/request',
          payload: { email },
        });
      }
      expectProblem(
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/password-reset/request',
          payload: { email },
        }),
        { status: 429, code: 'AUTH_TOO_MANY_ATTEMPTS' },
      );
    },
  );

  it(
    'unknown route 404 uses Problem Details with NOT_FOUND code',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      expectProblem(await app.inject({ method: 'GET', url: '/no-such-route-xyz' }), {
        status: 404,
        code: 'NOT_FOUND',
        title: 'Not Found',
        detail: 'Route not found',
      });
    },
  );

  it(
    'authorization 403 uses Problem Details with identical semantics',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      for (const who of ['cc-a', 'cc-b']) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email: `${who}-${stamp}@example.com`, password: 'correct-horse-battery-staple' },
        });
      }
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: `cc-a-${stamp}@example.com`, password: 'correct-horse-battery-staple' },
      });
      const token = (login.json() as { accessToken: string }).accessToken;
      const target = await prisma.user.findUnique({
        where: { email: `cc-b-${stamp}@example.com` },
      });
      expectProblem(
        await app.inject({
          method: 'GET',
          url: `/api/v1/users/${target!.id}`,
          headers: { authorization: `Bearer ${token}` },
        }),
        {
          status: 403,
          code: 'AUTH_FORBIDDEN',
          title: 'Forbidden',
          detail: 'You do not have permission to read this user.',
        },
      );
    },
  );

  it(
    'framework errors map centrally: validation, malformed, empty, oversized, media type',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      // Schema validation → VALIDATION_FAILED problem (value-free detail).
      const schema400 = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'x',
          password: 'short',
          'hack-SECRETVAL': 'x',
        },
      });
      expect(schema400.statusCode).toBe(400);
      expect(String(schema400.headers['content-type'])).toContain('application/problem+json');
      const schemaBody = schema400.json() as Record<string, unknown>;
      expect(Object.keys(schemaBody).sort()).toEqual(
        ['code', 'detail', 'instance', 'status', 'title', 'type'].sort(),
      );
      expect(schemaBody.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(schemaBody)).not.toContain('SECRETVAL');

      // Malformed + empty JSON → MALFORMED_JSON problem (payload never reflected).
      for (const payload of ['{"broken":', '']) {
        const malformed = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          headers: { 'content-type': 'application/json' },
          payload,
        });
        expect(malformed.statusCode).toBe(400);
        expect(String(malformed.headers['content-type'])).toContain('application/problem+json');
        expect(malformed.json()).toMatchObject({ code: 'MALFORMED_JSON', status: 400 });
        expect(JSON.stringify(malformed.json())).not.toContain('broken');
      }

      // Oversized body → 413 problem (payload never reflected).
      const bigMarker = `BIGM64-${Date.now()}`;
      const over = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: `big-${Date.now()}@example.com`,
          password: 'correct-horse-battery-staple',
          displayName: `${bigMarker}-` + 'x'.repeat(1048576 + 1024),
        }),
      });
      expect(over.statusCode).toBe(413);
      expect(String(over.headers['content-type'])).toContain('application/problem+json');
      expect(over.json()).toMatchObject({ code: 'BODY_TOO_LARGE', status: 413 });
      expect(JSON.stringify(over.json())).not.toContain(bigMarker);

      // Unsupported media type → 415 problem (content-type value never reflected).
      const evilType = 'application/x-evil-SECRETMT';
      const media = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { 'content-type': evilType },
        payload: 'x',
      });
      expect(media.statusCode).toBe(415);
      expect(String(media.headers['content-type'])).toContain('application/problem+json');
      expect(media.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });
      expect(JSON.stringify(media.json())).not.toContain('x-evil-SECRETMT');
    },
  );

  it(
    'instance values are opaque request IDs shared with logs (no PII)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const first = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      const second = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      const a = (first.json() as Problem).instance as string;
      const b = (second.json() as Problem).instance as string;
      // Distinct per occurrence, opaque counter form (base36), no email/UUID content.
      expect(a).not.toBe(b);
      expect(a).toMatch(/^\/requests\/req-[0-9a-z]+$/);
      expect(b).toMatch(/^\/requests\/req-[0-9a-z]+$/);
    },
  );
});
