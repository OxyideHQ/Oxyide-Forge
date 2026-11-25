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
const { authService } = await import('../modules/auth/services/auth.service.js');

let app: FastifyInstance;
let dbAvailable = false;

const captured: string[] = [];
const captureStream = {
  write(chunk: unknown): boolean {
    captured.push(String(chunk));
    return true;
  },
};
function logs(): string {
  return captured.join('\n');
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

  app = await buildApp({ loggerStream: captureStream });
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  captured.length = 0;
  await cleanDatabase();
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanDatabase();
  }
  await app?.close();
  await prisma.$disconnect();
});

function cookiesOf(response: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const out: Record<string, string> = {};
  for (const entry of list) {
    const pair = entry.split(';')[0];
    const separator = pair.indexOf('=');
    out[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return out;
}

async function register(email: string, password = 'correct-horse-battery-staple') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password },
  });
  expect(response.statusCode).toBe(201);
  return response;
}

/**
 * M5.7 — cross-feature attack chains A–J (live).
 *
 * Each test composes individually-secure features into one hostile flow
 * and proves the composition stays safe end to end (responses + logs).
 * Covers M57-INV-007/008 and the chain legs of error/logging isolation.
 */
describe('cross-feature attack chains', () => {
  it(
    'chain A: register → login → refresh → revoke → replay fails closed',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `chain-a-${Date.now()}@example.com`;
      await register(email);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      expect(login.statusCode).toBe(200);
      const first = cookiesOf(login).refreshToken;

      const rotated = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: `refreshToken=${first}` },
      });
      expect(rotated.statusCode).toBe(200);

      const token = cookiesOf(login).accessToken;
      void token;
      const me = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      const bearer = (me.json() as { accessToken: string }).accessToken;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/sessions/revoke-all',
            headers: { authorization: `Bearer ${bearer}` },
          })
        ).statusCode,
      ).toBe(204);

      // Every credential from the chain is now dead.
      expect(
        (await app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          headers: { cookie: `refreshToken=${first}` },
        })).statusCode,
      ).toBe(401);
      expect(
        (await app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          headers: { cookie: `refreshToken=${cookiesOf(rotated).refreshToken}` },
        })).statusCode,
      ).toBe(401);
    },
  );

  it(
    'chain B: lockout → password reset → login recovers, old session stays dead',
    { timeout: 120000 },
    async () => {
      if (!dbAvailable) return;
      const email = `chain-b-${Date.now()}@example.com`;
      await register(email);

      // Establish a session, then lock the account with 5 failures.
      const firstLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      const oldRefresh = cookiesOf(firstLogin).refreshToken;
      for (let i = 0; i < 5; i += 1) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/auth/login',
              payload: { email, password: 'wrong-password-xyz' },
            })
          ).statusCode,
        ).toBe(401);
      }
      // Locked: correct password now 429.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            payload: { email, password: 'correct-horse-battery-staple' },
          })
        ).statusCode,
      ).toBe(429);

      // Authenticated recovery via reset.
      const sent: { resetUrl: string }[] = [];
      await authService.requestPasswordReset(email, '127.0.0.1', {
        sendPasswordResetEmail: async (message: { resetUrl: string }): Promise<void> => {
          sent.push(message);
        },
      });
      const token = sent[0].resetUrl.split('token=')[1];
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/password-reset/confirm',
            payload: { token, password: 'fresh-valid-password' },
          })
        ).statusCode,
      ).toBe(204);

      // New password works; pre-lockout session is dead (reset revokes all).
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            payload: { email, password: 'fresh-valid-password' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/refresh',
            headers: { cookie: `refreshToken=${oldRefresh}` },
          })
        ).statusCode,
      ).toBe(401);
    },
  );

  it(
    'chain C: reset revokes live refresh; replay after reset fails',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `chain-c-${Date.now()}@example.com`;
      await register(email);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      const liveRefresh = cookiesOf(login).refreshToken;
      expect((await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: `refreshToken=${liveRefresh}` },
      })).statusCode).toBe(200);

      const sent: { resetUrl: string }[] = [];
      await authService.requestPasswordReset(email, '127.0.0.1', {
        sendPasswordResetEmail: async (message: { resetUrl: string }): Promise<void> => {
          sent.push(message);
        },
      });
      const token = sent[0].resetUrl.split('token=')[1];
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token, password: 'another-fresh-password' },
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/refresh',
            headers: { cookie: `refreshToken=${liveRefresh}` },
          })
        ).statusCode,
      ).toBe(401);
    },
  );

  it(
    'chain D: deleted user with a live JWT is rejected on protected endpoints',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `chain-d-${Date.now()}@example.com`;
      await register(email);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      const bearer = (login.json() as { accessToken: string }).accessToken;
      const userId = (app.jwt.decode(bearer) as { sub: string }).sub;

      // FK-safe removal in dependency order (mirrors usersService.remove):
      // tokens → sessions → credential → user.
      await prisma.passwordResetToken.deleteMany({ where: { userId } });
      await prisma.emailVerificationToken.deleteMany({ where: { userId } });
      await prisma.refreshToken.deleteMany({ where: { session: { userId } } });
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.credential.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });

      for (const url of ['/api/v1/auth/me', `/api/v1/users/${userId}`]) {
        expect(
          (
            await app.inject({
              method: 'GET',
              url,
              headers: { authorization: `Bearer ${bearer}` },
            })
          ).statusCode,
        ).toBe(401);
      }
    },
  );

  it(
    'chain E: honest valid token cannot escalate to admin actions',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      await register(`chain-e-user-${stamp}@example.com`);
      await register(`chain-e-victim-${stamp}@example.com`);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: `chain-e-user-${stamp}@example.com`, password: 'correct-horse-battery-staple' },
      });
      const bearer = (login.json() as { accessToken: string }).accessToken;
      const victimId = (
        await prisma.user.findUnique({ where: { email: `chain-e-victim-${stamp}@example.com` } })
      )!.id;

      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/users/${victimId}`,
            headers: { authorization: `Bearer ${bearer}` },
          })
        ).statusCode,
      ).toBe(403);
      expect(await prisma.user.findUnique({ where: { id: victimId } })).not.toBeNull();
    },
  );

  it(
    'chain F: malicious body → 400 with secret-free response and logs',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      // Over-byte multibyte password: 43 chars (schema passes) but 75
      // bytes (policy 400). The secret marker must appear nowhere.
      const evilPassword = `${'é'.repeat(32)}SECRET-PW-F`;
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'chain-f@example.com', password: evilPassword },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.json())).not.toContain('SECRET-PW-F');
      expect(logs()).not.toContain('SECRET-PW-F');
      expect(logs()).toContain('incoming request');
    },
  );

  it(
    'chain G: malicious query → generic 404 with secret-free response and logs',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const response = await app.inject({
        method: 'GET',
        url: '/?token=SECRET-QRY-G&password=SECRET-QRY-G2',
      });
      expect(response.statusCode).toBe(404);
      expect(JSON.stringify(response.json())).not.toContain('SECRET-QRY-G');
      expect(logs()).not.toContain('SECRET-QRY-G');
      expect(logs()).not.toContain('SECRET-QRY-G2');
    },
  );

  it(
    'chain H: oversized inputs rejected with safe serialization and logs',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const big = `BIG-H-${Date.now()}`;
      const over = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: `h-${Date.now()}@example.com`,
          password: 'correct-horse-battery-staple',
          displayName: `${big}-` + 'x'.repeat(1048576 + 1024),
        }),
      });
      expect(over.statusCode).toBe(413);
      expect(JSON.stringify(over.json())).not.toContain(big);

      const long = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${'u'.repeat(200)}?token=BIG-H-QRY`,
      });
      expect(long.statusCode).toBe(414);
      expect(JSON.stringify(long.json())).not.toContain('BIG-H-QRY');
      expect(logs()).not.toContain(big);
      expect(logs()).not.toContain('BIG-H-QRY');
    },
  );

  it(
    'chain I: authorization denial → 403 with audit event present and secret-free',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      await register(`chain-i-a-${stamp}@example.com`);
      await register(`chain-i-b-${stamp}@example.com`);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: `chain-i-a-${stamp}@example.com`, password: 'correct-horse-battery-staple' },
      });
      const bearer = (login.json() as { accessToken: string }).accessToken;
      const targetId = (
        await prisma.user.findUnique({ where: { email: `chain-i-b-${stamp}@example.com` } })
      )!.id;

      const denied = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${targetId}`,
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe('AUTH_FORBIDDEN');

      const out = logs();
      expect(out).toContain('authorization.decision');
      expect(out).toContain('ownership_denied');
      expect(out).not.toContain('correct-horse-battery-staple');
    },
  );

  it(
    'chain J: framework error → sanitized response with safe err log shape',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      // Malformed JSON exercises Fastify's error path end to end.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: '{"email": "broken-chain-j@example.com", "password":',
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('stack');
      expect(JSON.stringify(body)).not.toContain('broken-chain-j');
      // The pipeline logged the failure with the allowlisted err shape.
      expect(logs()).toContain('reqId');
    },
  );
});
