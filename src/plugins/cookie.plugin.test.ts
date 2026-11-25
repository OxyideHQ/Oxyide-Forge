import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const { cookiePlugin } = await import('./cookie.plugin.js');
const { authPlugin } = await import('./auth.plugin.js');

describe('cookiePlugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('cookie registration', () => {
    it('registers @fastify/cookie and exposes cookie parsing on requests', async () => {
      app = Fastify({ logger: false });
      await app.register(cookiePlugin);

      app.get('/test/cookie', async (request, reply) => {
        reply.setCookie('testCookie', 'testValue', {
          path: '/',
          httpOnly: true,
        });
        return { cookies: request.cookies };
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test/cookie',
        headers: {
          cookie: 'existingCookie=existingValue',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.cookies.existingCookie).toBe('existingValue');

      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();
      expect(setCookieHeader).toContain('testCookie=testValue');
    });
  });

  describe('development cookie configuration', () => {
    it('has HttpOnly true', async () => {
      app = Fastify({ logger: false });
      await app.register(cookiePlugin);

      app.get('/test/httpOnly', async (_request, reply) => {
        reply.setCookie('httpOnlyCookie', 'value', { path: '/' });
        return { ok: true };
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test/httpOnly',
      });

      expect(response.statusCode).toBe(200);
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toContain('HttpOnly');
    });

    it('has Secure false in development/test', async () => {
      app = Fastify({ logger: false });
      await app.register(cookiePlugin);

      app.get('/test/secure', async (_request, reply) => {
        reply.setCookie('secureCookie', 'value', { path: '/' });
        return { ok: true };
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test/secure',
      });

      expect(response.statusCode).toBe(200);
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).not.toContain('Secure');
    });

    it('has SameSite strict', async () => {
      app = Fastify({ logger: false });
      await app.register(cookiePlugin);

      app.get('/test/samesite', async (_request, reply) => {
        reply.setCookie('samesiteCookie', 'value', { path: '/' });
        return { ok: true };
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test/samesite',
      });

      expect(response.statusCode).toBe(200);
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toContain('SameSite=Strict');
    });

    it('has Path /', async () => {
      app = Fastify({ logger: false });
      await app.register(cookiePlugin);

      app.get('/test/path', async (_request, reply) => {
        reply.setCookie('pathCookie', 'value', { path: '/' });
        return { ok: true };
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test/path',
      });

      expect(response.statusCode).toBe(200);
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toContain('Path=/');
    });

    it('has Max-Age 900', async () => {
      app = Fastify({ logger: false });
      await app.register(cookiePlugin);

      app.get('/test/maxage', async (_request, reply) => {
        reply.setCookie('maxageCookie', 'value', { path: '/' });
        return { ok: true };
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/test/maxage',
      });

      expect(response.statusCode).toBe(200);
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toContain('Max-Age=900');
    });
  });

  describe('cookie name', () => {
    it('cookie name is exactly accessToken in config', async () => {
      const { config } = await import('../config/index.js');
      expect(config.auth.cookie.name).toBe('accessToken');
    });
  });

  describe('production CSRF gate', () => {
    it('allows the application to start in production without registering cookies', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const baseUrl = (process.env.DATABASE_URL ?? 'postgresql://localhost:5432/oxyide_test').split(
        '?',
      )[0];
      vi.stubEnv('DATABASE_URL', `${baseUrl}?sslmode=require`);
      vi.stubEnv('APP_BASE_URL', 'https://app.example.com');
      vi.resetModules();

      const { config: prodConfig } = await import('../config/index.js');
      expect(prodConfig.nodeEnv).toBe('production');
      expect(prodConfig.auth.cookie.enabled).toBe(false);
      expect(prodConfig.auth.cookie.secure).toBe(true);

      const { cookiePlugin: prodCookiePlugin } = await import('./cookie.plugin.js');
      const prodApp = Fastify({ logger: false });

      await prodApp.register(prodCookiePlugin);
      await prodApp.ready();
      await prodApp.close();

      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('does not set an access token cookie for browser login in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const baseUrl = (process.env.DATABASE_URL ?? 'postgresql://localhost:5432/oxyide_test').split(
        '?',
      )[0];
      vi.stubEnv('DATABASE_URL', `${baseUrl}?sslmode=require`);
      vi.stubEnv('APP_BASE_URL', 'https://app.example.com');
      vi.resetModules();

      vi.doMock('../modules/auth/services/auth.service.js', () => ({
        authService: {
          register: vi.fn(),
          login: vi.fn().mockResolvedValue({
            accessToken: 'prod-jwt-token',
            user: {
              id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
              email: 'alice@example.com',
              displayName: 'Alice',
              status: 'active',
              role: 'user',
              createdAt: '2026-01-15T09:30:00.000Z',
              updatedAt: '2026-01-15T09:30:00.000Z',
            },
          }),
        },
      }));

      const { cookiePlugin: prodCookiePlugin } = await import('./cookie.plugin.js');
      const { authPlugin: prodAuthPlugin } = await import('./auth.plugin.js');
      const { registerAuthRoutes } = await import('../modules/auth/routes/auth.routes.js');

      const prodApp = Fastify({ logger: false });
      await prodApp.register(prodCookiePlugin);
      await prodApp.register(prodAuthPlugin);
      await prodApp.register(registerAuthRoutes);
      await prodApp.ready();

      const response = await prodApp.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          accept: 'text/html,application/xhtml+xml',
        },
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.json().accessToken).toBe('prod-jwt-token');

      await prodApp.close();

      vi.unstubAllEnvs();
      vi.resetModules();
    });
  });

  describe('existing bearer authentication', () => {
    it('bearer authentication continues to work after cookie plugin registration', async () => {
      app = Fastify({ logger: false });
      await app.register(cookiePlugin);
      await app.register(authPlugin);

      const userId = 'usr_01HX9Z6Y7K8Q3V2N4M5P6R7S8T';
      app.get('/test/protected', { onRequest: [app.authenticate] }, async (request) => {
        return { auth: request.auth };
      });

      await app.ready();

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
      expect(body.auth.sub).toBe(userId);
      expect(typeof body.auth.iat).toBe('number');
      expect(typeof body.auth.exp).toBe('number');
    });

    it('AuthContext remains exactly { sub, iat, exp }', async () => {
      app = Fastify({ logger: false });
      await app.register(cookiePlugin);
      await app.register(authPlugin);

      const userId = 'usr_01HX9Z6Y7K8Q3V2N4M5P6R7S8T';
      app.get('/test/context', { onRequest: [app.authenticate] }, async (request) => {
        return { auth: request.auth };
      });

      await app.ready();

      const token = app.jwt.sign({ sub: userId }, { expiresIn: 900 });

      const response = await app.inject({
        method: 'GET',
        url: '/test/context',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const authKeys = Object.keys(body.auth).sort();
      expect(authKeys).toEqual(['exp', 'iat', 'sub']);
      expect(body.auth.userId).toBeUndefined();
      expect(body.auth.user).toBeUndefined();
      expect(body.auth.roles).toBeUndefined();
      expect(body.auth.permissions).toBeUndefined();
      expect(body.auth.scopes).toBeUndefined();
    });
  });

  describe('boundaries', () => {
    it('cookie plugin contains no authentication business logic', async () => {
      // Read the source file directly rather than trying to toString the module
      const fs = await import('node:fs');
      const path = await import('node:path');
      const pluginPath = path.resolve(import.meta.dirname, 'cookie.plugin.ts');
      const pluginSource = fs.readFileSync(pluginPath, 'utf-8');

      expect(pluginSource).not.toContain('verifyPassword');
      expect(pluginSource).not.toContain('verifyAccessToken');
      expect(pluginSource).not.toContain('createAccessToken');
      expect(pluginSource).not.toContain('usersService');
      expect(pluginSource).not.toContain('credentialRepository');
    });

    it('cookie plugin does not query the database', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const pluginPath = path.resolve(import.meta.dirname, 'cookie.plugin.ts');
      const pluginSource = fs.readFileSync(pluginPath, 'utf-8');

      expect(pluginSource).not.toContain('prisma');
      expect(pluginSource).not.toContain('$queryRaw');
      expect(pluginSource).not.toContain('findUnique');
      expect(pluginSource).not.toContain('findFirst');
    });
  });
});
