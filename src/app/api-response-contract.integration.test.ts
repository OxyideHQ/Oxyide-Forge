import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

/**
 * M7.2 — public response contracts are explicit and enforced.
 *
 * Two mechanisms, tested separately:
 * 1. Presence: every /api/v1 route sending a JSON body declares a
 *    Fastify `response:` schema (captured mechanically via `onRoute`).
 * 2. Behavior: live responses match the declared shapes exactly, and the
 *    serializer strips anything the contract does not declare — proven by
 *    serving hostile service objects through the REAL schema consts.
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('./app.js');
const { PUBLIC_USER_JSON_SCHEMA } = await import('../modules/users/user-response.js');

const PUBLIC_USER_KEYS = ['createdAt', 'displayName', 'email', 'id', 'role', 'status', 'updatedAt'];

let app: FastifyInstance;
let dbAvailable = false;

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

  app = await buildApp({ loggerStream: { write: () => true } });
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await cleanDatabase();
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanDatabase();
  }
  await app?.close();
  await prisma.$disconnect();
});

async function registerAndLogin(
  stamp: string,
): Promise<{ token: string; userId: string; email: string }> {
  const email = `contract-${stamp}@example.com`;
  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  expect(registered.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  const token = (login.json() as { accessToken: string }).accessToken;
  const userId = (registered.json() as { id: string }).id;
  return { token, userId, email };
}

/* ─────────────── 1. schema presence (mechanical) ─────────────── */

describe('response schema presence', () => {
  it('every JSON-body /api/v1 route declares its success response schema', async () => {
    const captured = new Map<string, unknown>();
    const probe = Fastify({ logger: false });
    probe.addHook('onRoute', (routeOptions: RouteOptions) => {
      captured.set(`${routeOptions.method} ${routeOptions.url}`, routeOptions.schema);
    });
    const { registerAuthRoutes } = await import('../modules/auth/routes/auth.routes.js');
    const { registerUserRoutes } = await import('../modules/users/routes/user.routes.js');
    const { registerRoleRoutes } = await import('../modules/roles/routes/role.routes.js');
    await probe.register(registerAuthRoutes);
    await probe.register(registerUserRoutes);
    await probe.register(registerRoleRoutes);
    await probe.ready();

    // Routes sending a JSON body must declare response:[status].
    const withBody: ReadonlyArray<[string, number]> = [
      ['POST /api/v1/auth/register', 201],
      ['POST /api/v1/auth/login', 200],
      ['GET /api/v1/auth/me', 200],
      ['POST /api/v1/auth/refresh', 200],
      ['GET /api/v1/users/:id', 200],
      ['PUT /api/v1/users/:id', 200],
      ['GET /api/v1/roles', 200],
      ['GET /api/v1/roles/:name', 200],
    ];
    for (const [route, status] of withBody) {
      const schema = captured.get(route) as { response?: Record<number, unknown> } | undefined;
      expect(schema, route).toBeDefined();
      expect(schema?.response, `${route} response`).toBeDefined();
      expect(schema?.response?.[status], `${route} response[${status}]`).toBeDefined();
    }

    // 204 routes send no body and declare no JSON response contract.
    for (const route of [
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/password-reset/request',
      'POST /api/v1/auth/password-reset/confirm',
      'POST /api/v1/auth/email-verification/resend',
      'POST /api/v1/auth/email-verification/confirm',
      'POST /api/v1/auth/sessions/revoke-all',
      'DELETE /api/v1/users/:id',
    ]) {
      expect(captured.has(route), route).toBe(true);
    }
    await probe.close();
  });

  it('version boundary: /api/v1 holds, health stays outside, no v2 exists', async () => {
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    // Unversioned API paths and a hypothetical v2 do not exist.
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v2/auth/me' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
  });
});

/* ─────────────── 2. live response shapes ─────────────── */

