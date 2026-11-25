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
  // stdout. Serializers and redaction apply identically.
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

type IncomingLine = {
  level: number;
  reqId: string;
  msg: string;
  req: { method: string; url: string; remoteAddress: string };
};

type CompletedLine = {
  level: number;
  reqId: string;
  msg: string;
  responseTime: number;
  res: { statusCode: number };
};

function parsedLines(): Array<Record<string, unknown>> {
  return captured.flatMap((entry) => {
    try {
      return [JSON.parse(entry) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

function incomingFor(reqId: string): IncomingLine[] {
  return parsedLines().filter(
    (parsed): parsed is IncomingLine & Record<string, unknown> =>
      parsed['msg'] === 'incoming request' && parsed['reqId'] === reqId,
  );
}

function completedFor(reqId: string): CompletedLine[] {
  return parsedLines().filter(
    (parsed): parsed is CompletedLine & Record<string, unknown> =>
      parsed['msg'] === 'request completed' && parsed['reqId'] === reqId,
  );
}

/**
 * M8.1 — request lifecycle logging contract (live application pipeline).
 *
 * Fastify's `request completed` lines are an intentional operational signal
 * (`disableRequestLogging: false`, pinned in `src/app/app.ts`). Each line
 * carries exactly the safe structured shape — method, query-stripped path,
 * status, numeric duration, and the canonical request ID — and nothing
 * else. Bodies, headers, cookies, and query values never appear.
 */
describe('request completion log contract', () => {
  it(
    'emits a structured completion line per request: method, path, status, duration, reqId',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const response = await app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
      const header = response.headers['x-request-id'];
      expect(typeof header).toBe('string');

      const lines = completedFor(header as string);
      expect(lines).toHaveLength(1);
      const line = lines[0];
      expect(line.level).toBe(30);
      expect(typeof line.responseTime).toBe('number');
      expect(line.responseTime).toBeGreaterThanOrEqual(0);
      expect(line.res.statusCode).toBe(200);
      // Method and path live on the paired `incoming request` line.
      const opened = incomingFor(header as string);
      expect(opened).toHaveLength(1);
      expect(opened[0].req.method).toBe('GET');
      expect(opened[0].req.url).toBe('/health/live');
      expect(opened[0].req.remoteAddress).toBe('127.0.0.1');
    },
  );

  it(
    'captures the correct status per request: 201, 401, and 404 each logged distinctly',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `reqlog-${Date.now()}@example.com`;
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct-horse-battery-staple' },
      });
      expect(created.statusCode).toBe(201);
      const denied = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      expect(denied.statusCode).toBe(401);
      const missing = await app.inject({ method: 'GET', url: '/no-such-reqlog-route' });
      expect(missing.statusCode).toBe(404);

      for (const [response, status, url] of [
        [created, 201, '/api/v1/auth/register'],
        [denied, 401, '/api/v1/auth/me'],
        [missing, 404, '/no-such-reqlog-route'],
      ] as const) {
        const header = response.headers['x-request-id'] as string;
        const lines = completedFor(header);
        expect(lines).toHaveLength(1);
        expect(lines[0].res.statusCode).toBe(status);
        const opened = incomingFor(header);
        expect(opened).toHaveLength(1);
        expect(opened[0].req.url).toBe(url);
      }
    },
  );

  it(
    'strips query values on an endpoint that reads query, and never logs bodies or tokens',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `reqlog-q-${Date.now()}@example.com`;
      const password = 'correct-horse-battery-staple';
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password },
      });
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password },
      });
      const token = (login.json() as { accessToken: string }).accessToken;

      // Response-body-only marker: the created note id appears in the JSON
      // body (and the unlogged Location header), nowhere else.
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/notes',
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'request logging probe' },
      });
      expect(created.statusCode).toBe(201);
      const noteId = (created.json() as { id: string }).id;

      const listed = await app.inject({
        method: 'GET',
        url: '/api/v1/notes?filter[title_contains]=QSECRET9&limit=5',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(listed.statusCode).toBe(200);

      const out = captured.join('\n');
      // Query value, bearer token, password, and response-body id absent.
      for (const secret of ['QSECRET9', token, password, noteId]) {
        expect(out).not.toContain(secret);
      }
      // The completion line still records 200 with the stripped path.
      const header = listed.headers['x-request-id'] as string;
      const lines = completedFor(header);
      expect(lines).toHaveLength(1);
      expect(lines[0].res.statusCode).toBe(200);
      const opened = incomingFor(header);
      expect(opened).toHaveLength(1);
      expect(opened[0].req.url).toBe('/api/v1/notes');
    },
  );

  it(
    'correlates concurrent completion lines to their own responses, never crossed',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          i % 2 === 0
            ? app.inject({ method: 'GET', url: '/health/live' })
            : app.inject({ method: 'GET', url: '/no-such-reqlog-concurrent' }),
        ),
      );
      const ids = results.map((response) => response.headers['x-request-id'] as string);
      expect(new Set(ids).size).toBe(ids.length);
      for (const [index, id] of ids.entries()) {
        const lines = completedFor(id);
        expect(lines).toHaveLength(1);
        expect(lines[0].res.statusCode).toBe(index % 2 === 0 ? 200 : 404);
      }
    },
  );
});
