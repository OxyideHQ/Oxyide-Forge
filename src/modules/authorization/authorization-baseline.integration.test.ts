/**
 * M4.1 — Authorization Baseline Adversarial Integration Tests.
 *
 * Proves the CURRENT authorization behavior end-to-end against real
 * PostgreSQL with real JWTs (no service/policy mocks): guard wiring,
 * self-vs-other ownership, admin allowance, deletion/status edge behavior,
 * forged-claim resistance, and unknown-role denial.
 *
 * Tests pin the baseline truthfully — including behaviors recorded as M4.1
 * findings (deleted-user 403 shape, suspended-JWT authorization). If a later
 * milestone changes those behaviors, these tests must change with it.
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

const { buildApp } = await import('../../app/app.js');

let app: FastifyInstance;
let dbAvailable = false;

const STRONG_PASSWORD = 'StrongPassword123!';

function uniqueEmail(label: string): string {
  return `authz-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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

async function loginToken(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: STRONG_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { accessToken: string }).accessToken;
}

async function makeAdmin(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { role: 'admin' } });
}

function authed(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/**
 * Runs a callback against a separately-built application instance and a
 * separately-connected Prisma client, then tears both down. Anything the
 * callback observes must therefore come from PostgreSQL — never from
 * in-memory state shared with the primary test stack.
 */
