/**
 * /metrics endpoint tests (M14.3) — METRICS_ENABLED=true. The disabled case
 * lives in metrics.disabled.test.ts (config is an import-time singleton, so the
 * flag must differ per module registry / test file).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
// Enable the exporter for this file before config is imported (dynamic import).
process.env.METRICS_ENABLED = 'true';

const { buildApp } = await import('../app/app.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ loggerStream: { write: () => true } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /metrics (METRICS_ENABLED=true)', () => {
  it('responds 200 with the Prometheus text content type and the metric families', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('version=0.0.4');
    expect(res.body).toContain('# TYPE forge_http_requests_total counter');
    expect(res.body).toContain('# TYPE forge_http_request_duration_seconds histogram');
  });

  it('records completed requests with bounded labels and no raw path/params', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    // A parameterised route: the label must be the ROUTE TEMPLATE, never the id.
    await app.inject({ method: 'GET', url: `/api/v1/users/${id}` }); // -> 401 (unauthenticated)
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    // Route template label, not the raw id or the raw path.
    expect(res.body).toContain('route="/api/v1/users/:id"');
    expect(res.body).not.toContain(id);
    expect(res.body).not.toContain('/api/v1/users/11111111');
    // No sensitive dimensions exist on the endpoint.
    expect(res.body).not.toContain('email');
    expect(res.body).not.toContain('password');
    expect(res.body).not.toContain('token');
  });

  it('does not leak the /metrics route into the public OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(JSON.stringify(res.json())).not.toContain('/metrics');
  });
});
