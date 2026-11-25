import type { FastifyInstance, InjectOptions } from 'fastify';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

/**
 * M6.8 — public error serialization is a hard security boundary.
 *
 * Every test here drives the REAL application (real global handler, real
 * centralized mapper, real serializer, real logging pipeline) and then
 * makes adversarial assertions about what actually reached the wire:
 * status, content type, and the EXACT key set. Containment tests alone
 * would pass on a native Fastify envelope, so the key allowlist is
 * asserted on every response as well.
 *
 * These suites need no database: they exercise the serialization boundary
 * itself, so they register fault-injection routes on a real app instance
 * rather than depending on live records.
 */

const { buildApp } = await import('./app.js');
const { AppError } = await import('../shared/errors/app-error.js');
const { ErrorCodes } = await import('../shared/errors/error-codes.js');
const { AUTH_FORBIDDEN_DETAIL } = await import('../shared/errors/error-mapper.js');

const ALLOWED_KEYS = ['code', 'detail', 'instance', 'status', 'title', 'type'];

/** Keys that would indicate the boundary was bypassed or a bag was emitted. */
const FORBIDDEN_KEYS = [
  'error',
  'message',
  'name',
  'stack',
  'cause',
  'originalError',
  'internalCode',
  'requestId',
  'timestamp',
  'path',
  'method',
  'url',
  'errors',
  'issues',
  'details',
  'metadata',
  'debug',
  'trace',
  'traceId',
  'prisma',
  'query',
  'sql',
  'meta',
  'target',
  'modelName',
];

type Response = {
  statusCode: number;
  headers: Record<string, string>;
  payload: string;
  json(): Record<string, unknown>;
};

/**
 * The single strongest assertion in this file: whatever the internal error
 * was, the wire carries exactly the approved six fields as
 * application/problem+json, and no forbidden field name appears anywhere.
 */
function expectCanonicalProblem(response: Response, status: number, code: string): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers['content-type']).toContain('application/problem+json');

  const body = response.json();
  expect(Object.keys(body).sort()).toEqual(ALLOWED_KEYS);
  expect(body.status).toBe(status);
  expect(body.code).toBe(code);
  expect(typeof body.type).toBe('string');
  expect(typeof body.title).toBe('string');
  expect(typeof body.detail).toBe('string');
  expect(body.instance).toMatch(/^\/requests\/[A-Za-z0-9_-]+$/);

  // Forbidden fields must be absent from the parsed body. Substring
  // absence is asserted separately and only where the expected public text
  // could not legitimately contain the marker.
  for (const key of FORBIDDEN_KEYS) {
    expect(Object.keys(body)).not.toContain(key);
  }
}

/** No forbidden field name may appear as a JSON key anywhere in the payload. */
function expectNoForbiddenJsonKeys(response: Response): void {
  for (const key of FORBIDDEN_KEYS) {
    expect(response.payload).not.toContain(`"${key}":`);
  }
}

/** Marks that must never appear in any public error body. */
const SECRET_MARKER = 'LEAKMARKER';

/** Deterministic adversarial corpus (M6.8 — no new dependency). */
const HOSTILE_STRINGS: readonly { name: string; value: string }[] = [
  { name: 'quotes', value: `he said "${SECRET_MARKER}" and 'single'` },
  { name: 'json-fragment', value: `{"code":"FORGED","status":200,"${SECRET_MARKER}":"x"}` },
  { name: 'sql', value: `SELECT * FROM "User" WHERE password='${SECRET_MARKER}'` },
  { name: 'jwt', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SIGNATURE-SECRET' },
  { name: 'authorization-header', value: 'Authorization: Bearer SECRET-TOKEN-VALUE' },
  { name: 'filesystem-path', value: '/srv/oxyide/secrets/config.env' },
  { name: 'html', value: '<script>alert(1)</script>' },
  { name: 'newlines', value: `line1\nSet-Cookie: a=b\n${SECRET_MARKER}` },
  { name: 'unicode', value: `é中文\u202e⁦rtl⁩ ${SECRET_MARKER}` },
  { name: 'null-byte', value: `abc\0def${SECRET_MARKER}` },
  { name: 'very-long', value: `${SECRET_MARKER}${'x'.repeat(100000)}` },
];

/**
 * Statuses that must never become the public error status: 1xx/2xx/3xx
 * (a success or redirect carrying an error body), 0/negative/NaN, and
 * ≥600. 599 is included deliberately as the last LEGAL error status —
 * the boundary must accept it, proving the guard is a range check.
 */
const HOSTILE_STATUS_CODES: readonly number[] = [
  0, 1, 99, 100, 200, 201, 301, 302, 599, 600, 99999, -1, Number.NaN,
];

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ loggerStream: { write: () => true } });
  registerFaultRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