async function withFreshStack<T>(
  fn: (freshApp: FastifyInstance, freshPrisma: PrismaClient) => Promise<T>,
): Promise<T> {
  const freshPrisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  const freshApp = await buildApp();
  try {
    return await fn(freshApp, freshPrisma);
  } finally {
    await freshApp.close();
    await freshPrisma.$disconnect();
  }
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

afterAll(async () => {
  if (dbAvailable) {
    await cleanDatabase();
  }
  await app?.close();
  await prisma.$disconnect();
});

describe('BOLA / IDOR verification (M4.5, live)', () => {
  it(
    'denies reverse-direction substitution without leaking victim data',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idA = await registerUser(emailA);
      await registerUser(emailB);
      const tokenB = await loginToken(emailB);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${idA}`,
        headers: authed(tokenB),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('AUTH_FORBIDDEN');
      expect(response.body).not.toContain(emailA);
    },
  );

  it(
    'leaves both rows unchanged after a denied cross-user update (DB proof)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idA = await registerUser(emailA);
      const idB = await registerUser(emailB);
      const tokenA = await loginToken(emailA);

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${idB}`,
        headers: authed(tokenA),
        payload: { displayName: 'Pwned' },
      });
      expect(response.statusCode).toBe(403);

      const victim = await prisma.user.findUnique({ where: { id: idB } });
      const attacker = await prisma.user.findUnique({ where: { id: idA } });
      expect(victim!.displayName).toBeNull();
      expect(attacker!.displayName).toBeNull();
    },
  );

  it(
    'leaves the victim fully intact after a denied cross-user delete (DB proof)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      await registerUser(emailA);
      const idB = await registerUser(emailB);
      const tokenA = await loginToken(emailA);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${idB}`,
        headers: authed(tokenA),
      });
      expect(response.statusCode).toBe(403);

      expect(await prisma.user.findUnique({ where: { id: idB } })).not.toBeNull();
      expect(await prisma.credential.findUnique({ where: { userId: idB } })).not.toBeNull();
    },
  );

  it(
    'changes only the intended target on authorized admin update (DB proof)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const victimEmail = uniqueEmail('victim');
      const otherEmail = uniqueEmail('other');
      const adminId = await registerUser(adminEmail);
      const victimId = await registerUser(victimEmail);
      const otherId = await registerUser(otherEmail);
      await makeAdmin(adminId);
      const adminToken = await loginToken(adminEmail);

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${victimId}`,
        headers: authed(adminToken),
        payload: { displayName: 'Renamed' },
      });
      expect(response.statusCode).toBe(200);

      expect((await prisma.user.findUnique({ where: { id: victimId } }))!.displayName).toBe(
        'Renamed',
      );
      expect((await prisma.user.findUnique({ where: { id: otherId } }))!.displayName).toBeNull();
      expect((await prisma.user.findUnique({ where: { id: adminId } }))!.displayName).toBeNull();
    },
  );

  it(
    'removes only the intended target on authorized admin delete (DB proof)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const victimEmail = uniqueEmail('victim');
      const adminId = await registerUser(adminEmail);
      const victimId = await registerUser(victimEmail);
      await makeAdmin(adminId);
      const adminToken = await loginToken(adminEmail);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${victimId}`,
        headers: authed(adminToken),
      });
      expect(response.statusCode).toBe(204);

      expect(await prisma.user.findUnique({ where: { id: victimId } })).toBeNull();
      expect(await prisma.user.findUnique({ where: { id: adminId } })).not.toBeNull();
    },
  );

  it(
    'fails safely on malformed, whitespace, and oversized identifiers',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const userEmail = uniqueEmail('user');
      const adminId = await registerUser(adminEmail);
      await registerUser(userEmail);
      await makeAdmin(adminId);
      const adminToken = await loginToken(adminEmail);
      const userToken = await loginToken(userEmail);
      const longId = `u_${'a'.repeat(5000)}`;

      for (const target of ['not-a-uuid', '%20', 'user-123']) {
        const asAdmin = await app.inject({
          method: 'GET',
          url: `/api/v1/users/${target}`,
          headers: authed(adminToken),
        });
        expect(asAdmin.statusCode).toBe(404);

        const asUser = await app.inject({
          method: 'GET',
          url: `/api/v1/users/${target}`,
          headers: authed(userToken),
        });
        // Non-privileged callers cannot distinguish missing from forbidden.
        expect(asUser.statusCode).toBe(403);
      }

      // An oversized URI is rejected by the HTTP layer itself (414) before
      // any authentication or authorization runs — fail-closed, no leak.
      for (const token of [adminToken, userToken]) {
        const oversized = await app.inject({
          method: 'GET',
          url: `/api/v1/users/${longId}`,
          headers: authed(token),
        });
        expect(oversized.statusCode).toBe(414);
      }
    },
  );

  it(
    'ignores duplicate and conflicting query identity keys (live)',
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
        url: `/api/v1/users/${idA}?userId=${idB}&userId=${idA}&ownerId=${idB}`,
        headers: authed(tokenA),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().email).toBe(emailA);
    },
  );

  it(
    'exposes no alternate method path to user objects',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('method');
      const userId = await registerUser(email);
      const token = await loginToken(email);

      for (const method of ['PATCH', 'POST'] as const) {
        const response = await app.inject({
          method,
          url: `/api/v1/users/${userId}`,
          headers: authed(token),
          payload: { displayName: 'Pwned' },
        });
        expect(response.statusCode).toBe(404);
      }
      expect((await prisma.user.findUnique({ where: { id: userId } }))!.displayName).toBeNull();
    },
  );

  it(
    'reflects DB role changes on the very next request (no stale authority)',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idA = await registerUser(emailA);
      const idB = await registerUser(emailB);
      const tokenA = await loginToken(emailA);

      const denied = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${idB}`,
        headers: authed(tokenA),
      });
      expect(denied.statusCode).toBe(403);

      await prisma.user.update({ where: { id: idA }, data: { role: 'admin' } });
      const allowed = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${idB}`,
        headers: authed(tokenA),
      });
      expect(allowed.statusCode).toBe(200);

      await prisma.user.update({ where: { id: idA }, data: { role: 'user' } });
      const deniedAgain = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${idB}`,
        headers: authed(tokenA),
      });
      expect(deniedAgain.statusCode).toBe(403);
    },
  );

  it(
    'denies cross-user access identically on an independent instance',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idA = await registerUser(emailA);
      const idB = await registerUser(emailB);
      const tokenA = await loginToken(emailA);

      await withFreshStack(async (freshApp) => {
        const cross = await freshApp.inject({
          method: 'GET',
          url: `/api/v1/users/${idB}`,
          headers: authed(tokenA),
        });
        expect(cross.statusCode).toBe(403);

        const self = await freshApp.inject({
          method: 'GET',
          url: `/api/v1/users/${idA}`,
          headers: authed(tokenA),
        });
        expect(self.statusCode).toBe(200);
      });
    },
  );
});

