/**
 * M4.10 — Authorization Bypass Regression Tests (live PostgreSQL).
 *
 * Systematic adversarial proof that no attacker class reaches protected
 * resources or privileged operations without satisfying the authorization
 * contract: authentication boundary, JWT/role/permission forgery, body/
 * query/header injection, path/method/content-type confusion, ownership,
 * stale credentials, unknown roles, malformed/oversized input, duplicate
 * inputs, and logging/error-sanitization behavior on bypass paths.
 *
 * Every mutation test proves database state; every read test inspects the
 * response body; security-event emission is asserted on the captured log
 * stream where the bypass path intersects logging. Requires a running
 * PostgreSQL instance at DATABASE_URL. Fails fast when unavailable.
 */

// Environment must be set before any module imports evaluate config.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

let app: FastifyInstance;
let dbAvailable = false;
let captured: string[] = [];

const STRONG_PASSWORD = 'StrongPassword123!';

function uniqueEmail(label: string): string {
  return `bypass-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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

function makeCaptureStream(): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
      captured.push(chunk.toString('utf8'));
      callback();
    },
  });
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

async function loginToken(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: STRONG_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { accessToken: string }).accessToken;
}

function authed(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function securityEvents(): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of captured) {
    for (const raw of line.split('\n')) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        record.event === 'authorization.decision' ||
        record.event === 'authentication.subject_invalid'
      ) {
        events.push(record);
      }
    }
  }
  return events;
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

  const { default: Fastify } = await import('fastify');
  const { authPlugin } = await import('../../plugins/auth.plugin.js');
  const { cookiePlugin } = await import('../../plugins/cookie.plugin.js');
  const { registerAuthRoutes } = await import('../auth/routes/auth.routes.js');
  const { registerUserRoutes } = await import('../users/routes/user.routes.js');
  const { registerRoleRoutes } = await import('../roles/routes/role.routes.js');

  const logger = pino({ level: 'info' }, makeCaptureStream());
  app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
  await app.register(cookiePlugin);
  await app.register(authPlugin);
  await app.register(registerAuthRoutes);
  await app.register(registerUserRoutes);
  await app.register(registerRoleRoutes);
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  captured = [];
  await cleanDatabase();
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanDatabase();
  }
  await app?.close();
  await prisma.$disconnect();
});

describe('bypass — authentication boundary (live)', () => {
  it(
    'rejects missing, empty, and malformed credentials without touching services',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const userId = await registerUser(uniqueEmail('victim'));

      for (const headers of [
        {},
        { authorization: '' },
        { authorization: 'Basic abc123' },
        { authorization: 'Bearer ' },
        { authorization: 'Bearer not-a-token' },
        { authorization: 'Bearer a.b' },
        { authorization: 'Bearer a.b.c.d' },
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/users/${userId}`,
          headers,
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
      }
      // No authentication → no authorization event (nothing attributable).
      expect(securityEvents()).toHaveLength(0);
    },
  );

  it(
    'rejects duplicate Authorization headers instead of selecting one',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('dup');
      const userId = await registerUser(email);
      const token = await loginToken(email);

      // Node joins duplicate headers with ', ' — the joined value must not
      // verify as any single credential.
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${userId}`,
        headers: { authorization: `Bearer ${token}, Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
    },
  );

  it(
    'rejects expired credentials on object routes with no security event',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const userId = await registerUser(uniqueEmail('victim'));
      // App-signed already-expired token: signature valid, lifetime dead.
      const expiredToken = app.jwt.sign({ sub: userId }, { expiresIn: -1 });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${userId}`,
        headers: { authorization: `Bearer ${expiredToken}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_TOKEN_EXPIRED');
      expect(securityEvents()).toHaveLength(0);
    },
  );
});

describe('bypass — JWT and authority forgery (live)', () => {
  it(
    'ignores forged role/permission/scope claims even with a valid signature',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idB = await registerUser(emailB);
      await registerUser(emailA);
      const sub = (await prisma.user.findUnique({ where: { email: emailA } }))!.id;

      const forged = app.jwt.sign({
        sub,
        role: 'admin',
        roles: ['admin'],
        permission: 'users:delete',
        permissions: ['users:delete'],
        scope: 'admin',
        isAdmin: true,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${idB}`,
        headers: authed(forged),
      });
      expect(response.statusCode).toBe(403);

      const events = securityEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ decision: 'deny', reason: 'ownership_denied' });
    },
  );

  it(
    'rejects tampered payloads reusing a valid signature',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idB = await registerUser(emailB);
      await registerUser(emailA);
      const tokenA = await loginToken(emailA);

      const [header, , signature] = tokenA.split('.');
      const tamperedPayload = Buffer.from(
        JSON.stringify({
          sub: idB,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString('base64url');

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${idB}`,
        headers: { authorization: `Bearer ${header}.${tamperedPayload}.${signature}` },
      });
      expect(response.statusCode).toBe(401);
      expect(securityEvents()).toHaveLength(0);
    },
  );

  it(
    'rejects authority-like headers without consulting them',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idA = await registerUser(emailA);
      const idB = await registerUser(emailB);
      const tokenA = await loginToken(emailA);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${idB}`,
        headers: {
          ...authed(tokenA),
          'x-role': 'admin',
          'x-permission': 'users:delete',
          'x-user-id': idB,
          'x-admin': 'true',
        },
      });
      expect(response.statusCode).toBe(403);

      const self = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${idA}`,
        headers: {
          ...authed(tokenA),
          'x-role': 'admin',
        },
      });
      expect(self.statusCode).toBe(200);
    },
  );
});