/**
 * Every entry declares the exact public contract expected for that thrown
 * value. Registering the expectation beside the fault keeps the two from
 * drifting: adding a hostile case forces an explicit decision about what
 * the wire must show, rather than asserting only that nothing exploded.
 */
function registerFaultRoutes(target: FastifyInstance): void {
  // ── Unknown / internal errors carrying sensitive text ──────────────────
  const internalCases: ReadonlyArray<{ name: string; factory: () => unknown }> = [
    { name: 'unknown-error', factory: () => new Error(`database password=${SECRET_MARKER}`) },
    { name: 'filesystem-path', factory: () => new Error('/srv/oxyide/secrets/config.env') },
    {
      name: 'sql',
      factory: () => new Error(`SELECT * FROM users WHERE email='attacker@${SECRET_MARKER}.com'`),
    },
    { name: 'authorization', factory: () => new Error('Authorization: Bearer secret-token') },
    { name: 'refresh-token', factory: () => new Error(`refreshToken=${SECRET_MARKER}`) },
    {
      name: 'authz-vocabulary',
      factory: () => new Error(`role=admin permission=users:delete ${SECRET_MARKER}`),
    },
    {
      name: 'enumerable-secret',
      factory: () => Object.assign(new Error('safe'), { secret: SECRET_MARKER }),
    },
    {
      name: 'enumerable-authorization',
      factory: () => Object.assign(new Error('safe'), { authorization: 'Bearer SECRET' }),
    },
    { name: 'enumerable-stack', factory: () => Object.assign(new Error('safe'), { stack: SECRET_MARKER }) },
    {
      name: 'cause',
      factory: () =>
        Object.assign(new Error('safe'), { cause: new Error(`nested ${SECRET_MARKER}`) }),
    },
    {
      name: 'prisma-validation',
      factory: () =>
        new Prisma.PrismaClientValidationError(
          `Argument email for data.email is missing ${SECRET_MARKER}`,
          { clientVersion: '6.12.0' },
        ),
    },
    {
      name: 'prisma-p2002',
      factory: () =>
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields', {
          code: 'P2002',
          clientVersion: '6.12.0',
          meta: {
            modelName: 'User',
            target: ['email'],
            sql: `SELECT * FROM "User" WHERE password = '${SECRET_MARKER}'`,
          },
        }),
    },
    {
      name: 'prisma-p2024',
      factory: () =>
        new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection', {
          code: 'P2024',
          clientVersion: '6.12.0',
          meta: { connectionString: `postgresql://u:p@h/${SECRET_MARKER}` },
        }),
    },
    {
      name: 'prisma-p2025',
      factory: () =>
        new Prisma.PrismaClientKnownRequestError('An operation failed because it depends', {
          code: 'P2025',
          clientVersion: '6.12.0',
        }),
    },
    {
      name: 'prisma-unknown-known-request',
      factory: () =>
        new Prisma.PrismaClientKnownRequestError(`rust exploded ${SECRET_MARKER}`, {
          code: 'P9999',
          clientVersion: '6.12.0',
        }),
    },
    {
      name: 'prisma-unknown-request',
      factory: () =>
        new Prisma.PrismaClientUnknownRequestError(`rust exploded ${SECRET_MARKER}`, {
          clientVersion: '6.12.0',
        }),
    },
    {
      name: 'prisma-initialization',
      factory: () =>
        new Prisma.PrismaClientInitializationError(
          `Cannot connect ${SECRET_MARKER}`,
          '6.12.0',
        ),
    },
    {
      name: 'prisma-like-duck-type',
      factory: () => ({ code: 'P2002', message: `SELECT ${SECRET_MARKER}` }),
    },
    {
      name: 'circular',
      factory: () => {
        const err = new Error(`circular ${SECRET_MARKER}`) as Error & { self?: unknown };
        err.self = err;
        return err;
      },
    },
    {
      name: 'custom-toJSON',
      factory: () =>
        Object.assign(new Error('safe'), {
          toJSON: () => ({ secret: SECRET_MARKER, stack: SECRET_MARKER }),
        }),
    },
    {
      name: 'custom-toString',
      factory: () => Object.assign(new Error('safe'), { toString: () => SECRET_MARKER }),
    },
    { name: 'giant-enumerable', factory: () => Object.assign(new Error('safe'), { blob: SECRET_MARKER.repeat(20000) }) },
    {
      name: 'nested-errors',
      factory: () =>
        Object.assign(new Error('safe'), { inner: new Error(`inner ${SECRET_MARKER}`) }),
    },
    {
      name: 'throwing-getter-code',
      factory: () => ({
        get code(): string {
          throw new Error(`getter-boom ${SECRET_MARKER}`);
        },
      }),
    },
    // A hostile message reader on an otherwise well-formed framework
    // error: classification keeps the approved static 400 rather than
    // failing, and never reads the throwing getter.
    {
      name: 'throwing-getter-message',
      factory: () => ({
        statusCode: 400,
        code: 'FST_ERR_VALIDATION',
        get message(): string {
          throw new Error(`message-boom ${SECRET_MARKER}`);
        },
      }),
    },
    {
      name: 'proxy',
      factory: () =>
        new Proxy(
          {},
          {
            get(_target, property) {
              if (property === Symbol.toStringTag) return 'Error';
              throw new Error(`proxy-boom ${SECRET_MARKER}`);
            },
          },
        ),
    },
    { name: 'proto-pollution', factory: () => Object.assign(new Error('safe'), { __proto__: { polluted: true } }) },
    { name: 'constructor-manipulation', factory: () => ({ constructor: { prototype: SECRET_MARKER } }) },
    { name: 'non-string-message', factory: () => ({ message: { nested: SECRET_MARKER }, statusCode: 400 }) },
    { name: 'string-throw', factory: () => `string-throw ${SECRET_MARKER}` },
    { name: 'number-throw', factory: () => 42 },
    { name: 'null-throw', factory: () => null },
    { name: 'undefined-throw', factory: () => undefined },
    { name: 'object-throw', factory: () => ({ detail: SECRET_MARKER }) },
  ];

  for (const testCase of internalCases) {
    target.get(`/__m68__/throw/${testCase.name}`, async () => {
      throw testCase.factory();
    });
  }

  // ── Malicious status / code / title / type / instance ─────────────────
  HOSTILE_STATUS_CODES.forEach((statusCode, index) => {
    target.get(`/__m68__/status/app-${index}`, async () => {
      throw new AppError(ErrorCodes.BAD_REQUEST, statusCode, `detail ${SECRET_MARKER}`);
    });
    target.get(`/__m68__/status/obj-${index}`, async () => {
      throw { statusCode };
    });
    target.get(`/__m68__/status/alt-${index}`, async () => {
      throw { status: statusCode };
    });
  });

  // A valid 4xx that the mapper must still honour (no over-blocking).
  target.get('/__m68__/status/valid-404', async () => {
    throw new AppError(ErrorCodes.USERS_NOT_FOUND, 404, 'User not found.');
  });

  // ── Malicious code / type / title / detail on AppError ────────────────
  const hostileCodes = ['../../evil type', 'NOT_A_REAL_CODE', '', 'constructor', '__proto__'];
  hostileCodes.forEach((code, index) => {
    target.get(`/__m68__/code/${index}`, async () => {
      throw new AppError(code, 403, `detail ${SECRET_MARKER}`, { title: `Forbidden ${SECRET_MARKER}` });
    });
  });

  // ── Hostile detail / title values (non-string, empty) ─────────────────
  target.get('/__m68__/detail/object', async () => {
    const error = new AppError(ErrorCodes.BAD_REQUEST, 400, 'safe');
    Object.defineProperty(error, 'detail', { value: { nested: SECRET_MARKER } });
    throw error;
  });
  target.get('/__m68__/detail/array', async () => {
    const error = new AppError(ErrorCodes.BAD_REQUEST, 400, 'safe');
    Object.defineProperty(error, 'detail', { value: [SECRET_MARKER] });
    throw error;
  });
  target.get('/__m68__/detail/empty', async () => {
    throw new AppError(ErrorCodes.BAD_REQUEST, 400, '');
  });
  target.get('/__m68__/title/empty', async () => {
    const error = new AppError(ErrorCodes.BAD_REQUEST, 400, 'safe');
    Object.defineProperty(error, 'title', { value: '' });
    throw error;
  });
  target.get('/__m68__/title/object', async () => {
    const error = new AppError(ErrorCodes.BAD_REQUEST, 400, 'safe');
    Object.defineProperty(error, 'title', { value: { nested: SECRET_MARKER } });
    throw error;
  });
  target.get('/__m68__/status/getter', async () => {
    const error = new AppError(ErrorCodes.BAD_REQUEST, 400, 'safe');
    Object.defineProperty(error, 'statusCode', {
      get() {
        throw new Error(`status-boom ${SECRET_MARKER}`);
      },
    });
    throw error;
  });

  // ── Attacker-controlled detail via a real request body ───────────────
  // A service that reflects request data into an AppError detail. This is a
  // caller-side misuse (developer rules forbid it), and the boundary must
  // still hold the shape: the value may appear only as a JSON string field,
  // never as structure and never as an extra field.
  target.post<{ Body: Record<string, unknown> }>('/__m68__/attacker-detail', async (request) => {
    throw new AppError(
      ErrorCodes.BAD_REQUEST,
      400,
      `reflected: ${JSON.stringify(request.body)}`,
      { title: 'Bad Request' },
    );
  });

  // ── Deterministic hostile-string corpus through the real AppError path ─
  HOSTILE_STRINGS.forEach((entry, index) => {
    target.get(`/__m68__/corpus/${index}`, async () => {
      throw new AppError(ErrorCodes.BAD_REQUEST, 400, entry.value, { title: entry.name });
    });
  });
}

