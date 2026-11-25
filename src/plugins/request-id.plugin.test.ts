import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REQUEST_ID_HEADER, requestIdPlugin } from './request-id.plugin.js';

/**
 * M6.6 — request-ID response header proofs (isolated plugin scope).
 *
 * The header always carries the server-generated request ID;
 * client-supplied values (however hostile) are never adopted, reflected,
 * or logged as the identifier. Triangulation against Problem Details
 * `instance` and log `reqId` is proven at integration scope.
 */
describe('requestIdPlugin', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin);

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

  it('emits the server-generated ID on success responses', async () => {
    for (const [method, url, expected] of [
      ['GET', '/test/ok', 200],
      ['POST', '/test/created', 201],
      ['GET', '/test/empty', 204],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(expected);
      expect(response.headers[REQUEST_ID_HEADER]).toMatch(/^req-[0-9a-z]+$/);
    }
  });

  it('emits distinct IDs across independent requests', async () => {
    const first = await app.inject({ method: 'GET', url: '/test/ok' });
    const second = await app.inject({ method: 'GET', url: '/test/ok' });
    expect(first.headers[REQUEST_ID_HEADER]).not.toBe(second.headers[REQUEST_ID_HEADER]);
  });

  it('ignores client-supplied IDs entirely (never adopted, never reflected)', async () => {
    for (const headers of [
      { 'x-request-id': 'client-chosen-123' },
      { 'request-id': 'client-chosen-456' },
      { 'x-request-id': 'a\nSet-Cookie: forged=1' },
      { 'x-request-id': 'x'.repeat(5000) },
      { 'x-request-id': ['one', 'two'] },
      { 'x-request-id': 'Bearer secret-token-value' },
      { 'x-request-id': 'password=hunter2' },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/test/ok', headers });
      expect(response.statusCode).toBe(200);
      const emitted = response.headers[REQUEST_ID_HEADER];
      expect(emitted).toMatch(/^req-[0-9a-z]+$/);
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain('client-chosen');
      expect(serialized).not.toContain('hunter2');
    }
  });

  it('emits the ID on framework error responses too', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/test/created',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers[REQUEST_ID_HEADER]).toMatch(/^req-[0-9a-z]+$/);

    const missing = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers[REQUEST_ID_HEADER]).toMatch(/^req-[0-9a-z]+$/);
  });
});
