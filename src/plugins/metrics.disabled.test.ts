/**
 * /metrics is absent when METRICS_ENABLED is not set (M14.3). Config is an
 * import-time singleton, so the disabled case runs in its own file (the enabled
 * case is in metrics.plugin.test.ts). Safe-by-default behavior: no route, no
 * data collection, 404.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
delete process.env.METRICS_ENABLED; // default -> disabled

const { buildApp } = await import('../app/app.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ loggerStream: { write: () => true } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /metrics (METRICS_ENABLED unset/disabled)', () => {
  it('returns 404 — no metrics route is registered by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
  });
});
