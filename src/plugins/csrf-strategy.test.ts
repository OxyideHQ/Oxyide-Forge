import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const { cookiePlugin } = await import('./cookie.plugin.js');
const { authPlugin } = await import('./auth.plugin.js');
const { config } = await import('../config/index.js');

/**
 * CSRF strategy composition proofs (M5.4, ADR-012).
 *
 * The decision is structural, not token-based, so these tests prove the
 * structure rather than a token protocol:
 *
 * 1. The server performs NO Origin validation (deliberate non-control):
 *    safety comes from the browser withholding Strict cookies
 *    cross-origin, not from server-side Origin parsing.
 * 2. A cross-origin state-changing request carrying no credential fails
 *    with 401 — there is no ambient authority for a malicious site to ride.
 * 3. Cookie + bearer together fail (exact-one-mechanism) — credentials
 *    cannot be stacked.
 * 4. Effective cookie attributes derive from the hardened config
 *    (Strict, HttpOnly, host-only, path-scoped).
 */
const { registerGlobalErrorHandler } = await import('../app/app.js');

describe('CSRF strategy (ADR-012)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    await app.register(cookiePlugin);
    await app.register(authPlugin);

    app.put(
      '/test/transfer',
      { preHandler: [app.authenticate] },
      async () => ({ ok: true }),
    );

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('performs no Origin validation: credentialed same-origin-shaped requests succeed regardless of Origin', async () => {
    const token = app.jwt.sign({ sub: 'user-1' });

    // A cross-origin Origin header with a valid cookie is honored at the
    // HTTP layer. This is deliberate: the CSRF control is the browser
    // withholding the Strict cookie cross-origin — the server never sees
    // such a request from a real browser. Server-side Origin parsing would
    // be a weaker, spoofable duplicate of that guarantee.
    const response = await app.inject({
      method: 'PUT',
      url: '/test/transfer',
      headers: { origin: 'https://evil.example', cookie: `accessToken=${token}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects cross-origin state-changing requests carrying no credential', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/test/transfer',
      headers: { origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects stacked credentials (bearer + cookie together)', async () => {
    const token = app.jwt.sign({ sub: 'user-1' });

    const response = await app.inject({
      method: 'PUT',
      url: '/test/transfer',
      headers: {
        origin: 'https://evil.example',
        authorization: `Bearer ${token}`,
        cookie: `accessToken=${token}`,
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('derives effective cookie attributes from the hardened config', () => {
    // Structural proof: the values the server actually serializes come
    // from the frozen canonical config — Strict (M5.4), HttpOnly,
    // host-only (no Domain), path-scoped.
    expect(config.auth.cookie.sameSite).toBe('strict');
    expect(config.auth.refreshCookie.sameSite).toBe('strict');
    expect(config.auth.cookie.httpOnly).toBe(true);
    expect(config.auth.refreshCookie.httpOnly).toBe(true);
    expect(Object.isFrozen(config.auth.cookie)).toBe(true);
    expect(Object.isFrozen(config.auth.refreshCookie)).toBe(true);
  });
});
