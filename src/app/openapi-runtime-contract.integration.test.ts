import { Ajv2020 } from 'ajv/dist/2020.js';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

/**
 * M7.8 — live responses validated against their own OpenAPI operation.
 *
 * The document is the contract, so the response is checked against the
 * schema *as published*, not against a hand-written duplicate: if the
 * document and the runtime ever disagree, this fails.
 *
 * Representative contract classes only (no endpoint × status matrix): 201,
 * 200 token envelope, 200 PublicUser, 204, 400, 401, 403, 404, 409, 429.
 *
 * DB-gated because every one of those requires persisted state; the
 * document/route contract that needs no database lives in
 * `openapi-contract.test.ts`.
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('./app.js');

type ResponseObject = {
  description?: string;
  content?: Record<string, { schema?: Record<string, unknown> }>;
  headers?: unknown;
};

type Operation = {
  responses?: Record<string, ResponseObject | { $ref: string }>;
};

type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
};

let app: FastifyInstance;
let spec: Spec;

/** Ajv 2020-12: the dialect OpenAPI 3.1 schemas are written in. */
const ajv = new Ajv2020({ strict: false, allErrors: true });

/** Compiled validators, cached per `$ref`-resolved schema identity. */
const validators = new Map<string, ReturnType<Ajv2020['compile']>>();

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
  } catch {
    throw new Error(
      'PostgreSQL unavailable: integration tests require a running database at DATABASE_URL.',
    );
  }

  app = await buildApp({ loggerStream: { write: () => true } });
  await app.ready();
  spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;

  // Register the published components once so `$ref`s resolve the same way
  // a consumer of the document would resolve them.
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    ajv.addSchema(schema as object, `#/components/schemas/${name}`);
  }
});

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
  await prisma.$disconnect();
});

/** Returns the published response object for a status, or fails loudly. */
function publishedResponse(path: string, method: string, status: number): ResponseObject {
  const operation = spec.paths[path]?.[method];
  expect(operation, `no published operation for ${method.toUpperCase()} ${path}`).toBeDefined();
  const response = (operation as Operation).responses?.[String(status)];
  expect(
    response,
    `${method.toUpperCase()} ${path} does not document ${status}`,
  ).toBeDefined();
  if (response === undefined || '$ref' in response) {
    throw new Error(`${method.toUpperCase()} ${path} ${status} is not an inline response object`);
  }
  return response;
}

/**
 * Validates a live body against the schema exactly as published, for the
 * given content type. Returns Ajv errors rather than throwing so a failure
 * message names the actual violation.
 */
function validateAgainstPublishedSchema(
  body: unknown,
  path: string,
  method: string,
  status: number,
  contentType: string,
): string[] {
  const response = publishedResponse(path, method, status);
  const media = response.content?.[contentType];
  expect(
    media,
    `${method.toUpperCase()} ${path} ${status} does not document ${contentType}`,
  ).toBeDefined();
  const schema = media?.schema as Record<string, unknown>;
  const key = `${method} ${path} ${status} ${contentType}`;
  let validate = validators.get(key);
  if (validate === undefined) {
    validate = ajv.compile(schema);
    validators.set(key, validate);
  }
  return validate(body) === true
    ? []
    : (validate.errors ?? []).map(
        (error: { instancePath?: string; message?: string }) =>
          `${error.instancePath || '/'} ${error.message ?? 'failed'}`,
      );
}

async function registerUser(
  email: string,
  password = 'correct-horse-battery-staple',
): Promise<{ id: string; token: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password },
  });
  expect(response.statusCode).toBe(201);
  return {
    id: response.json().id as string,
    token: (await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    })).json().accessToken as string,
  };
}