describe('authorization baseline — ownership and roles (live)', () => {
  it(
    'rejects unauthenticated user reads with 401',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const userId = await registerUser(uniqueEmail('noauth'));

      const response = await app.inject({ method: 'GET', url: `/api/v1/users/${userId}` });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
    },
  );

  it(
    'allows self-read but denies cross-user read for non-admins (BOLA)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idA = await registerUser(emailA);
      const idB = await registerUser(emailB);
      const tokenA = await loginToken(emailA);

      const self = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${idA}`,
        headers: authed(tokenA),
      });
      expect(self.statusCode).toBe(200);
      expect(self.json().email).toBe(emailA);

      const cross = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${idB}`,
        headers: authed(tokenA),
      });
      expect(cross.statusCode).toBe(403);
      expect(cross.json().code).toBe('AUTH_FORBIDDEN');
    },
  );

  it(
    'allows admin reads and updates of other users',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const victimEmail = uniqueEmail('victim');
      const adminId = await registerUser(adminEmail);
      const victimId = await registerUser(victimEmail);
      await makeAdmin(adminId);
      const adminToken = await loginToken(adminEmail);

      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${victimId}`,
        headers: authed(adminToken),
      });
      expect(read.statusCode).toBe(200);

      const update = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${victimId}`,
        headers: authed(adminToken),
        payload: { displayName: 'Renamed' },
      });
      expect(update.statusCode).toBe(200);
      expect(update.json().displayName).toBe('Renamed');
    },
  );

  it(
    'denies non-admin cross-user update and self role/status escalation',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idA = await registerUser(emailA);
      const idB = await registerUser(emailB);
      const tokenA = await loginToken(emailA);

      const cross = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${idB}`,
        headers: authed(tokenA),
        payload: { displayName: 'Pwned' },
      });
      expect(cross.statusCode).toBe(403);

      // Status is silently dropped on self-update; role is not an accepted field.
      const selfStatus = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${idA}`,
        headers: authed(tokenA),
        payload: { status: 'suspended' },
      });
      expect(selfStatus.statusCode).toBe(200);
      expect(selfStatus.json().status).toBe('active');

      const selfRole = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${idA}`,
        headers: authed(tokenA),
        payload: { role: 'admin' },
      });
      expect(selfRole.statusCode).toBe(400);
      const after = await prisma.user.findUnique({ where: { id: idA } });
      expect(after!.role).toBe('user');
    },
  );

  it(
    'enforces delete rules: admin-only, never self, 404 for missing',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const userEmail = uniqueEmail('user');
      const adminId = await registerUser(adminEmail);
      const userId = await registerUser(userEmail);
      await makeAdmin(adminId);
      const adminToken = await loginToken(adminEmail);
      const userToken = await loginToken(userEmail);

      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/users/${adminId}`,
            headers: authed(userToken),
          })
        ).statusCode,
      ).toBe(403);

      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/users/${adminId}`,
            headers: authed(adminToken),
          })
        ).statusCode,
      ).toBe(403);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${userId}`,
        headers: authed(adminToken),
      });
      expect(deleted.statusCode).toBe(204);
      expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();

      const missing = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${userId}`,
        headers: authed(adminToken),
      });
      expect(missing.statusCode).toBe(404);
    },
  );

  it(
    'gates role listing on roles:read with the exact permission matrix',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const userEmail = uniqueEmail('user');
      const adminId = await registerUser(adminEmail);
      await registerUser(userEmail);
      await makeAdmin(adminId);

      const denied = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authed(await loginToken(userEmail)),
      });
      expect(denied.statusCode).toBe(403);

      const allowed = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authed(await loginToken(adminEmail)),
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual({
        roles: [
          {
            name: 'user',
            permissions: ['auth:login', 'auth:logout', 'users:read:self', 'users:update:self'],
          },
          {
            name: 'admin',
            permissions: [
              'auth:login',
              'auth:logout',
              'users:read',
              'users:read:self',
              'users:update',
              'users:update:self',
              'users:delete',
              'roles:read',
              'roles:create',
              'roles:update',
              'roles:delete',
            ],
          },
        ],
      });

      const unknown = await app.inject({
        method: 'GET',
        url: '/api/v1/roles/superuser',
        headers: authed(await loginToken(adminEmail)),
      });
      expect(unknown.statusCode).toBe(404);
    },
  );
});

describe('authorization baseline — identity edge behavior (live)', () => {
  it(
    'rejects deleted-subject JWTs with 401 on guard-protected routes (M4.6 F3 resolved)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const ghostEmail = uniqueEmail('ghost');
      const adminId = await registerUser(adminEmail);
      const ghostId = await registerUser(ghostEmail);
      await makeAdmin(adminId);
      const ghostToken = await loginToken(ghostEmail);

      // Ordered teardown honoring ON DELETE RESTRICT (credential, session
      // family, verification token, then the user row itself).
      await prisma.refreshToken.deleteMany({ where: { session: { userId: ghostId } } });
      await prisma.session.deleteMany({ where: { userId: ghostId } });
      await prisma.credential.deleteMany({ where: { userId: ghostId } });
      await prisma.emailVerificationToken.deleteMany({ where: { userId: ghostId } });
      await prisma.user.delete({ where: { id: ghostId } });

      // The JWT itself is still cryptographically valid, but authentication
      // now requires an existing subject: 401 coherently with `/me`, decided
      // in requireAuth before any guard, policy, or service runs.
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${adminId}`,
        headers: authed(ghostToken),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
    },
  );

  it(
    'ignores forged role claims in JWTs (server-side lookup wins)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('forged');
      const userId = await registerUser(email);
      void userId;

      const forged = app.jwt.sign({ sub: (await prisma.user.findUnique({ where: { email } }))!.id, role: 'admin' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authed(forged),
      });
      expect(response.statusCode).toBe(403);
    },
  );

  it(
    'denies unknown database roles (safe default)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('weird');
      const userId = await registerUser(email);
      await prisma.user.update({ where: { id: userId }, data: { role: 'superuser' } });
      const token = await loginToken(email);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authed(token),
      });
      expect(response.statusCode).toBe(403);
    },
  );

  it(
    'still authorizes suspended JWTs on guards (M4.1 status-gap finding)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const adminId = await registerUser(adminEmail);
      await makeAdmin(adminId);
      const adminToken = await loginToken(adminEmail);

      await prisma.user.update({ where: { id: adminId }, data: { status: 'suspended' } });

      // Guards consult role only, never status: a valid JWT keeps authorizing
      // admin reads for up to its 15-minute TTL after suspension. Recorded as
      // M4.1 finding (status-aware authorization); a later milestone that
      // changes this must update this test.
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authed(adminToken),
      });
      expect(response.statusCode).toBe(200);
    },
  );
});