describe('live success shapes match the declared contracts', () => {
  it('register returns 201 PublicUser with Location', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: `reg-${Date.now()}@example.com`, password: 'correct-horse-battery-staple' },
    });
    expect(response.statusCode).toBe(201);
    expect(String(response.headers['content-type'])).toContain('application/json');
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(PUBLIC_USER_KEYS);
    expect(body.displayName).toBeNull();
    expect(response.headers.location).toBe(`/api/v1/users/${body.id}`);
  });

  it('login returns the token envelope for API clients', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const stamp = `${Date.now()}-login`;
    const email = `login-${stamp}@example.com`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery-staple' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'correct-horse-battery-staple' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accessToken: expect.any(String),
    });
  });

  it('login returns PublicUser for browser clients (cookies carry tokens)', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = `browser-${Date.now()}@example.com`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery-staple' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email, password: 'correct-horse-battery-staple' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(PUBLIC_USER_KEYS);
    expect(response.payload).not.toContain('accessToken');
  });

  it('me/users GET/PUT return exact PublicUser', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const { token, userId } = await registerAndLogin(`${Date.now()}-me`);
    const auth = { authorization: `Bearer ${token}` };

    for (const response of [
      await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth }),
      await app.inject({ method: 'GET', url: `/api/v1/users/${userId}`, headers: auth }),
      await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${userId}`,
        headers: auth,
        payload: { displayName: 'Ada' },
      }),
    ]) {
      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json() as object).sort()).toEqual(PUBLIC_USER_KEYS);
    }
    const updated = (
      await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${userId}`,
        headers: auth,
        payload: { displayName: null },
      })
    ).json() as Record<string, unknown>;
    expect(updated.displayName).toBeNull();
  });

  it('roles endpoints return exact shapes', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const { token } = await registerAndLogin(`${Date.now()}-roles`);
    const auth = { authorization: `Bearer ${token}` };

    // Plain users cannot read roles (permission gate intact).
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/roles', headers: auth })).statusCode,
    ).toBe(403);

    await prisma.user.updateMany({ data: { role: 'admin' } });
    const list = await app.inject({ method: 'GET', url: '/api/v1/roles', headers: auth });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { roles: Array<{ name: unknown; permissions: unknown }> };
    expect(Object.keys(listBody).sort()).toEqual(['roles']);
    expect(listBody.roles.length).toBeGreaterThan(0);
    for (const role of listBody.roles) {
      expect(Object.keys(role).sort()).toEqual(['name', 'permissions']);
      expect(Array.isArray(role.permissions)).toBe(true);
    }

    const detail = await app.inject({ method: 'GET', url: '/api/v1/roles/admin', headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(Object.keys(detail.json() as object).sort()).toEqual(['name', 'permissions']);
  });

  it('204 responses are truly empty', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = `empty-${Date.now()}@example.com`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery-staple' },
    });

    for (const init of [
      { method: 'POST', url: '/api/v1/auth/logout' },
      {
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        payload: { email },
      },
      {
        method: 'POST',
        url: '/api/v1/auth/email-verification/resend',
        payload: { email },
      },
    ] as const) {
      const response = await app.inject(init);
      expect(response.statusCode).toBe(204);
      expect(response.payload).toBe('');
    }
  });

  it('errors still use frozen M6 Problem Details beside the new schemas', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'not-an-email', password: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    expect(String(bad.headers['content-type'])).toContain('application/problem+json');
    expect(Object.keys(bad.json() as object).sort()).toEqual([
      'code',
      'detail',
      'instance',
      'status',
      'title',
      'type',
    ]);
  });
});

/* ─────────────── 3. adversarial serialization boundary ─────────────── */