async function inject(init: InjectOptions): Promise<Response> {
  return (await app.inject(init)) as unknown as Response;
}

function get(path: string): Promise<Response> {
  return inject({ method: 'GET', url: path });
}

/* ───────────────────────── canonical status matrix ───────────────────── */

describe('M68-INV-002/025: every status emits exactly the approved six fields', () => {
  it('serves a canonical 404 problem for a mapped AppError', async () => {
    const response = await get('/__m68__/status/valid-404');
    expectCanonicalProblem(response, 404, 'USERS_NOT_FOUND');
  });

  it('serves canonical 400, 401, 409, 413, 415, 429, 500 problems', async () => {
    const unauthorized = await inject({ method: 'GET', url: '/api/v1/auth/me' });
    expectCanonicalProblem(unauthorized, 401, 'AUTH_INVALID_TOKEN');
    expect(unauthorized.headers['www-authenticate']).toBeDefined();

    const conflictEmail = `m68-conflict-${Date.now()}-${SECRET_MARKER}@example.com`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: conflictEmail, password: 'correct-horse-battery-staple' },
    });
    const conflict = await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: conflictEmail, password: 'correct-horse-battery-staple' },
    });
    expectCanonicalProblem(conflict, 409, 'USERS_EMAIL_TAKEN');

    const malformed = await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken":',
    });
    expectCanonicalProblem(malformed, 400, 'MALFORMED_JSON');

    const oversized = await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: `big-${Date.now()}@example.com`,
        password: 'correct-horse-battery-staple',
        displayName: 'x'.repeat(1024 * 1024 + 2048),
      }),
    });
    expectCanonicalProblem(oversized, 413, 'BODY_TOO_LARGE');

    const mediaType = await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': `application/x-evil-${SECRET_MARKER}` },
      payload: 'x',
    });
    expectCanonicalProblem(mediaType, 415, 'UNSUPPORTED_MEDIA_TYPE');

    const throttleEmail = `m68-throttle-${SECRET_MARKER}-${Date.now()}@example.com`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        payload: { email: throttleEmail },
      });
    }
    const throttled = await inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      payload: { email: throttleEmail },
    });
    expectCanonicalProblem(throttled, 429, 'AUTH_TOO_MANY_ATTEMPTS');

    const internal = await get('/__m68__/throw/unknown-error');
    expectCanonicalProblem(internal, 500, 'INTERNAL_ERROR');
  });

  it('serves the unknown-route 404 through the same contract', async () => {
    const response = await inject({ method: 'GET', url: '/__m68__/no-such-route' });
    expectCanonicalProblem(response, 404, 'NOT_FOUND');
  });

  it('serves a validation 400 with a value-free detail', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: `not-an-email-${SECRET_MARKER}`, password: 'x', [`extra${SECRET_MARKER}`]: 'x' },
    });
    expectCanonicalProblem(response, 400, 'VALIDATION_FAILED');
    expect(response.payload).not.toContain(SECRET_MARKER);
  });
});

