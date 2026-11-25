import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

// Mutable config double: CORS enablement varies per test through the module
// mock instead of environment mutation. Declared before the dynamic imports
// below so the mock factory never reads an uninitialized binding.
const mockConfig: { cors?: { allowedOrigins: string[] } } = {};

vi.mock('../config/index.js', () => ({
  config: mockConfig,
}));

const { corsPlugin } = await import('./cors.plugin.js');

describe('corsPlugin', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete mockConfig.cors;

    app = Fastify({ logger: false });
    await app.register(corsPlugin);

    app.get('/test/data', async () => ({ ok: true }));
    app.post('/test/data', async () => ({ ok: true }));

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('disabled (no allowlist configured)', () => {
    it('emits no cross-origin headers on plain responses', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/test/data',
        headers: { origin: 'https://app.example.com' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(response.headers.vary).toBeUndefined();
    });

    it('answers preflight without cross-origin headers', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/test/data',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'POST',
        },
      });

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('enabled (explicit allowlist)', () => {
    const ORIGIN = 'https://app.example.com';

    beforeEach(() => {
      mockConfig.cors = { allowedOrigins: [ORIGIN, 'http://localhost:3000'] };
    });

    async function rebuild(): Promise<void> {
      await app.close();
      app = Fastify({ logger: false });
      await app.register(corsPlugin);
      app.get('/test/data', async () => ({ ok: true }));
      app.post('/test/data', async () => ({ ok: true }));
      await app.ready();
    }

    it('allows the exact configured origin', async () => {
      await rebuild();
      const response = await app.inject({
        method: 'GET',
        url: '/test/data',
        headers: { origin: ORIGIN },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    });

    it('rejects suffix, prefix, scheme, port, and case variants', async () => {
      await rebuild();
      for (const origin of [
        'https://app.example.com.evil',
        'https://evilapp.example.com',
        'http://app.example.com',
        'https://app.example.com:8443',
        'https://APP.EXAMPLE.COM',
        'https://app.example.com/',
        'null',
        'not-a-url',
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: '/test/data',
          headers: { origin },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
    });

    it('emits no headers without an Origin header', async () => {
      await rebuild();
      const response = await app.inject({ method: 'GET', url: '/test/data' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('never enables credentials, even for allowed origins', async () => {
      await rebuild();
      const response = await app.inject({
        method: 'GET',
        url: '/test/data',
        headers: { origin: ORIGIN },
      });

      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('answers valid preflight without authentication and never advertises invalid methods', async () => {
      await rebuild();
      const valid = await app.inject({
        method: 'OPTIONS',
        url: '/test/data',
        headers: {
          origin: ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type, authorization',
        },
      });

      expect(valid.statusCode).toBe(204);
      expect(valid.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(String(valid.headers['access-control-allow-methods'])).toContain('POST');
      expect(String(valid.headers['access-control-allow-headers']).toLowerCase()).toContain(
        'authorization',
      );

      // Preflight is a browser gate, not access control: unlisted methods are
      // never advertised, and the actual request still 404s on routing.
      // PATCH is used as the unlisted-method probe: it is a valid Fastify
      // HTTP method (unlike TRACE, which the inject type rejects) but is
      // outside the CORS-advertised method set.
      const invalidMethod = await app.inject({
        method: 'OPTIONS',
        url: '/test/data',
        headers: { origin: ORIGIN, 'access-control-request-method': 'PATCH' },
      });
      expect(String(invalidMethod.headers['access-control-allow-methods'] || '')).not.toContain(
        'PATCH',
      );

      const actualPatch = await app.inject({
        method: 'PATCH',
        url: '/test/data',
        headers: { origin: ORIGIN },
      });
      expect(actualPatch.statusCode).toBe(404);
    });

    it('denies preflight from disallowed origins', async () => {
      await rebuild();
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/test/data',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
        },
      });

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