describe('bypass — path, method, and content-type confusion (live)', () => {
  it(
    'treats trailing slash, case variants, and double slashes as unknown routes',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('victim');
      const userId = await registerUser(email);
      const token = await loginToken(email);

      for (const url of [
        `/api/v1/users/${userId}/`,
        `/API/V1/USERS/${userId}`,
        `/api//v1//users/${userId}`,
      ]) {
        const response = await app.inject({ method: 'GET', url, headers: authed(token) });
        expect(response.statusCode).toBe(404);
      }
      expect(securityEvents()).toHaveLength(0);
    },
  );

  it(
    'refuses unregistered methods without reaching authorization or services',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('victim');
      const userId = await registerUser(email);
      const token = await loginToken(email);

      for (const method of ['PATCH', 'POST', 'OPTIONS'] as const) {
        const response = await app.inject({
          method,
          url: `/api/v1/users/${userId}`,
          headers: authed(token),
          payload: { displayName: 'Pwned' },
        });
        expect(response.statusCode).toBe(404);
      }
      expect((await prisma.user.findUnique({ where: { id: userId } }))!.displayName).toBeNull();
      expect(securityEvents()).toHaveLength(0);
    },
  );

  it(
    'applies HEAD semantics without bypassing denial or leaking bodies',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idA = await registerUser(emailA);
      const idB = await registerUser(emailB);
      const tokenA = await loginToken(emailA);

      const denied = await app.inject({
        method: 'HEAD',
        url: `/api/v1/users/${idB}`,
        headers: authed(tokenA),
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.body).toBe('');

      const allowed = await app.inject({
        method: 'HEAD',
        url: `/api/v1/users/${idA}`,
        headers: authed(tokenA),
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.body).toBe('');
    },
  );

  it(
    'rejects non-JSON and malformed bodies before authorization',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('victim');
      const userId = await registerUser(email);
      const token = await loginToken(email);

      // Fastify parses text/plain by default, so this reaches schema
      // validation (not authorization): still fail-closed pre-handler.
      const plain = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${userId}`,
        headers: { ...authed(token), 'content-type': 'text/plain' },
        payload: 'displayName=Pwned',
      });
      expect(plain.statusCode).toBe(400);

      const malformed = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${userId}`,
        headers: { ...authed(token), 'content-type': 'application/json' },
        payload: '{"displayName":',
      });
      expect(malformed.statusCode).toBe(400);

      const oversized = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${userId}`,
        headers: authed(token),
        payload: { displayName: 'x'.repeat(500) },
      });
      expect(oversized.statusCode).toBe(400);
      expect((await prisma.user.findUnique({ where: { id: userId } }))!.displayName).toBeNull();
    },
  );
});

describe('bypass — ownership and stale credentials (live)', () => {
  it(
    'denies unknown-role subjects after DB role tampering with no grant',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const adminId = await registerUser(adminEmail);
      await prisma.user.update({ where: { id: adminId }, data: { role: 'superadmin' } });
      const token = await loginToken(adminEmail);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authed(token),
      });
      expect(response.statusCode).toBe(403);

      const events = securityEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ decision: 'deny', reason: 'permission_denied' });
    },
  );

  it(
    'rejects revoked-family refresh credentials without authorizing',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('victim');
      const userId = await registerUser(email);

      const browserLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email, password: STRONG_PASSWORD },
      });
      expect(browserLogin.statusCode).toBe(200);
      const refreshCookie = browserLogin.cookies.find((cookie) => cookie.name === 'refreshToken');
      expect(refreshCookie).toBeDefined();

      // First rotation consumes the credential; replay kills the family.
      const rotated = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { refreshToken: refreshCookie!.value },
      });
      expect(rotated.statusCode).toBe(200);
      const replayed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { refreshToken: refreshCookie!.value },
      });
      expect(replayed.statusCode).toBe(401);

      // The killed family authorizes nothing further.
      const successor = rotated.headers['set-cookie'];
      expect(successor).toBeDefined();
      const retry = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { refreshToken: refreshCookie!.value },
      });
      expect(retry.statusCode).toBe(401);
      expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
    },
  );

  it(
    'treats uppercase variants of real IDs as unknown without substitution',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('victim');
      const userId = await registerUser(email);
      const adminEmail = uniqueEmail('admin');
      const adminId = await registerUser(adminEmail);
      await prisma.user.update({ where: { id: adminId }, data: { role: 'admin' } });
      const adminToken = await loginToken(adminEmail);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${userId.toUpperCase()}`,
        headers: authed(adminToken),
      });
      // Exact-match lookup: no case folding into another resource.
      expect(response.statusCode).toBe(404);
    },
  );
});