/* ───────────────────────── unknown-error hardening ───────────────────── */

describe('M68-INV-003/004/005/006/007/008/009/017: internal content never crosses', () => {
  const CASES: ReadonlyArray<{ name: string; status: number; code: string }> = [
    { name: 'unknown-error', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'filesystem-path', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'sql', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'authorization', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'refresh-token', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'authz-vocabulary', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'enumerable-secret', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'enumerable-authorization', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'enumerable-stack', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'cause', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'prisma-p2002', status: 409, code: 'CONFLICT' },
    { name: 'prisma-p2024', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'prisma-p2025', status: 404, code: 'NOT_FOUND' },
    { name: 'prisma-unknown-known-request', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'prisma-unknown-request', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'prisma-initialization', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'prisma-like-duck-type', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'prisma-validation', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'circular', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'custom-toJSON', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'custom-toString', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'giant-enumerable', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'nested-errors', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'throwing-getter-code', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'throwing-getter-message', status: 400, code: 'VALIDATION_FAILED' },
    { name: 'proxy', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'proto-pollution', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'constructor-manipulation', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'non-string-message', status: 400, code: 'BAD_REQUEST' },
    { name: 'string-throw', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'number-throw', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'null-throw', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'undefined-throw', status: 500, code: 'INTERNAL_ERROR' },
    { name: 'object-throw', status: 500, code: 'INTERNAL_ERROR' },
  ];

  for (const testCase of CASES) {
    it(`sanitizes ${testCase.name} into the canonical ${testCase.status}`, async () => {
      const response = await get(`/__m68__/throw/${testCase.name}`);
      expectCanonicalProblem(response, testCase.status, testCase.code);
      expectNoForbiddenJsonKeys(response);
      expect(response.payload).not.toContain(SECRET_MARKER);
      expect(response.payload).not.toContain('SELECT');
      expect(response.payload).not.toContain('127.0.0.1');
      expect(response.payload).not.toContain('node_modules');
      expect(response.payload).not.toContain('/srv/');
      expect(response.payload).not.toContain('Bearer');
      expect(response.payload).not.toContain('users:delete');
      expect(response.payload).not.toContain('at Object.');
      expect(response.payload).not.toContain('.ts:');
    });
  }

  it('never pollutes Object.prototype from a thrown value', async () => {
    await get('/__m68__/throw/proto-pollution');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).statusCode).toBeUndefined();
  });
});

