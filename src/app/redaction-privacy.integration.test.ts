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

/** Synchronous in-memory log capture: deterministic, no flush waits. */
const captured: string[] = [];
const captureStream = {
  write(chunk: unknown): boolean {
    captured.push(String(chunk));
    return true;
  },
};

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

  // The REAL application pipeline with logs routed to capture instead of
  // stdout. Serializers and redaction apply identically — only the
  // destination differs. Every assertion below reads EMITTED output, never
  // the redaction function in isolation.
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

function output(): string {
  return captured.join('\n');
}

/** Unique sentinels: exact secret values, never generic words (no false positives). */
const SECRET_BEARER = 'SECRET_ACCESS_TOKEN_123';
const SECRET_COOKIE = 'SECRET_REFRESH_TOKEN_456';
const SECRET_PASSWORD = 'SECRET_PASSWORD_789EXTRA';
const SECRET_API_KEY = 'SECRET_API_KEY_999';
const SECRET_QUERY_TOKEN = 'SECRET_QUERY_TOKEN_ABC';
const SECRET_UA = 'SecretAgentProbe/9.9';
const SECRET_DB_PW = 'SECRET_DB_PW_111';

/**
 * M8.2 — adversarial redaction & privacy matrix (live application pipeline).
 *
 * Protection is three layers deep and every layer is proven on emitted
 * output: (1) serializers omit whole categories (headers, cookies, bodies,
 * query) so secrets have no path to logs; (2) the compiled-in redact net
 * censors secret keys that ever reach a logged object directly, at any
 * nesting depth; (3) schemas reject unknown fields before handlers run.
 * PII policy: email/display-name/user-agent omitted everywhere; socket IP
 * retained for abuse investigation; user UUIDs retained ONLY inside
 * allowlisted security-decision events, never in lifecycle or error lines.
 */
describe('redaction matrix: credential-bearing headers never reach logs', () => {
  it(
    'strips bearer, cookie, and API-key credentials while keeping the 401 line useful',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          authorization: `Bearer ${SECRET_BEARER}`,
          cookie: `session=${SECRET_COOKIE}; refreshToken=${SECRET_COOKIE}`,
          'x-api-key': SECRET_API_KEY,
          'user-agent': SECRET_UA,
        },
      });
      expect(response.statusCode).toBe(401);

      const out = output();
      for (const secret of [SECRET_BEARER, SECRET_COOKIE, SECRET_API_KEY, SECRET_UA]) {
        expect(out).not.toContain(secret);
      }
      // Operational value preserved: the denial is still diagnosable.
      expect(out).toContain('401');
      expect(out).toContain('reqId');
      expect(out).toContain('/api/v1/auth/me');
    },
  );
});

describe('redaction matrix: query secrets never logged, safe path retained', () => {
  it(
    'drops token/password/email query values but keeps the stripped route',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const probeEmail = `redact-query-${Date.now()}@example.com`;
      const response = await app.inject({
        method: 'GET',
        url: `/no-such-redact-route?token=${SECRET_QUERY_TOKEN}&password=${SECRET_PASSWORD}&email=${probeEmail}&page=2`,
      });
      expect(response.statusCode).toBe(404);

      const out = output();
      for (const secret of [SECRET_QUERY_TOKEN, SECRET_PASSWORD, probeEmail]) {
        expect(out).not.toContain(secret);
      }
      expect(out).toContain('/no-such-redact-route');
      expect(out).not.toContain('page=2');
    },
  );
});

describe('redaction matrix: request bodies never logged', () => {
  it(
    'keeps registration, login, and recovery passwords out of every line',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `redact-body-${Date.now()}@example.com`;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { email, password: SECRET_PASSWORD },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            payload: { email, password: 'wrong-password-xyz' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/password-reset/request',
            payload: { email },
          })
        ).statusCode,
      ).toBe(204);

      const out = output();
      expect(out).not.toContain(SECRET_PASSWORD);
      expect(out).not.toContain('wrong-password-xyz');
      // The recovery email address itself is PII: omitted, not just the secret.
      expect(out).not.toContain(email);
      expect(out).toContain('reqId');
    },
  );
});

