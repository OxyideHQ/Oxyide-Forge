/**
 * M4.7 — Authorization Security Logging Integration Tests.
 *
 * Proves end-to-end against real PostgreSQL with a capturing Pino stream:
 * exact security events per decision, exactly-once emission, privileged
 * allows, deleted-subject boundary events, request correlation, and —
 * critically — that bearer tokens, cookies, passwords, and sentinel secrets
 * never appear in any captured log output.
 *
 * Requires a running PostgreSQL instance at DATABASE_URL. Fails fast when
 * the database is unavailable.
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

const { buildApp } = await import('../../app/app.js');

let baseApp: FastifyInstance;
let app: FastifyInstance;
let dbAvailable = false;
let captured: string[] = [];

const STRONG_PASSWORD = 'StrongPassword123!';

const TOKEN_SENTINEL = 'TEST_BEARER_LOGGING_SENTINEL_Z9Q7';
const PASSWORD_SENTINEL = 'TEST_PASSWORD_LOGGING_SENTINEL_X4K2';

function uniqueEmail(label: string): string {
  return `authzlog-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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

async function loginToken(email: string, password = STRONG_PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { accessToken: string }).accessToken;
}

function authed(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Parsed security events (authorization.decision / authentication.*) only. */
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

function expectNoSecrets(lines: string[], extra: string[] = []): void {
  const blob = lines.join('\n');
  for (const secret of [TOKEN_SENTINEL, PASSWORD_SENTINEL, ...extra]) {
    expect(blob).not.toContain(secret);
  }
  expect(blob).not.toContain('authorization","value');
  expect(blob).not.toContain('passwordHash');
  expect(blob).not.toContain('DATABASE_URL');
  expect(blob).not.toContain('JWT_SECRET');
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

  // Full application for fixture setup (registration/login), then a
  // capturing instance with identical wiring for the observed requests.
  baseApp = await buildApp();
  await baseApp.ready();

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
  await baseApp?.close();
  await prisma.$disconnect();
});

async function registerViaBase(email: string, password = STRONG_PASSWORD): Promise<string> {
  const response = await baseApp.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

describe('authorization security logging — denials (live)', () => {
  it(
    'logs exactly one ownership denial for cross-user read with correlation',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idB = await registerViaBase(emailB);
      await registerViaBase(emailA);
      const tokenA = await loginToken(emailA);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${idB}`,
        headers: authed(tokenA),
      });
      expect(response.statusCode).toBe(403);

      const events = securityEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'authorization.decision',
        decision: 'deny',
        reason: 'ownership_denied',
        permission: 'users:read',
        resource: 'user',
        targetId: idB,
      });
      expect(typeof events[0].subjectId).toBe('string');
      expect(typeof events[0].reqId).toBe('string');
      expect(typeof events[0].time).toBe('number');
      expect(events[0].level).toBe(40);
    },
  );

  it(
    'logs cross-user update and delete denials with safe fields',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idB = await registerViaBase(emailB);
      await registerViaBase(emailA);
      const tokenA = await loginToken(emailA);

      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/v1/users/${idB}`,
            headers: authed(tokenA),
            payload: { displayName: 'Pwned' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/users/${idB}`,
            headers: authed(tokenA),
          })
        ).statusCode,
      ).toBe(403);

      const events = securityEvents();
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        decision: 'deny',
        reason: 'ownership_denied',
        permission: 'users:update',
        targetId: idB,
      });
      // DELETE is guard-denied first (non-admin lacks users:delete), and the
      // guard has no target context — so no targetId key exists at all.
      expect(events[1]).toMatchObject({
        decision: 'deny',
        reason: 'permission_denied',
        permission: 'users:delete',
      });
      expect('targetId' in (events[1] as Record<string, unknown>)).toBe(false);
    },
  );

  it(
    'logs self-delete with its stable reason exactly once',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const adminId = await registerViaBase(adminEmail);
      await prisma.user.update({ where: { id: adminId }, data: { role: 'admin' } });
      const adminToken = await loginToken(adminEmail);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${adminId}`,
        headers: authed(adminToken),
      });
      expect(response.statusCode).toBe(403);

      const events = securityEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        decision: 'deny',
        reason: 'self_delete_forbidden',
        permission: 'users:delete',
        targetId: adminId,
      });
    },
  );

  it(
    'logs permission denials on role routes without duplicating',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('user');
      await registerViaBase(email);
      const token = await loginToken(email);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authed(token),
      });
      expect(response.statusCode).toBe(403);

      const events = securityEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        decision: 'deny',
        reason: 'permission_denied',
        permission: 'roles:read',
        resource: 'role',
      });
    },
  );

  it(
    'logs deleted-subject attempts once under the authentication-boundary event',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const ghostEmail = uniqueEmail('ghost');
      const ghostId = await registerViaBase(ghostEmail);
      const ghostToken = await loginToken(ghostEmail);
      await prisma.refreshToken.deleteMany({ where: { session: { userId: ghostId } } });
      await prisma.session.deleteMany({ where: { userId: ghostId } });
      await prisma.credential.deleteMany({ where: { userId: ghostId } });
      await prisma.emailVerificationToken.deleteMany({ where: { userId: ghostId } });
      await prisma.user.delete({ where: { id: ghostId } });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authed(ghostToken),
      });
      expect(response.statusCode).toBe(401);

      const events = securityEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'authentication.subject_invalid',
        decision: 'deny',
        reason: 'subject_invalid',
        subjectId: ghostId,
      });
    },
  );

  it(
    'emits no security event for expired tokens (authentication telemetry boundary)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const crypto = await import('node:crypto');
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'user-1',
          iat: Math.floor(Date.now() / 1000) - 7200,
          exp: Math.floor(Date.now() / 1000) - 3600,
        }),
      ).toString('base64url');
      const signature = crypto
        .createHmac('sha256', 'test-jwt-secret-key-min-32-chars-long')
        .update(`${header}.${payload}`)
        .digest('base64url');

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: { authorization: `Bearer ${header}.${payload}.${signature}` },
      });
      expect(response.statusCode).toBe(401);
      expect(securityEvents()).toHaveLength(0);
    },
  );
});