describe('M7.8 runtime response vs published OpenAPI', () => {
  it('201 creation: body matches the published 201 schema and Location is documented', async () => {
    const email = `contract-201-${Date.now()}@example.com`;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery-staple' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toContain('application/json');
    expect(
      validateAgainstPublishedSchema(
        response.json(),
        '/api/v1/auth/register',
        'post',
        201,
        'application/json',
      ),
    ).toEqual([]);
    // M7.2 §6: the 201 is addressable, and the document says so.
    expect(response.headers.location).toBe(`/api/v1/users/${response.json().id}`);
    expect(publishedResponse('/api/v1/auth/register', 'post', 201).headers).toBeDefined();
  });

  it('200 token envelope: login matches the published anyOf branch', async () => {
    const email = `contract-200-${Date.now()}@example.com`;
    await registerUser(email);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'correct-horse-battery-staple' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('accessToken');
    expect(
      validateAgainstPublishedSchema(
        response.json(),
        '/api/v1/auth/login',
        'post',
        200,
        'application/json',
      ),
    ).toEqual([]);
  });

  it('200 PublicUser: /auth/me matches the published schema', async () => {
    const { token } = await registerUser(`contract-me-${Date.now()}@example.com`);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(
      validateAgainstPublishedSchema(
        response.json(),
        '/api/v1/auth/me',
        'get',
        200,
        'application/json',
      ),
    ).toEqual([]);
  });

  it('204 logout: documented as bodyless and served bodyless', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });

    expect(response.statusCode).toBe(204);
    expect(response.payload).toBe('');
    expect(publishedResponse('/api/v1/auth/logout', 'post', 204).content).toBeUndefined();
  });

  it('400 validation: body matches the published ProblemDetails schema', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'nope' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(
      validateAgainstPublishedSchema(
        response.json(),
        '/api/v1/auth/register',
        'post',
        400,
        'application/problem+json',
      ),
    ).toEqual([]);
  });

  it('401 unauthenticated: documented, served, and carries WWW-Authenticate', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBeDefined();
    expect(
      validateAgainstPublishedSchema(
        response.json(),
        '/api/v1/auth/me',
        'get',
        401,
        'application/problem+json',
      ),
    ).toEqual([]);
  });

  it('403 forbidden: a valid caller without the permission is denied generically', async () => {
    const { id, token } = await registerUser(`contract-403-${Date.now()}@example.com`);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(
      validateAgainstPublishedSchema(
        response.json(),
        '/api/v1/users/{id}',
        'delete',
        403,
        'application/problem+json',
      ),
    ).toEqual([]);
    // M6: the generic 403 detail, never the policy reason.
    expect(response.json().detail).toBe('You do not have permission to perform this action.');
  });

  it('404 missing resource: documented for the operation and served', async () => {
    const { id, token } = await registerUser(`contract-404-${Date.now()}@example.com`);

    // A plain user asking for someone else is denied first (403), which the
    // previous test proves. Reaching the missing-target 404 requires a
    // caller with `users:read`, so the fixture is promoted exactly as the
    // existing status-policy suite does — no authorization is weakened.
    await prisma.user.update({ where: { id }, data: { role: 'admin' } });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
    expect(
      validateAgainstPublishedSchema(
        response.json(),
        '/api/v1/users/{id}',
        'get',
        404,
        'application/problem+json',
      ),
    ).toEqual([]);
  });

  it('409 conflict: duplicate registration is documented and served', async () => {
    const email = `contract-409-${Date.now()}@example.com`;
    await registerUser(email);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'correct-horse-battery-staple' },
    });

    expect(response.statusCode).toBe(409);
    expect(
      validateAgainstPublishedSchema(
        response.json(),
        '/api/v1/auth/register',
        'post',
        409,
        'application/problem+json',
      ),
    ).toEqual([]);
  });

  // bcrypt at cost 12 plus bounded exponential backoff makes the throttle
  // sequence intentionally slow; the default 5s budget is not enough.
  it('429 throttled: documented and served', { timeout: 60000 }, async () => {
    const email = `contract-429-${Date.now()}@example.com`;
    await registerUser(email);

    let lastStatus = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'wrong-password-entirely' },
      });
      lastStatus = response.statusCode;
      if (lastStatus === 429) {
        expect(
          validateAgainstPublishedSchema(
            response.json(),
            '/api/v1/auth/login',
            'post',
            429,
            'application/problem+json',
          ),
        ).toEqual([]);
        return;
      }
    }
    // Reaching here means the throttle never engaged: the 429 the document
    // advertises would then be an unverifiable claim.
    expect(lastStatus, 'login throttle never produced a 429').toBe(429);
  });

  it('no runtime response invents a status the document does not publish', async () => {
    // Every status observed above must exist in the published operation.
    const observed: Array<[string, string, number]> = [
      ['/api/v1/auth/register', 'post', 201],
      ['/api/v1/auth/register', 'post', 400],
      ['/api/v1/auth/login', 'post', 200],
      ['/api/v1/auth/logout', 'post', 204],
      ['/api/v1/auth/me', 'get', 200],
      ['/api/v1/auth/me', 'get', 401],
      ['/api/v1/users/{id}', 'delete', 403],
      ['/api/v1/users/{id}', 'get', 404],
    ];

    for (const [path, method, status] of observed) {
      expect(
        publishedResponse(path, method, status),
        `${method.toUpperCase()} ${path} ${status}`,
      ).toBeDefined();
    }
  });
});