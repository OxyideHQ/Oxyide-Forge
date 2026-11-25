import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('../../app/app.js');

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

async function registerAdmin(email: string): Promise<{ token: string; userId: string }> {
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  expect(reg.statusCode).toBe(201);
  const userId = (reg.json() as { id: string }).id;
  await prisma.user.update({ where: { id: userId }, data: { role: 'admin' } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  expect(login.statusCode).toBe(200);
  return { token: (login.json() as { accessToken: string }).accessToken, userId };
}

async function registerUser(email: string): Promise<{ token: string; userId: string }> {
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  expect(reg.statusCode).toBe(201);
  const userId = (reg.json() as { id: string }).id;
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  expect(login.statusCode).toBe(200);
  return { token: (login.json() as { accessToken: string }).accessToken, userId };
}

/**
 * M5.7 — ownership-override vectors not covered by M4 suites (live).
 *
 * M4 already proves: query-override on GET, alternate methods on reads,
 * body ownerId on PUT, stale credentials, JWT forgery. This suite pins
 * the remaining vectors: encoded/traversal IDs, body-`id` handling,
 * query override on DELETE, and the admin/user/self decision matrix on
 * writes. Identity always resolves server-side (AuthContext.sub + path
 * :id); nothing client-supplied overrides it.
 */
describe('ownership override vectors', () => {
  it(
    'rejects body-embedded id fields instead of honoring them',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      const a = await registerUser(`ovr-a-${stamp}@example.com`);
      const b = await registerUser(`ovr-b-${stamp}@example.com`);

      // Closed schemas (additionalProperties: false) reject unknown body
      // fields: an `id`/`ownerId`/`userId` in the body is a 400, never an
      // identity override.
      for (const body of [
        { displayName: 'X', id: b.userId },
        { displayName: 'X', ownerId: b.userId },
        { displayName: 'X', userId: b.userId },
      ]) {
        const response = await app.inject({
          method: 'PUT',
          url: `/api/v1/users/${a.userId}`,
          headers: { authorization: `Bearer ${a.token}` },
          payload: body,
        });
        expect(response.statusCode).toBe(400);
      }
      // Victim untouched.
      const victim = await prisma.user.findUnique({ where: { id: b.userId } });
      expect(victim!.displayName).toBeNull();
    },
  );

  it(
    'treats encoded and traversal-style IDs as opaque identifiers (no resolution bypass)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      const a = await registerUser(`enc-a-${stamp}@example.com`);
      await registerUser(`enc-b-${stamp}@example.com`);

      for (const encoded of [
        '..%2f..%2fetc%2fpasswd',
        '%2e%2e%2fapi%2fv1%2fusers%2fme',
        '..%252fapi',
        '%00',
        '+',
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/users/${encoded}`,
          headers: { authorization: `Bearer ${a.token}` },
        });
        // Never 200 for another principal and never a server error:
        // either 403 (policy denial) or 404 (no such user).
        expect([403, 404]).toContain(response.statusCode);
      }
    },
  );

  it(
    'ignores query identity overrides on DELETE and enforces the permission+policy chain',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      const admin = await registerAdmin(`del-admin-${stamp}@example.com`);
      const victim = await registerUser(`del-victim-${stamp}@example.com`);

      // Query override cannot redirect or authorize the delete: the path
      // :id and the policy decide. Admin deleting victim → 204.
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${victim.userId}?userId=${admin.userId}&ownerId=${admin.userId}`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(response.statusCode).toBe(204);
      expect(await prisma.user.findUnique({ where: { id: victim.userId } })).toBeNull();
    },
  );

  it(
    'holds the admin/user/self matrix on writes',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      const admin = await registerAdmin(`mx-admin-${stamp}@example.com`);
      const user = await registerUser(`mx-user-${stamp}@example.com`);
      const other = await registerUser(`mx-other-${stamp}@example.com`);

      // Self-update allowed.
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/v1/users/${user.userId}`,
            headers: { authorization: `Bearer ${user.token}` },
            payload: { displayName: 'Self' },
          })
        ).statusCode,
      ).toBe(200);
      // Cross-user update without permission denied.
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/v1/users/${other.userId}`,
            headers: { authorization: `Bearer ${user.token}` },
            payload: { displayName: 'Hacked' },
          })
        ).statusCode,
      ).toBe(403);
      // Admin override allowed.
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/v1/users/${other.userId}`,
            headers: { authorization: `Bearer ${admin.token}` },
            payload: { displayName: 'ByAdmin' },
          })
        ).statusCode,
      ).toBe(200);
      // Self-delete banned even for admins.
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/users/${admin.userId}`,
            headers: { authorization: `Bearer ${admin.token}` },
          })
        ).statusCode,
      ).toBe(403);
    },
  );
});