describe('deleted subject failure matrix (M4.6, live)', () => {
  async function registerGhost(): Promise<{ ghostId: string; ghostToken: string }> {
    const ghostEmail = uniqueEmail('ghost');
    const ghostId = await registerUser(ghostEmail);
    const ghostToken = await loginToken(ghostEmail);
    await prisma.refreshToken.deleteMany({ where: { session: { userId: ghostId } } });
    await prisma.session.deleteMany({ where: { userId: ghostId } });
    await prisma.credential.deleteMany({ where: { userId: ghostId } });
    await prisma.emailVerificationToken.deleteMany({ where: { userId: ghostId } });
    await prisma.user.delete({ where: { id: ghostId } });
    expect(await prisma.user.findUnique({ where: { id: ghostId } })).toBeNull();
    return { ghostId, ghostToken };
  }

  it(
    'rejects deleted-subject updates with 401 and leaves the victim unchanged',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const victimEmail = uniqueEmail('victim');
      const victimId = await registerUser(victimEmail);
      const { ghostToken } = await registerGhost();

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${victimId}`,
        headers: authed(ghostToken),
        payload: { displayName: 'Pwned' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_TOKEN');

      expect((await prisma.user.findUnique({ where: { id: victimId } }))!.displayName).toBeNull();
    },
  );

  it(
    'rejects deleted-subject deletes with 401 and leaves the victim existing',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const victimEmail = uniqueEmail('victim');
      const victimId = await registerUser(victimEmail);
      const { ghostToken } = await registerGhost();

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${victimId}`,
        headers: authed(ghostToken),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_TOKEN');

      expect(await prisma.user.findUnique({ where: { id: victimId } })).not.toBeNull();
    },
  );

  it(
    'rejects deleted-subject privileged actions with 401 (no stale authority)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const { ghostToken } = await registerGhost();

      const roles = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authed(ghostToken),
      });
      expect(roles.statusCode).toBe(401);

      const revokeAll = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
        headers: authed(ghostToken),
      });
      expect(revokeAll.statusCode).toBe(401);
    },
  );
});