describe('response schemas strip undeclared fields', () => {
  async function serveThroughSchema(
    schema: unknown,
    value: unknown,
  ): Promise<{ statusCode: number; payload: string; json(): unknown }> {
    const probe = Fastify({ logger: false });
    probe.get('/probe', { schema: { response: { 200: schema } } }, async (_request, reply) => {
      return reply.status(200).send(value);
    });
    await probe.ready();
    const response = await probe.inject({ method: 'GET', url: '/probe' });
    await probe.close();
    return response as unknown as { statusCode: number; payload: string; json(): unknown };
  }

  const baseUser = {
    id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
    email: 'ada@example.com',
    displayName: null,
    status: 'active',
    role: 'user',
    createdAt: '2026-01-15T09:30:00.000Z',
    updatedAt: '2026-01-15T09:30:00.000Z',
  };

  it('strips extra top-level properties', async () => {
    const response = await serveThroughSchema(PUBLIC_USER_JSON_SCHEMA, {
      ...baseUser,
      passwordHash: '$2b$12$SECRET',
      extra: 'x',
    });
    expect(Object.keys(response.json() as object).sort()).toEqual(PUBLIC_USER_KEYS);
    expect(response.payload).not.toContain('SECRET');
  });

  it('strips credential / refresh / reset / verification internals', async () => {
    const response = await serveThroughSchema(PUBLIC_USER_JSON_SCHEMA, {
      ...baseUser,
      credential: { id: 'c1', passwordHash: 'SECRET' },
      refreshToken: { tokenHash: 'SECRET' },
      passwordResetToken: { tokenHash: 'SECRET' },
      emailVerificationToken: { tokenHash: 'SECRET' },
      emailVerifiedAt: '2026-01-15T09:30:00.000Z',
      lockedUntil: '2026-01-15T09:30:00.000Z',
    });
    expect(Object.keys(response.json() as object).sort()).toEqual(PUBLIC_USER_KEYS);
    expect(response.payload).not.toContain('SECRET');
    expect(response.payload).not.toContain('emailVerifiedAt');
    expect(response.payload).not.toContain('lockedUntil');
  });

  it('strips nested unexpected objects on envelope routes', async () => {
    const probe = Fastify({ logger: false });
    const envelope = {
      type: 'object',
      required: ['accessToken'],
      additionalProperties: false,
      properties: { accessToken: { type: 'string', minLength: 1 } },
    } as const;
    probe.get('/probe', { schema: { response: { 200: envelope } } }, async (_request, reply) => {
      return reply.status(200).send({ accessToken: 'tok', nested: { admin: true } });
    });
    await probe.ready();
    const response = await probe.inject({ method: 'GET', url: '/probe' });
    await probe.close();
    expect(response.json()).toEqual({ accessToken: 'tok' });
  });

  it('preserves explicit null; a missing required field fails closed to 500', async () => {
    const nulled = await serveThroughSchema(PUBLIC_USER_JSON_SCHEMA, {
      ...baseUser,
      displayName: null,
    });
    expect((nulled.json() as Record<string, unknown>).displayName).toBeNull();

    // fast-json-stringify refuses to serialize a missing required
    // property, so a service bug that drops a public field becomes a loud
    // 500 — never a partial body.
    // (§24 case 12: 201 missing a required public field.)
    const { email: _dropped, ...missing } = baseUser;
    expect(_dropped).toBe('ada@example.com');
    const probe = Fastify({ logger: false });
    probe.get('/probe', { schema: { response: { 200: PUBLIC_USER_JSON_SCHEMA } } }, async (_request, reply) => {
      return reply.status(200).send(missing);
    });
    await probe.ready();
    const response = await probe.inject({ method: 'GET', url: '/probe' });
    await probe.close();
    expect(response.statusCode).toBe(500);
  });

  it('coerces scalar type mismatches per JSON Schema without leaking structure', async () => {
    // §24 case 10: a wrong runtime type never bypasses the contract shape.
    // fast-json-stringify serializes per the declared type (numbers become
    // strings); the key set stays exactly the public contract.
    const response = await serveThroughSchema(PUBLIC_USER_JSON_SCHEMA, {
      ...baseUser,
      id: 12345,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(PUBLIC_USER_KEYS);
    expect(typeof body.id).toBe('string');
  });

  it('strips nested unexpected objects through the real roles consts', async () => {    const { roleResponseSchema, roleListResponseSchema } = await import(
      '../modules/roles/routes/role.routes.js'
    );
    const probe = Fastify({ logger: false });
    probe.get('/role', { schema: { response: { 200: roleResponseSchema } } }, async (_request, reply) => {
      return reply.status(200).send({ name: 'admin', permissions: ['users:read'], secret: 'x' });
    });
    probe.get('/roles', { schema: { response: { 200: roleListResponseSchema } } }, async (_request, reply) => {
      return reply.status(200).send({
        roles: [{ name: 'admin', permissions: ['users:read'], extra: { nested: 'x' } }],
      });
    });
    await probe.ready();
    expect((await probe.inject({ method: 'GET', url: '/role' })).json()).toEqual({
      name: 'admin',
      permissions: ['users:read'],
    });
    expect((await probe.inject({ method: 'GET', url: '/roles' })).json()).toEqual({
      roles: [{ name: 'admin', permissions: ['users:read'] }],
    });
    await probe.close();
  });
});