/* ───────────────── status / code / title / type integrity ───────────── */

describe('M68-INV-011/012/013/014: public metadata is server-controlled', () => {
  it('refuses non-error and out-of-range AppError status codes', async () => {
    // HOSTILE_STATUSES covers 1xx/2xx/3xx/≥600/0/negative/NaN. 599 is the
    // last legal error status and must be honoured, proving the guard is
    // a range check rather than a blanket rejection.
    for (const index of HOSTILE_STATUS_CODES.map((_, position) => position)) {
      if (index === HOSTILE_STATUS_CODES.indexOf(599)) {
        const legal = await get(`/__m68__/status/app-${index}`);
        expectCanonicalProblem(legal, 599, 'BAD_REQUEST');
        continue;
      }
      const response = await get(`/__m68__/status/app-${index}`);
      expectCanonicalProblem(response, 500, 'INTERNAL_ERROR');
      expect(response.payload).not.toContain(SECRET_MARKER);
    }
  });

  it('refuses non-error status codes carried on plain objects', async () => {
    for (const index of HOSTILE_STATUS_CODES.map((_, position) => position)) {
      if (index === HOSTILE_STATUS_CODES.indexOf(599)) {
        continue;
      }
      const fromStatusCode = await get(`/__m68__/status/obj-${index}`);
      expectCanonicalProblem(fromStatusCode, 500, 'INTERNAL_ERROR');
      const fromStatus = await get(`/__m68__/status/alt-${index}`);
      expectCanonicalProblem(fromStatus, 500, 'INTERNAL_ERROR');
    }
  });

  it('refuses unregistered codes, so type can never be attacker-shaped', async () => {
    for (let index = 0; index < 5; index += 1) {
      const response = await get(`/__m68__/code/${index}`);
      expectCanonicalProblem(response, 500, 'INTERNAL_ERROR');
      const type = response.json().type as string;
      expect(type).toBe('https://docs.oxyide.com/errors/internal-error');
      expect(response.payload).not.toContain('evil');
      expect(response.payload).not.toContain(SECRET_MARKER);
    }
  });

  it('refuses non-string and empty detail/title values', async () => {
    for (const path of [
      '/__m68__/detail/object',
      '/__m68__/detail/array',
      '/__m68__/detail/empty',
      '/__m68__/title/empty',
      '/__m68__/title/object',
      '/__m68__/status/getter',
    ]) {
      const response = await get(path);
      expectCanonicalProblem(response, 500, 'INTERNAL_ERROR');
      expect(response.payload).not.toContain(SECRET_MARKER);
      expect(typeof response.json().detail).toBe('string');
      expect(typeof response.json().title).toBe('string');
    }
  });

  it('never lets request data choose the public detail', async () => {
    const response = await inject({
      method: 'POST',
      url: '/__m68__/attacker-detail',
      payload: { evil: SECRET_MARKER, nested: { deep: SECRET_MARKER } },
    });
    // Reflected text stays inside the single `detail` string field: the
    // body is still one JSON document with exactly the approved keys, so
    // nothing the caller sent becomes structure or a new field.
    expectCanonicalProblem(response, 400, 'BAD_REQUEST');
    expect(response.json().detail).toContain(SECRET_MARKER);
    expect(response.payload.split('\n')).toHaveLength(1);
    expect(JSON.parse(response.payload)).toEqual(response.json());
  });
});

