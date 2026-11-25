import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const { authPlugin } = await import('./auth.plugin.js');
const { cookiePlugin } = await import('./cookie.plugin.js');
const { config } = await import('../config/index.js');

const { registerGlobalErrorHandler } = await import('../app/app.js');

describe('authPlugin & request authentication context', () => {
  let app: FastifyInstance;
  const userId = 'usr_01HX9Z6Y7K8Q3V2N4M5P6R7S8T';

  beforeEach(async () => {
    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    await app.register(authPlugin);

    // Register a test protected route using the authenticate hook
    app.get('/test/protected', { onRequest: [app.authenticate] }, async (request) => {
      return {
        auth: request.auth,
      };
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('authenticates successfully with a valid JWT and attaches documented auth context', async () => {
    const token = app.jwt.sign({ sub: userId }, { expiresIn: 900 });

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.auth).toBeDefined();

    // AuthContext is exactly { sub, iat, exp }
    expect(body.auth.sub).toBe(userId);
    expect(typeof body.auth.iat).toBe('number');
    expect(typeof body.auth.exp).toBe('number');

    // Ensure only documented properties exist
    const authKeys = Object.keys(body.auth).sort();
    expect(authKeys).toEqual(['exp', 'iat', 'sub']);

    // Ensure no userId property
    expect(body.auth.userId).toBeUndefined();

    // Ensure no nested user property
    expect(body.auth.user).toBeUndefined();

    // Ensure no roles, permissions, scopes, or authorization state exist
    expect(body.auth.roles).toBeUndefined();
    expect(body.auth.permissions).toBeUndefined();
    expect(body.auth.scopes).toBeUndefined();
  });

  it('rejects request with missing Authorization header (401)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(
      'Bearer realm="oxyide", error="invalid_token"',
    );
    const body = response.json();
    expect(body.status).toBe(401);
    expect(body.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('rejects request with non-Bearer scheme or malformed Authorization header (401)', async () => {
    const response1 = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: {
        authorization: 'Basic dXNlcjpwYXNz',
      },
    });

    expect(response1.statusCode).toBe(401);
    expect(response1.headers['www-authenticate']).toBe(
      'Bearer realm="oxyide", error="invalid_token"',
    );
    expect(response1.json().code).toBe('AUTH_INVALID_TOKEN');

    const response2 = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: {
        authorization: 'Bearer',
      },
    });

    expect(response2.statusCode).toBe(401);
    expect(response2.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('rejects request with malformed JWT token string (401)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: {
        authorization: 'Bearer not-a-valid-jwt-token',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(
      'Bearer realm="oxyide", error="invalid_token"',
    );
    const body = response.json();
    expect(body.status).toBe(401);
    expect(body.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('rejects request with JWT signed with wrong secret (401)', async () => {
    // Construct a JWT manually with a different key to test wrong-secret rejection
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: userId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 }),
    ).toString('base64url');
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', 'foreign-signing-secret-not-matching-configured-key')
      .update(`${header}.${payload}`)
      .digest('base64url');
    const foreignToken = `${header}.${payload}.${signature}`;

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: {
        authorization: `Bearer ${foreignToken}`,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(
      'Bearer realm="oxyide", error="invalid_token"',
    );
    const body = response.json();
    expect(body.status).toBe(401);
    expect(body.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('rejects request with expired JWT token with AUTH_TOKEN_EXPIRED error code (401)', async () => {
    const expiredToken = app.jwt.sign({ sub: userId }, { expiresIn: -1 });

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: {
        authorization: `Bearer ${expiredToken}`,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(
      'Bearer realm="oxyide", error="invalid_token"',
    );
    const body = response.json();
    expect(body.status).toBe(401);
    expect(body.code).toBe('AUTH_TOKEN_EXPIRED');
  });
});

describe('cookie transport', () => {
  let app: FastifyInstance;
  const userId = 'usr_01HX9Z6Y7K8Q3V2N4M5P6R7S8T';
  const cookieName = config.auth.cookie.name;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    await app.register(cookiePlugin);
    await app.register(authPlugin);

    app.get('/test/protected', { onRequest: [app.authenticate] }, async (request) => {
      return {
        auth: request.auth,
      };
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function cookieHeader(token: string): Record<string, string> {
    return { cookie: `${cookieName}=${token}` };
  }

  it('authenticates with a valid access-token cookie and attaches AuthContext', async () => {
    const token = app.jwt.sign({ sub: userId }, { expiresIn: 900 });

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: cookieHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.auth.sub).toBe(userId);
    expect(typeof body.auth.iat).toBe('number');
    expect(typeof body.auth.exp).toBe('number');
    expect(Object.keys(body.auth).sort()).toEqual(['exp', 'iat', 'sub']);
  });

  it('AuthContext is identical regardless of transport', async () => {
    const token = app.jwt.sign({ sub: userId }, { expiresIn: 900 });

    const viaBearer = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    const viaCookie = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: cookieHeader(token),
    });

    expect(viaBearer.statusCode).toBe(200);
    expect(viaCookie.statusCode).toBe(200);
    expect(viaCookie.json().auth).toEqual(viaBearer.json().auth);
  });

  it('rejects a malformed cookie token with the existing 401 contract', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: cookieHeader('not-a-valid-jwt-token'),
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(
      'Bearer realm="oxyide", error="invalid_token"',
    );
    expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('rejects an expired cookie token with AUTH_TOKEN_EXPIRED', async () => {
    const expiredToken = app.jwt.sign({ sub: userId }, { expiresIn: -1 });

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: cookieHeader(expiredToken),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('rejects a cookie token signed with the wrong secret', async () => {
    const { createHmac } = await import('node:crypto');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: userId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 }),
    ).toString('base64url');
    const signature = createHmac('sha256', 'foreign-signing-secret-not-matching-configured-key')
      .update(`${header}.${payload}`)
      .digest('base64url');

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: cookieHeader(`${header}.${payload}.${signature}`),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('rejects empty and whitespace cookie values', async () => {
    for (const value of ['', '   ']) {
      const response = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: cookieHeader(value),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
    }
  });

  it('rejects a token with a missing or invalid sub on either transport', async () => {
    const noSub = app.jwt.sign({});
    const emptySub = app.jwt.sign({ sub: '' });

    for (const token of [noSub, emptySub]) {
      const viaBearer = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { authorization: `Bearer ${token}` },
      });
      const viaCookie = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: cookieHeader(token),
      });

      expect(viaBearer.statusCode).toBe(401);
      expect(viaBearer.json().code).toBe('AUTH_INVALID_TOKEN');
      expect(viaCookie.statusCode).toBe(401);
      expect(viaCookie.json().code).toBe('AUTH_INVALID_TOKEN');
    }
  });

  it('rejects requests presenting both bearer and cookie credentials', async () => {
    const token = app.jwt.sign({ sub: userId }, { expiresIn: 900 });
    const otherToken = app.jwt.sign({ sub: 'usr_other' }, { expiresIn: 900 });

    // Same valid credential on both transports is still rejected: exactly one mechanism.
    const sameResponse = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${token}`, ...cookieHeader(token) },
    });
    expect(sameResponse.statusCode).toBe(401);
    expect(sameResponse.json().code).toBe('AUTH_INVALID_TOKEN');

    // Conflicting credentials are rejected, not resolved by silent precedence.
    const conflictResponse = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${token}`, ...cookieHeader(otherToken) },
    });
    expect(conflictResponse.statusCode).toBe(401);
    expect(conflictResponse.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('does not fall back across transports on partial invalidity', async () => {
    const token = app.jwt.sign({ sub: userId }, { expiresIn: 900 });

    const badBearerGoodCookie = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: 'Bearer garbage', ...cookieHeader(token) },
    });
    expect(badBearerGoodCookie.statusCode).toBe(401);

    const goodBearerBadCookie = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${token}`, ...cookieHeader('garbage') },
    });
    expect(goodBearerBadCookie.statusCode).toBe(401);
  });

  it('ignores the cookie when the cookie parser is not registered', async () => {
    const bare = Fastify({ logger: false });
    registerGlobalErrorHandler(bare);
    await bare.register(authPlugin);
    bare.get('/test/protected', { onRequest: [bare.authenticate] }, async (request) => {
      return { auth: request.auth };
    });
    await bare.ready();

    try {
      const token = bare.jwt.sign({ sub: userId }, { expiresIn: 900 });

      // Without parsing, a cookie-only request cannot authenticate (production-gate analogue).
      const cookieOnly = await bare.inject({
        method: 'GET',
        url: '/test/protected',
        headers: cookieHeader(token),
      });
      expect(cookieOnly.statusCode).toBe(401);

      // Bearer-only behavior is unaffected.
      const bearerOnly = await bare.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bearerOnly.statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });
});

describe('boundaries', () => {
  it('auth plugin depends on the AuthContext contract, not on the auth module', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const pluginPath = path.resolve(import.meta.dirname, 'auth.plugin.ts');
    const pluginSource = fs.readFileSync(pluginPath, 'utf-8');

    expect(pluginSource).not.toContain('modules/');
    expect(pluginSource).toContain('types/auth-context.js');
  });

  it('Fastify request augmentation does not depend on domain modules', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const typesPath = path.resolve(import.meta.dirname, '..', 'types', 'fastify.d.ts');
    const typesSource = fs.readFileSync(typesPath, 'utf-8');

    expect(typesSource).not.toContain('modules/');
    expect(typesSource).toContain("'./auth-context.js'");
  });

  it('AuthContext has exactly one authoritative declaration, in src/types', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const srcDir = path.resolve(import.meta.dirname, '..');
    const files = await fs.promises.readdir(srcDir, { recursive: true });
    const needle = ['interface', 'AuthContext'].join(' ');

    const declarations: string[] = [];
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const content = await fs.promises.readFile(path.join(srcDir, file), 'utf-8');
      if (content.includes(needle)) {
        declarations.push(String(file).replace(/\\/g, '/'));
      }
    }

    expect(declarations).toEqual(['types/auth-context.ts']);
  });
});
