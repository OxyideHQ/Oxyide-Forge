/**
 * M4.11 — Authorization Concurrency Verification (live PostgreSQL).
 *
 * Proves authorization-relevant interleavings have no false-allow,
 * cross-contamination, or resurrection outcome: concurrent update/delete
 * same-target races, delete/delete, update/update last-writer bounds,
 * bidirectional cross-user attacks, read-vs-delete disappearance, context
 * isolation across parallel identities, and concurrent denial-logging
 * identity integrity. Every mutation test asserts database state, not just
 * HTTP statuses. Fail-fast on missing database.
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
  return `race-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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

function authed(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
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

describe('authorization concurrency — same-target mutation races (live)', () => {
  it(
    'converges concurrent admin update + delete with no 500 and no orphans',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const victimEmail = uniqueEmail('victim');
      const bystanderEmail = uniqueEmail('bystander');
      const adminId = await registerUser(adminEmail);
      const victimId = await registerUser(victimEmail);
      const bystanderId = await registerUser(bystanderEmail);
      await prisma.user.update({ where: { id: adminId }, data: { role: 'admin' } });
      const adminToken = await loginToken(adminEmail);

      const [updateRes, deleteRes] = await Promise.all([
        app.inject({
          method: 'PUT',
          url: `/api/v1/users/${victimId}`,
          headers: authed(adminToken),
          payload: { displayName: 'Raced' },
        }),
        app.inject({
          method: 'DELETE',
          url: `/api/v1/users/${victimId}`,
          headers: authed(adminToken),
        }),
      ]);

      // Either order is legitimate; only these outcomes are coherent.
      expect(deleteRes.statusCode).toBe(204);
      expect([200, 404]).toContain(updateRes.statusCode);

      // Final state: target fully gone (row + credential + sessions), never
      // partial; bystander untouched.
      expect(await prisma.user.findUnique({ where: { id: victimId } })).toBeNull();
      expect(await prisma.credential.findUnique({ where: { userId: victimId } })).toBeNull();
      expect(await prisma.session.findMany({ where: { userId: victimId } })).toHaveLength(0);
      expect(await prisma.user.findUnique({ where: { id: bystanderId } })).not.toBeNull();
      expect(await prisma.user.findUnique({ where: { id: adminId } })).not.toBeNull();
    },
  );

  it(
    'converges concurrent deletes with one winner and no duplicate effects',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const victimEmail = uniqueEmail('victim');
      const adminId = await registerUser(adminEmail);
      const victimId = await registerUser(victimEmail);
      await prisma.user.update({ where: { id: adminId }, data: { role: 'admin' } });
      const adminToken = await loginToken(adminEmail);

      const results = await Promise.all([
        app.inject({
          method: 'DELETE',
          url: `/api/v1/users/${victimId}`,
          headers: authed(adminToken),
        }),
        app.inject({
          method: 'DELETE',
          url: `/api/v1/users/${victimId}`,
          headers: authed(adminToken),
        }),
      ]);
      const codes = results.map((response) => response.statusCode).sort();
      expect(codes).toEqual([204, 404]);

      expect(await prisma.user.findUnique({ where: { id: victimId } })).toBeNull();
      expect(await prisma.credential.findUnique({ where: { userId: victimId } })).toBeNull();
    },
  );

  it(
    'bounds concurrent authorized updates to the target with no cross-user effects',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const victimEmail = uniqueEmail('victim');
      const otherEmail = uniqueEmail('other');
      const adminId = await registerUser(adminEmail);
      const victimId = await registerUser(victimEmail);
      const otherId = await registerUser(otherEmail);
      await prisma.user.update({ where: { id: adminId }, data: { role: 'admin' } });
      const adminToken = await loginToken(adminEmail);

      const results = await Promise.all([
        app.inject({
          method: 'PUT',
          url: `/api/v1/users/${victimId}`,
          headers: authed(adminToken),
          payload: { displayName: 'Winner-A' },
        }),
        app.inject({
          method: 'PUT',
          url: `/api/v1/users/${victimId}`,
          headers: authed(adminToken),
          payload: { displayName: 'Winner-B' },
        }),
      ]);
      for (const response of results) {
        expect(response.statusCode).toBe(200);
      }

      // Last writer wins is the documented non-security semantic; the value
      // is one of the two writes, and no other row changed.
      const victim = await prisma.user.findUnique({ where: { id: victimId } });
      expect(['Winner-A', 'Winner-B']).toContain(victim!.displayName);
      expect((await prisma.user.findUnique({ where: { id: otherId } }))!.displayName).toBeNull();
      expect((await prisma.user.findUnique({ where: { id: adminId } }))!.displayName).toBeNull();
    },
  );

  it(
    'keeps admin read coherent when the target disappears mid-flight',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const victimEmail = uniqueEmail('victim');
      const adminId = await registerUser(adminEmail);
      const victimId = await registerUser(victimEmail);
      await prisma.user.update({ where: { id: adminId }, data: { role: 'admin' } });
      const adminToken = await loginToken(adminEmail);

      const [readRes, deleteRes] = await Promise.all([
        app.inject({
          method: 'GET',
          url: `/api/v1/users/${victimId}`,
          headers: authed(adminToken),
        }),
        app.inject({
          method: 'DELETE',
          url: `/api/v1/users/${victimId}`,
          headers: authed(adminToken),
        }),
      ]);

      expect(deleteRes.statusCode).toBe(204);
      // Read either observed the row or raced its deletion — both coherent.
      expect([200, 404]).toContain(readRes.statusCode);
      if (readRes.statusCode === 200) {
        expect(readRes.json().id).toBe(victimId);
      }
      expect(await prisma.user.findUnique({ where: { id: victimId } })).toBeNull();
    },
  );
});

describe('authorization concurrency — cross-request isolation (live)', () => {
  it(
    'denies bidirectional simultaneous cross-user attacks with rows unchanged',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const idA = await registerUser(emailA);
      const idB = await registerUser(emailB);
      const tokenA = await loginToken(emailA);
      const tokenB = await loginToken(emailB);

      const [aToB, bToA] = await Promise.all([
        app.inject({
          method: 'PUT',
          url: `/api/v1/users/${idB}`,
          headers: authed(tokenA),
          payload: { displayName: 'Pwned-by-A' },
        }),
        app.inject({
          method: 'PUT',
          url: `/api/v1/users/${idA}`,
          headers: authed(tokenB),
          payload: { displayName: 'Pwned-by-B' },
        }),
      ]);
      expect(aToB.statusCode).toBe(403);
      expect(bToA.statusCode).toBe(403);

      expect((await prisma.user.findUnique({ where: { id: idA } }))!.displayName).toBeNull();
      expect((await prisma.user.findUnique({ where: { id: idB } }))!.displayName).toBeNull();
    },
  );

  it(
    'never swaps AuthContext between parallel identities',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const adminEmail = uniqueEmail('admin');
      const emailA = uniqueEmail('a');
      const emailB = uniqueEmail('b');
      const adminId = await registerUser(adminEmail);
      const idA = await registerUser(emailA);
      const idB = await registerUser(emailB);
      await prisma.user.update({ where: { id: adminId }, data: { role: 'admin' } });
      const [adminToken, tokenA, tokenB] = await Promise.all([
        loginToken(adminEmail),
        loginToken(emailA),
        loginToken(emailB),
      ]);

      const [adminView, aView, bView] = await Promise.all([
        app.inject({ method: 'GET', url: `/api/v1/users/${idA}`, headers: authed(adminToken) }),
        app.inject({ method: 'GET', url: `/api/v1/users/${idA}`, headers: authed(tokenA) }),
        app.inject({ method: 'GET', url: `/api/v1/users/${idB}`, headers: authed(tokenB) }),
      ]);

      expect(adminView.statusCode).toBe(200);
      expect(adminView.json().email).toBe(emailA);
      expect(aView.statusCode).toBe(200);
      expect(aView.json().email).toBe(emailA);
      expect(bView.statusCode).toBe(200);
      expect(bView.json().email).toBe(emailB);
    },
  );

  it(
    'keeps concurrent denial logs identity-correct per request',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const emails = [uniqueEmail('a'), uniqueEmail('b'), uniqueEmail('c'), uniqueEmail('d')];
      const ids: string[] = [];
      for (const email of emails) {
        ids.push(await registerUser(email));
      }
      const tokens = await Promise.all(emails.map((email) => loginToken(email)));

      // Capturing instance with identical wiring (M4.7 pattern): proves each
      // concurrent denial emits exactly one event carrying its own subject,
      // target, and request ID — never a mixture.
      const captured: string[] = [];
      const { default: Fastify } = await import('fastify');
      const { default: pino } = await import('pino');
      const { Writable } = await import('node:stream');
      const { authPlugin } = await import('../../plugins/auth.plugin.js');
      const { registerUserRoutes } = await import('../users/routes/user.routes.js');
      const stream = new Writable({
        write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
          captured.push(chunk.toString('utf8'));
          callback();
        },
      });
      const captureApp = Fastify({
        loggerInstance: pino({ level: 'info' }, stream) as never,
      });
      await captureApp.register(authPlugin);
      await captureApp.register(registerUserRoutes);
      await captureApp.ready();
      try {
        const responses = await Promise.all(
          tokens.map((token, index) =>
            captureApp.inject({
              method: 'GET',
              url: `/api/v1/users/${ids[(index + 1) % ids.length]}`,
              headers: { authorization: `Bearer ${token}` },
            }),
          ),
        );
        for (const response of responses) {
          expect(response.statusCode).toBe(403);
        }

        const events: Array<Record<string, unknown>> = [];
        for (const line of captured.join('\n').split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          const record = JSON.parse(trimmed) as Record<string, unknown>;
          if (record.event === 'authorization.decision') {
            events.push(record);
          }
        }
        expect(events).toHaveLength(4);
        const reqIds = new Set<unknown>();
        const expectedTarget = new Map(ids.map((id, index) => [id, ids[(index + 1) % ids.length]]));
        for (const event of events) {
          // Subject→target pairing holds regardless of completion order.
          expect(event).toMatchObject({
            decision: 'deny',
            reason: 'ownership_denied',
            targetId: expectedTarget.get(event.subjectId as string),
          });
          reqIds.add(event.reqId);
        }
        // Subject IDs are a permutation of the four actors (order across
        // concurrent requests is not contractual; identity correctness is).
        const subjects = events.map((event) => event.subjectId).sort();
        expect(subjects).toEqual([...ids].sort());
        expect(reqIds.size).toBe(4);
      } finally {
        await captureApp.close();
      }
    },
  );
});