/* ────────────────────── hostile string corpus ───────────────────────── */

describe('M68-INV-022: adversarial strings cannot break the envelope', () => {
  for (const [index, entry] of HOSTILE_STRINGS.entries()) {
    it(`holds the contract for the ${entry.name} corpus entry`, async () => {
      const response = await get(`/__m68__/corpus/${index}`);
      expectCanonicalProblem(response, 400, 'BAD_REQUEST');
      expect(response.json().detail).toBe(entry.value);
      expect(response.json().title).toBe(entry.name);
      // One JSON document: control characters stay inside their field.
      expect(response.payload.split('\n')).toHaveLength(1);
      expect(JSON.parse(response.payload)).toEqual(response.json());
    });
  }
});

/* ──────────────── request-ID / instance integrity ───────────────────── */

describe('M68-INV-015/016/027: instance derives only from the request ID', () => {
  it('rejects a client-supplied X-Request-ID', async () => {
    const response = await inject({
      method: 'GET',
      url: '/__m68__/throw/unknown-error',
      headers: { 'x-request-id': `attacker/${SECRET_MARKER}?a=b` },
    });
    const instance = response.json().instance as string;
    expect(instance).toMatch(/^\/requests\/[A-Za-z0-9_-]+$/);
    expect(instance).not.toContain(SECRET_MARKER);
    expect(response.headers['x-request-id']).toBe(instance.replace('/requests/', ''));
    expect(response.headers['x-request-id']).not.toContain('attacker');
  });

  it('keeps header, instance, and one error log line in agreement', async () => {
    const lines: string[] = [];
    const scoped = await buildApp({ loggerStream: { write: (line: string) => (lines.push(line), true) } });
    scoped.get('/__m68__/throw/unknown-error', async () => {
      throw new Error(`boom ${SECRET_MARKER}`);
    });
    await scoped.ready();
    const response = await scoped.inject({ method: 'GET', url: '/__m68__/throw/unknown-error' });
    const instance = response.json().instance as string;
    expect(response.headers['x-request-id']).toBe(instance.replace('/requests/', ''));

    const errorLines = lines.filter((line) => line.includes('"level":50'));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain(`"reqId":"${instance.replace('/requests/', '')}"`);
    // M6.8: the operator log keeps the diagnostic; the wire does not.
    expect(lines.join('')).toContain(SECRET_MARKER);
    expect(response.payload).not.toContain(SECRET_MARKER);
    await scoped.close();
  });

  it('assigns a distinct instance per occurrence and carries no PII', async () => {
    const first = await get('/__m68__/throw/unknown-error');
    const second = await get('/__m68__/throw/unknown-error');
    expect(first.json().instance).not.toBe(second.json().instance);
  });

  it('emits no requestId field in the body', async () => {
    const response = await get('/__m68__/throw/unknown-error');
    expect(Object.keys(response.json())).not.toContain('requestId');
  });
});

/* ────────────────── authorization leakage (403) ─────────────────────── */

describe('M68-INV-010: 403 details carry no internal authorization vocabulary', () => {
  it('publishes only the centralized generic detail', async () => {
    expect(AUTH_FORBIDDEN_DETAIL).toBe('You do not have permission to perform this action.');
    // The public 403 detail must not name a role, a permission identifier, a
    // policy, a route, a resource identifier, or a subject-existence fact.
    // The bare English word "permission" is expected in the sentence; what
    // must never appear is the internal vocabulary — permission identifiers,
    // quoted role names, and service reason phrasing.
    for (const forbidden of [
      'users:',
      'roles:',
      "Role '",
      'admin',
      'Unknown role',
      'Required role',
      'User not found',
      'Policy denied',
      'canDeleteUser',
      "does not have permission '",
    ]) {
      expect(AUTH_FORBIDDEN_DETAIL).not.toContain(forbidden);
    }
  });
});