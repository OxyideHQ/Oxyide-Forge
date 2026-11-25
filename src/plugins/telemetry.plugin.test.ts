import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { telemetryPlugin } from './telemetry.plugin.js';
import { requestIdPlugin } from './request-id.plugin.js';
import { noopMetrics, type ForgeMetrics } from '../shared/metrics/metrics.js';
import { noopTracer } from '../shared/tracing/tracer.js';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

async function scratchApp(options: {
  tracer?: typeof noopTracer;
  metrics?: ForgeMetrics;
} = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(requestIdPlugin);
  await app.register(telemetryPlugin, options);
  // Test-only probe route: echoes the request-scoped trace context so the
  // hook behavior is observable. The trace ID is opaque correlation
  // metadata, safe to reflect in a test body.
  app.get('/probe', async (request, reply) => {
    return reply.status(200).send({ traceContext: request.traceContext ?? null });
  });
  await app.ready();
  return app;
}

/**
 * M8.4 — telemetry plugin boundary proofs on a scratch instance (no DB).
 *
 * The real plugin hooks run against probe routes: valid contexts attach,
 * everything hostile yields null, the request ID is untouched, and
 * concurrent requests never cross contexts.
 */
describe('telemetry plugin', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('decorates telemetry defaults and leaves traceContext null without a header', async () => {
    app = await scratchApp();
    expect(app.telemetry?.tracer).toBe(noopTracer);
    expect(app.telemetry?.metrics).toBe(noopMetrics);
    const response = await app.inject({ method: 'GET', url: '/probe' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ traceContext: null });
    expect(response.headers['x-request-id']).toMatch(/^req-[0-9a-z]+$/);
  });

  it('attaches a valid inbound context without touching the request ID', async () => {
    app = await scratchApp();
    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { traceparent: VALID },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      traceContext: {
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        sampled: true,
      },
    });
    // The canonical M6 request ID is independent and unchanged.
    expect(response.headers['x-request-id']).toMatch(/^req-[0-9a-z]+$/);
  });

  it('nulls malformed, hostile, and oversized contexts safely', async () => {
    app = await scratchApp();
    for (const traceparent of [
      'not-a-context',
      '00-xyz',
      `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\r\nX-Injected: yes`,
      `00-${'ab'.repeat(64)}-00f067aa0ba902b7-01`,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: '/probe',
        headers: { traceparent },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ traceContext: null });
    }
  });

  it('never crosses trace contexts between concurrent requests', async () => {
    app = await scratchApp();
    const other = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00';
    const [withTrace, withoutTrace] = await Promise.all([
      app.inject({ method: 'GET', url: '/probe', headers: { traceparent: VALID } }),
      app.inject({ method: 'GET', url: '/probe', headers: { traceparent: other } }),
    ]);
    expect(withTrace.json()).toEqual({
      traceContext: {
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        sampled: true,
      },
    });
    expect(withoutTrace.json()).toEqual({
      traceContext: {
        traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        spanId: 'bbbbbbbbbbbbbbbb',
        sampled: false,
      },
    });
    expect(withTrace.headers['x-request-id']).not.toBe(withoutTrace.headers['x-request-id']);
  });
});