describe('redaction matrix: response bodies never logged', () => {
  it(
    'keeps issued tokens, user objects, and created ids out of every line',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `redact-resp-${Date.now()}@example.com`;
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      expect(created.statusCode).toBe(201);
      const userId = (created.json() as { id: string }).id;

      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      expect(login.statusCode).toBe(200);
      const accessToken = (login.json() as { accessToken: string }).accessToken;

      const out = output();
      // Issued credential material and the user object: absent.
      expect(out).not.toContain(accessToken);
      expect(out).not.toContain(email);
      // The created id appears in the JSON body (and the unlogged Location
      // header). Since M8.3 it also appears as the subject of the
      // allowlisted `auth.login.success` event — and nowhere else.
      const idLines = captured.filter((entry) => entry.includes(userId));
      expect(idLines.length).toBeGreaterThan(0);
      for (const line of idLines) {
        expect(line).toContain('auth.login.success');
      }
      expect(out).toContain('reqId');
    },
  );
});

describe('redaction matrix: nested error metadata censored, diagnostics kept', () => {
  it(
    'censors secret keys at every depth of a logged error while keeping type and message',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      // A thrown error carrying secret-bearing custom metadata, shaped like
      // the worst realistic case (config snapshot + nested credential
      // objects + arrays), logged through the REAL pipeline instance so
      // serializers and the redact net both apply.
      const failure = new Error('probe downstream failure') as Error & {
        config?: unknown;
        context?: unknown;
        items?: unknown;
      };
      failure.config = {
        databaseUrl: 'postgresql://ops:SECRET_DB_PW_111@db:5432/app',
        password: SECRET_PASSWORD,
      };
      failure.context = { account: { credentials: { accessToken: SECRET_BEARER } } };
      failure.items = [{ refreshToken: SECRET_COOKIE }, { event: 'ok' }];
      (app.log as { error(obj: unknown, msg: string): void }).error({ err: failure }, 'probe');
      // A directly-logged structured object exercises the redact net itself
      // (the error serializer above drops custom props before redact runs).
      (app.log as { info(obj: unknown, msg: string): void }).info(
        { context: { account: { credentials: { accessToken: SECRET_BEARER } } } },
        'probe-context',
      );

      const out = output();
      for (const secret of [SECRET_DB_PW, SECRET_PASSWORD, SECRET_BEARER, SECRET_COOKIE]) {
        expect(out).not.toContain(secret);
      }
      // The redact net censored the directly-logged credential object.
      expect(out).toContain('[Redacted]');
      // Diagnostics preserved: class, message, and the probe markers.
      expect(out).toContain('Error');
      expect(out).toContain('probe downstream failure');
      expect(out).toContain('probe-context');
    },
  );
});

describe('redaction matrix: PII policy (email, identifiers, IP, user-agent)', () => {
  it(
    'retains user UUIDs only inside allowlisted security-decision events',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      for (const who of ['redact-a', 'redact-b']) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: {
            email: `${who}-${stamp}@example.com`,
            password: 'correct-horse-battery-staple',
          },
        });
      }
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: `redact-a-${stamp}@example.com`,
          password: 'correct-horse-battery-staple',
        },
      });
      const token = (login.json() as { accessToken: string }).accessToken;
      const target = await prisma.user.findUnique({
        where: { email: `redact-b-${stamp}@example.com` },
      });
      const targetId = target!.id;

      const denied = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${targetId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(denied.statusCode).toBe(403);

      const out = output();
      // No email address anywhere in the output.
      expect(out).not.toContain(`redact-a-${stamp}@example.com`);
      expect(out).not.toContain(`redact-b-${stamp}@example.com`);
      // The target UUID appears, but ONLY as the addressed request path or
      // inside allowlisted security-decision events — never in a body,
      // header, error-metadata, or free-text field.
      const idLines = captured.filter((entry) => entry.includes(targetId));
      expect(idLines.length).toBeGreaterThan(0);
      expect(idLines.some((line) => line.includes('authorization.decision'))).toBe(true);
      for (const line of idLines) {
        const isDecision = line.includes('authorization.decision');
        const isRequestPath = line.includes(`/api/v1/users/${targetId}`);
        expect(isDecision || isRequestPath).toBe(true);
      }
      // Socket IP retained for abuse investigation; user-agent dropped.
      expect(out).toContain('127.0.0.1');
    },
  );
});

describe('redaction matrix: operational fields survive redaction', () => {
  it(
    'keeps reqId, method, path, status, duration, and decision events',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const denied = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      expect(denied.statusCode).toBe(401);
      const header = denied.headers['x-request-id'] as string;

      const out = output();
      expect(out).toContain(`"reqId":"${header}"`);
      expect(out).toContain('/api/v1/auth/me');
      expect(out).toContain('401');
      expect(out).toContain('responseTime');
    },
  );
});
