import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
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
function errorLines(): string[] {
  return captured.filter((line) => line.includes('"level":50'));
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

/**
 * M6.7 — error logging policy proofs (live application pipeline).
 *
 * Expected client errors produce NO error-level logs; unexpected failures
 * produce EXACTLY ONE authoritative error log with the response's reqId;
 * security events keep controlled levels with fixed schemas. See
 * docs/error-handling.md (Error Logging Policy).
 */
describe('expected errors stay out of error logs', () => {
  it(
    '400/401/404/409 produce zero error-level lines',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `logpol-${Date.now()}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct-horse-battery-staple' },
      });

      const probes = [
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email: 'not-an-email', password: 'short' },
        }),
        app.inject({ method: 'GET', url: '/api/v1/auth/me' }),
        app.inject({ method: 'GET', url: '/no-such-logpol-route' }),
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email, password: 'correct-horse-battery-staple' },
        }),
      ];
      for (const response of await Promise.all(probes)) {
        expect([400, 401, 404, 409]).toContain(response.statusCode);
      }
      expect(errorLines()).toHaveLength(0);
    },
  );

  it(
    '429 throttle rejections produce zero error-level lines',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `logpol429-${Date.now()}@example.com`;
      for (let i = 0; i < 6; i += 1) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/password-reset/request',
          payload: { email },
        });
      }
      expect(errorLines()).toHaveLength(0);
    },
  );

  it(
    '403 denials emit the warn decision event (not an error log) with reqId',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      for (const who of ['logpol-a', 'logpol-b']) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email: `${who}-${stamp}@example.com`, password: 'correct-horse-battery-staple' },
        });
      }
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: `logpol-a-${stamp}@example.com`, password: 'correct-horse-battery-staple' },
      });
      const token = (login.json() as { accessToken: string }).accessToken;
      const target = await prisma.user.findUnique({
        where: { email: `logpol-b-${stamp}@example.com` },
      });
      captured.length = 0;

      const denied = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${target!.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(denied.statusCode).toBe(403);
      const header = denied.headers['x-request-id'] as string;

      expect(errorLines()).toHaveLength(0);
      const decision = captured.find((line) => line.includes('authorization.decision'));
      expect(decision).toBeDefined();
      expect(decision).toContain(`"reqId":"${header}"`);
      expect(decision).toContain('"decision":"deny"');
    },
  );
});

describe('exactly-one error log for unexpected failures', () => {
  it(
    'hostile thrown error: one error line, reqId-correlated, secret-free',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const hostile = Object.assign(new Error('db exploded'), {
        password: 'hunter2',
        config: { jwtSecret: 'shh' },
        cause: { token: 'tok' },
      });

      // Light app sharing the REAL global handler + pipeline (unit scope
      // for the throw; the handler/serializer path is production code).
      const { registerGlobalErrorHandler } = await import('./app.js');
      const Fastify = (await import('fastify')).default;
      const { createLoggerOptions } = await import('../shared/logging/logger-options.js');
      const { requestIdPlugin } = await import('../plugins/request-id.plugin.js');
      const light = Fastify({ logger: { ...createLoggerOptions('info'), stream: captureStream } });
      registerGlobalErrorHandler(light);
      await light.register(requestIdPlugin);
      light.get('/throw-hostile', async () => {
        throw hostile;
      });
      await light.ready();
      captured.length = 0;

      try {
        const response = await light.inject({ method: 'GET', url: '/throw-hostile' });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
        const header = response.headers['x-request-id'] as string;

        const errors = errorLines();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(`"reqId":"${header}"`);
        expect(errors[0]).toContain('Unhandled server error');
        expect(errors[0]).not.toContain('hunter2');
        expect(errors[0]).not.toContain('shh');
      } finally {
        await light.close();
      }
    },
  );

  it(
    'Prisma P2024-style failure: sanitized response, single correlated error log',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const { registerGlobalErrorHandler } = await import('./app.js');
      const Fastify = (await import('fastify')).default;
      const { createLoggerOptions } = await import('../shared/logging/logger-options.js');
      const { requestIdPlugin } = await import('../plugins/request-id.plugin.js');
      const light = Fastify({ logger: { ...createLoggerOptions('info'), stream: captureStream } });
      registerGlobalErrorHandler(light);
      await light.register(requestIdPlugin);
      light.get('/throw-p2024', async () => {
        throw new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection', {
          code: 'P2024',
          clientVersion: '6.12.0',
          meta: { connectionString: 'postgresql://u:p@h/db', poolTimeout: 10 },
        });
      });
      await light.ready();
      captured.length = 0;

      try {
        const response = await light.inject({ method: 'GET', url: '/throw-p2024' });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
        expect(JSON.stringify(response.json())).not.toContain('postgresql://');
        const header = response.headers['x-request-id'] as string;

        const errors = errorLines();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(`"reqId":"${header}"`);
        // Operators CAN distinguish via the logged code; clients cannot.
        expect(errors[0]).toContain('P2024');
      } finally {
        await light.close();
      }
    },
  );
});

describe('event-field injection safety', () => {
  it(
    'hostile path identifier in a deny event stays in-field with fixed keys',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      const email = `loginj-${stamp}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      const token = (login.json() as { accessToken: string }).accessToken;
      captured.length = 0;

      // %0A decodes inside the path param and flows into the deny event's
      // targetId: must remain one JSON line, inside its field.
      const hostileId = `abc%0AFAKE-${stamp}`;
      const denied = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${hostileId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect([403, 404]).toContain(denied.statusCode);

      const decisionLines = captured.filter((line) => line.includes('authorization.decision'));
      for (const line of decisionLines) {
        expect(line.trim().split('\n')).toHaveLength(1);
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(Object.keys(parsed).sort()).toEqual(
          ['decision', 'event', 'level', 'msg', 'permission', 'reason', 'reqId', 'resource', 'subjectId', 'targetId', 'time'].sort(),
        );
      }
      expect(errorLines()).toHaveLength(0);
    },
  );
});

describe('concurrent error correlation', () => {
  it(
    'parallel 404s each correlate independently with no shared IDs',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      captured.length = 0;
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => app.inject({ method: 'GET', url: `/missing-${i}` })),
      );
      expect(results.every((r) => r.statusCode === 404)).toBe(true);
      const ids = results.map((r) => r.headers['x-request-id'] as string);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(logs()).toContain(`"reqId":"${id}"`);
      }
      expect(errorLines()).toHaveLength(0);
    },
  );
});
