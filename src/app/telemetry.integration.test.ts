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
const { inMemoryMetrics } = await import('../shared/metrics/metrics.js');
const { noopMetrics } = await import('../shared/metrics/metrics.js');

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

function headerId(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['x-request-id'];
  expect(typeof value).toBe('string');
  return value as string;
}

const VALID_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/**
 * M8.4 — telemetry pipeline boundary (live application pipeline).
 *
 * The default application carries NoOp telemetry: requests behave
 * identically with or without a backend, the request ID stays canonical,
 * and completion lines keep their frozen M8.1 shape. With an in-memory
 * backend, exactly the bounded instrument set is recorded — method,
 * route template, and status only — and a throwing backend cannot break
 * a request.
 */
describe('telemetry pipeline boundary', () => {
  it(
    'runs normally with NoOp telemetry and keeps the request ID canonical',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      expect(app.telemetry?.metrics).toBe(noopMetrics);
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { traceparent: VALID_TRACEPARENT },
      });
      expect(response.statusCode).toBe(200);
      // Trace context is accepted ambiently; the M6 request ID is untouched.
      expect(headerId(response)).toMatch(/^req-[0-9a-z]+$/);
      // Frozen M8.1 completion shape: no traceId key added.
      const completed = captured
        .map((entry) => {
          try {
            return JSON.parse(entry) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter(
          (parsed): parsed is Record<string, unknown> =>
            parsed !== null && parsed['msg'] === 'request completed',
        );
      expect(completed).toHaveLength(1);
      expect(completed[0]['traceId']).toBeUndefined();
      expect(completed[0]['traceparent']).toBeUndefined();
      expect(completed[0]['reqId']).toBe(headerId(response));
    },
  );

  it(
    'records bounded instruments end to end with an in-memory backend',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const { metrics, snapshot } = inMemoryMetrics();
      const scoped = await buildApp({ loggerStream: captureStream, metrics });
      await scoped.ready();
      try {
        const email = `telemetry-${Date.now()}@example.com`;
        const created = await scoped.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email, password: 'correct-horse-battery-staple' },
        });
        expect(created.statusCode).toBe(201);
        const denied = await scoped.inject({ method: 'GET', url: '/api/v1/auth/me' });
        expect(denied.statusCode).toBe(401);

        const counters = snapshot().counters;
        const requests = counters['http.requests.total'];
        expect(requests).toContainEqual({
          labels: { method: 'POST', route: '/api/v1/auth/register', status: '201' },
          value: 1,
        });
        expect(requests).toContainEqual({
          labels: { method: 'GET', route: '/api/v1/auth/me', status: '401' },
          value: 1,
        });
        // Cardinality: only the three declared label names, everywhere.
        for (const sample of requests) {
          expect(Object.keys(sample.labels).sort()).toEqual(['method', 'route', 'status']);
        }
        // No PII, identity, or request data in any label value.
        const flat = JSON.stringify(requests);
        expect(flat).not.toContain(email);
        expect(flat).not.toContain('req-');
        expect(flat).not.toContain('@');
        const durations = snapshot().histograms['http.request.duration.seconds'];
        expect(durations.length).toBeGreaterThanOrEqual(2);
        for (const series of durations) {
          expect(Object.keys(series.labels).sort()).toEqual(['method', 'route']);
          expect(series.count).toBeGreaterThanOrEqual(1);
          expect(series.sum).toBeGreaterThan(0);
        }
      } finally {
        await scoped.close();
      }
    },
  );

  it(
    'buckets unmatched URLs without recording raw paths',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const { metrics, snapshot } = inMemoryMetrics();
      const scoped = await buildApp({ loggerStream: captureStream, metrics });
      await scoped.ready();
      try {
        const missing = await scoped.inject({
          method: 'GET',
          url: '/no-such-telemetry-route?token=SECRET',
        });
        expect(missing.statusCode).toBe(404);
        const requests = snapshot().counters['http.requests.total'];
        expect(requests).toContainEqual({
          labels: { method: 'GET', route: 'unknown', status: '404' },
          value: 1,
        });
        expect(JSON.stringify(requests)).not.toContain('no-such-telemetry-route');
        expect(JSON.stringify(requests)).not.toContain('SECRET');
      } finally {
        await scoped.close();
      }
    },
  );

  it(
    'a throwing metrics backend cannot fail, delay, or alter a request',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const throwing = {
        httpRequestsTotal: {
          increment: (): void => {
            throw new Error('backend down');
          },
        },
        httpRequestDurationSeconds: {
          observe: (): void => {
            throw new Error('backend down');
          },
        },
        httpErrorsTotal: {
          increment: (): void => {
            throw new Error('backend down');
          },
        },
      };
      const scoped = await buildApp({ loggerStream: captureStream, metrics: throwing });
      await scoped.ready();
      try {
        const health = await scoped.inject({ method: 'GET', url: '/health/live' });
        expect(health.statusCode).toBe(200);
        expect(headerId(health)).toMatch(/^req-[0-9a-z]+$/);
        const denied = await scoped.inject({ method: 'GET', url: '/api/v1/auth/me' });
        expect(denied.statusCode).toBe(401);
        expect(denied.json()).toMatchObject({ code: 'AUTH_INVALID_TOKEN', status: 401 });
      } finally {
        await scoped.close();
      }
    },
  );
});
