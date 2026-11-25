import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { securityHeadersPlugin } = await import('./security-headers.plugin.js');

const EXPECTED_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=()',
};

describe('securityHeadersPlugin', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(securityHeadersPlugin);

    app.get('/test/ok', async () => ({ ok: true }));
    app.post('/test/created', async (_request, reply) => reply.status(201).send({ ok: true }));
    app.get('/test/empty', async (_request, reply) => reply.status(204).send());
    app.get('/test/fail', async () => {
      throw new Error('boom');
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function expectHeaders(response: { statusCode: number; headers: Record<string, unknown> }): void {
    for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
      expect(response.headers[name]).toBe(value);
    }
  }

  it('emits the exact header set on 200 responses', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/ok' });
    expect(response.statusCode).toBe(200);
    expectHeaders(response);
  });

  it('emits headers on 201 and 204 responses', async () => {
    const created = await app.inject({ method: 'POST', url: '/test/created' });
    expect(created.statusCode).toBe(201);
    expectHeaders(created);

    const empty = await app.inject({ method: 'GET', url: '/test/empty' });
    expect(empty.statusCode).toBe(204);
    expectHeaders(empty);
  });

  it('emits headers on framework 400 and 404 responses', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/test/created',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken":',
    });
    expect(malformed.statusCode).toBe(400);
    expectHeaders(malformed);

    const missing = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(missing.statusCode).toBe(404);
    expectHeaders(missing);
  });

  it('emits headers on 500 responses without leaking internals', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/fail' });
    expect(response.statusCode).toBe(500);
    expectHeaders(response);
  });

  it('is not influenced by attacker-controlled request headers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/ok',
      headers: {
        origin: 'https://evil.example',
        'x-frame-options': 'ALLOWALL',
        'content-type': 'text/html',
      },
    });
    expect(response.statusCode).toBe(200);
    expectHeaders(response);
  });

  it('emits no HSTS header (M5.9 owns TLS policy)', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/ok' });
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});