describe('authorization security logging — privileged allows (live)', () => {
  it(
    'logs admin cross-user read/update/delete allows and stays silent on self-read',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const victimEmail = uniqueEmail('victim');
      const adminId = await registerViaBase(adminEmail);
      const victimId = await registerViaBase(victimEmail);
      await prisma.user.update({ where: { id: adminId }, data: { role: 'admin' } });
      const adminToken = await loginToken(adminEmail);

      for (const [method, url, payload] of [
        ['GET', `/api/v1/users/${victimId}`, undefined],
        ['PUT', `/api/v1/users/${victimId}`, { displayName: 'Audited' }],
      ] as const) {
        const response = await app.inject({ method, url, headers: authed(adminToken), payload });
        expect(response.statusCode).toBe(200);
      }
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${victimId}`,
        headers: authed(adminToken),
      });
      expect(deleted.statusCode).toBe(204);

      // Self-read stays silent.
      const self = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${adminId}`,
        headers: authed(adminToken),
      });
      expect(self.statusCode).toBe(200);

      const events = securityEvents();
      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({
        decision: 'allow',
        reason: 'permission_override',
        permission: 'users:read',
        targetId: victimId,
      });
      expect(events[0].level).toBe(30);
      expect(events[1]).toMatchObject({
        decision: 'allow',
        reason: 'permission_override',
        permission: 'users:update',
        targetId: victimId,
      });
      expect(events[2]).toMatchObject({
        decision: 'allow',
        reason: 'permission_override',
        permission: 'users:delete',
        targetId: victimId,
      });
    },
  );
});

describe('authorization security logging — privacy (live)', () => {
  it(
    'never leaks tokens, cookies, passwords, or sentinels in any captured output',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idB = await registerViaBase(emailB, `${PASSWORD_SENTINEL}-strong-12!!`);
      await registerViaBase(emailA, `${PASSWORD_SENTINEL}-strong-12!!`);
      const tokenA = await loginToken(emailA, `${PASSWORD_SENTINEL}-strong-12!!`);

      // Requests carrying a bearer token, cookies, and sentinel passwords,
      // across denied and allowed paths.
      await app.inject({
        method: 'GET',
        url: `/api/v1/users/${idB}`,
        headers: { authorization: `Bearer ${TOKEN_SENTINEL}.${tokenA}`, cookie: 'accessToken=TEST_COOKIE_SENTINEL_Q1W2' },
      });
      await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${idB}`,
        headers: authed(tokenA),
        payload: { displayName: PASSWORD_SENTINEL },
      });

      expectNoSecrets(captured, [tokenA, 'TEST_COOKIE_SENTINEL_Q1W2']);
      // Every security event carries only the allowlisted scalar fields.
      for (const event of securityEvents()) {
        expect(Object.keys(event).every((key) => typeof event[key] !== 'object')).toBe(true);
      }
    },
  );
});
