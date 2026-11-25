import type { FastifyInstance, InjectOptions } from 'fastify';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

/**
 * M6.9 — final error-architecture regression proof.
 *
 * Where the M6.8 suite proved the serialization boundary against hostile
 * input, this suite proves the architecture as ONE coherent boundary:
 * every error source converges on the single mapper/handler/serializer
 * chain end to end (never just `mapError()` in isolation), concurrent
 * failures stay isolated, a post-reply failure cannot corrupt the
 * process, and the public response stays independent of operator logs.
 *
 * DB-free by design: fault-injection routes on the real application
 * exercise the real global handler, mapper, serializer, request-ID
 * plugin, and logging pipeline. DB-backed paths (duplicate
 * registration, throttle, cross-user 403, expired/stale subjects) are
 * proven by the existing integration suites and referenced in the M6.9
 * matrix rather than duplicated here.
 */

const { buildApp } = await import('./app.js');
const { AppError } = await import('../shared/errors/app-error.js');
const { ErrorCodes } = await import('../shared/errors/error-codes.js');
const { AUTH_FORBIDDEN_DETAIL } = await import('../shared/errors/error-mapper.js');

const ALLOWED_KEYS = ['code', 'detail', 'instance', 'status', 'title', 'type'];
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
];

type Response = {
  statusCode: number;
  headers: Record<string, string>;
  payload: string;
  json(): Record<string, unknown>;
};

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
  for (const key of FORBIDDEN_KEYS) {
    expect(Object.keys(body)).not.toContain(key);
  }
  expect(response.payload).not.toContain('"stack":');
  expect(response.payload).not.toContain('"cause":');
}

/** Marker that must never appear in any public error body in this file. */
const MARKER = 'M69NOMARK';

let app: FastifyInstance;

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('db failed', {
    code,
    clientVersion: '6.12.0',
  });
}

beforeAll(async () => {
  app = await buildApp({ loggerStream: { write: () => true } });

  // ── error-source matrix: one controlled destination per source ─────────
  app.get('/__m69__/app-400', async () => {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 400, 'The request failed validation.', {
      title: 'Bad Request',
    });
  });
  app.get('/__m69__/app-401', async () => {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 401, 'Authentication required.', {
      title: 'Unauthorized',
    });
  });
  app.get('/__m69__/app-403', async () => {
    throw new AppError(ErrorCodes.AUTH_FORBIDDEN, 403, AUTH_FORBIDDEN_DETAIL, {
      title: 'Forbidden',
    });
  });
  app.get('/__m69__/app-404', async () => {
    throw new AppError(ErrorCodes.USERS_NOT_FOUND, 404, 'User not found.');
  });
  app.get('/__m69__/app-409', async () => {
    throw new AppError(ErrorCodes.USERS_EMAIL_TAKEN, 409, 'A user with this email already exists.');
  });
  app.get('/__m69__/app-429', async () => {
    throw new AppError(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS, 429, 'Too many attempts. Try again later.');
  });
  app.get('/__m69__/unknown-error', async () => {
    throw new Error(`boom ${MARKER}`);
  });
  app.get('/__m69__/plain-object-status', async () => {
    throw { statusCode: 400 };
  });
  app.get('/__m69__/plain-object-empty', async () => {
    throw { detail: MARKER };
  });
  for (const [name, value] of [
    ['string', `string-throw ${MARKER}`],
    ['number', 42],
  ] as const) {
    app.get(`/__m69__/primitive-${name}`, async () => {
      throw value;
    });
  }
  app.get('/__m69__/null-throw', async () => {
    throw null;
  });
  app.get('/__m69__/undefined-throw', async () => {
    throw undefined;
  });
  app.get('/__m69__/prisma-p2002', async () => {
    throw knownRequestError('P2002');
  });
  app.get('/__m69__/prisma-p2024', async () => {
    throw knownRequestError('P2024');
  });
  app.get('/__m69__/prisma-p2025', async () => {
    throw knownRequestError('P2025');
  });
  app.get('/__m69__/prisma-unknown', async () => {
    throw new Prisma.PrismaClientUnknownRequestError(`rust exploded ${MARKER}`, {
      clientVersion: '6.12.0',
    });
  });

  // ── adversarial cases ──────────────────────────────────────────────────
  const adversarial: ReadonlyArray<{ name: string; factory: () => unknown }> = [
    { name: 'secret', factory: () => new Error(`password=${MARKER}`) },
    { name: 'token', factory: () => new Error(`token=${MARKER} jwt=eyJhbGciOiJIUzI1NiJ9.x.y`) },
    { name: 'sql', factory: () => new Error(`SELECT * FROM "User" WHERE email='${MARKER}'`) },
    {
      name: 'filesystem',
      factory: () => new Error(`/srv/oxyide/secrets/config.env ${MARKER}`),
    },
    { name: 'env', factory: () => new Error(`JWT_SECRET=${MARKER} DATABASE_URL=postgres://u:p@h/db`) },
    {
      name: 'headers',
      factory: () => new Error(`Authorization: Bearer ${MARKER}; Cookie: session=${MARKER}`),
    },
    {
      name: 'stack-trace',
      factory: () => new Error(`at Object.<anonymous> (/app/dist/x.js:1:1) ${MARKER}`),
    },
    {
      name: 'nested-cause',
      factory: () => Object.assign(new Error('outer'), { cause: new Error(`inner ${MARKER}`) }),
    },
    {
      name: 'enumerable-secret',
      factory: () => Object.assign(new Error('safe'), { passwordHash: MARKER }),
    },
    { name: 'malicious-status', factory: () => new AppError(ErrorCodes.BAD_REQUEST, 99999, 'x') },
    { name: 'malicious-code', factory: () => new AppError('../../evil', 400, 'x') },
    {
      name: 'malicious-title',
      factory: () => {
        const error = new AppError(ErrorCodes.BAD_REQUEST, 400, 'safe');
        Object.defineProperty(error, 'title', { value: { forged: MARKER } });
        return error;
      },
    },
    {
      name: 'malicious-detail',
      factory: () => {
        const error = new AppError(ErrorCodes.BAD_REQUEST, 400, 'safe');
        Object.defineProperty(error, 'detail', { value: [MARKER] });
        return error;
      },
    },
    {
      name: 'circular',
      factory: () => {
        const error = new Error(`circular ${MARKER}`) as Error & { self?: unknown };
        error.self = error;
        return error;
      },
    },
    {
      name: 'throwing-getter',
      factory: () => ({
        get code(): string {
          throw new Error(`getter-boom ${MARKER}`);
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
              throw new Error(`proxy-boom ${MARKER}`);
            },
          },
        ),
    },
    {
      name: 'custom-toJSON',
      factory: () =>
        Object.assign(new Error('safe'), { toJSON: () => ({ leaked: MARKER }) }),
    },
    {
      name: 'non-error-object',
      factory: () => ({ code: 'FST_ERR_VALIDATION', message: `fake ${MARKER}` }),
    },
    { name: 'prisma-like', factory: () => ({ code: 'P2002', message: `SELECT ${MARKER}` }) },
    { name: 'fastify-like', factory: () => ({ code: 'FST_NO_SUCH_CODE', message: MARKER }) },
  ];
  for (const testCase of adversarial) {
    app.get(`/__m69__/adversarial/${testCase.name}`, async () => {
      throw testCase.factory();
    });
  }

  // ── post-reply failure: the handler throws after the reply was sent ───
  app.get('/__m69__/throw-after-send', async (_request, reply) => {
    await reply.status(200).send({ ok: true });
    throw new Error(`late failure ${MARKER}`);
  });

  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

async function inject(init: InjectOptions): Promise<Response> {
  return (await app.inject(init)) as unknown as Response;
}
async function get(path: string): Promise<Response> {
  return inject({ method: 'GET', url: path });
}

/* ─────────────── end-to-end error-source matrix ─────────────── */

describe('M6.9 error-source matrix: one controlled destination per source', () => {
  const CASES: ReadonlyArray<{ path: string; status: number; code: string }> = [
    { path: '/__m69__/app-400', status: 400, code: 'VALIDATION_FAILED' },
    { path: '/__m69__/app-401', status: 401, code: 'AUTH_INVALID_TOKEN' },
    { path: '/__m69__/app-403', status: 403, code: 'AUTH_FORBIDDEN' },
    { path: '/__m69__/app-404', status: 404, code: 'USERS_NOT_FOUND' },
    { path: '/__m69__/app-409', status: 409, code: 'USERS_EMAIL_TAKEN' },
    { path: '/__m69__/app-429', status: 429, code: 'AUTH_TOO_MANY_ATTEMPTS' },
    { path: '/__m69__/unknown-error', status: 500, code: 'INTERNAL_ERROR' },
    { path: '/__m69__/plain-object-status', status: 400, code: 'BAD_REQUEST' },
    { path: '/__m69__/plain-object-empty', status: 500, code: 'INTERNAL_ERROR' },
    { path: '/__m69__/primitive-string', status: 500, code: 'INTERNAL_ERROR' },
    { path: '/__m69__/primitive-number', status: 500, code: 'INTERNAL_ERROR' },
    { path: '/__m69__/null-throw', status: 500, code: 'INTERNAL_ERROR' },
    { path: '/__m69__/undefined-throw', status: 500, code: 'INTERNAL_ERROR' },
    { path: '/__m69__/prisma-p2002', status: 409, code: 'CONFLICT' },
    { path: '/__m69__/prisma-p2024', status: 500, code: 'INTERNAL_ERROR' },
    { path: '/__m69__/prisma-p2025', status: 404, code: 'NOT_FOUND' },
    { path: '/__m69__/prisma-unknown', status: 500, code: 'INTERNAL_ERROR' },
  ];

  for (const testCase of CASES) {
    it(`serves ${testCase.status} ${testCase.code} for ${testCase.path}`, async () => {
      const response = await get(testCase.path);
      expectCanonicalProblem(response, testCase.status, testCase.code);
      expect(response.payload).not.toContain(MARKER);
      // X-Request-ID agrees with the instance suffix on every error.
      const instance = response.json().instance as string;
      expect(response.headers['x-request-id']).toBe(instance.replace('/requests/', ''));
    });
  }

  it('serves real framework errors through the same contract', async () => {
    const malformed = await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken":',
    });
    expectCanonicalProblem(malformed, 400, 'MALFORMED_JSON');

    const validation = await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'not-an-email', password: 'x' },
    });
    expectCanonicalProblem(validation, 400, 'VALIDATION_FAILED');

    const media = await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/x-evil-unknown' },
      payload: 'x',
    });
    expectCanonicalProblem(media, 415, 'UNSUPPORTED_MEDIA_TYPE');

    const missingAuth = await get('/api/v1/auth/me');
    expectCanonicalProblem(missingAuth, 401, 'AUTH_INVALID_TOKEN');
    expect(missingAuth.headers['www-authenticate']).toBeDefined();

    const unknownRoute = await get('/__m69__/no-such-route');
    expectCanonicalProblem(unknownRoute, 404, 'NOT_FOUND');
  });

  it('publishes the generic 403 detail with no authorization vocabulary', async () => {
    const response = await get('/__m69__/app-403');
    expectCanonicalProblem(response, 403, 'AUTH_FORBIDDEN');
    expect(response.json().detail).toBe(AUTH_FORBIDDEN_DETAIL);
    // Internal vocabulary: identifiers, quoted role names, policy and
    // reason phrasing. The generic sentence's own word "permission" is
    // expected and is not internal vocabulary by itself.
    for (const vocabulary of [
      'users:',
      'roles:',
      "Role '",
      "'user'",
      "'admin'",
      'canDeleteUser',
      'policy denied',
      'Policy denied',
      'Required role',
      'does not have permission',
    ]) {
      expect(response.payload).not.toContain(vocabulary);
    }
  });
});

/* ─────────────── adversarial regression (30 cases) ─────────────── */

describe('M6.9 adversarial regression: hostile input stays inside the contract', () => {
  const NAMES = [
    'secret',
    'token',
    'sql',
    'filesystem',
    'env',
    'headers',
    'stack-trace',
    'nested-cause',
    'enumerable-secret',
    'malicious-status',
    'malicious-code',
    'malicious-title',
    'malicious-detail',
    'circular',
    'throwing-getter',
    'proxy',
    'custom-toJSON',
    'non-error-object',
    'prisma-like',
    'fastify-like',
  ];

  for (const name of NAMES) {
    it(`contains ${name}: canonical problem, marker absent`, async () => {
      const response = await get(`/__m69__/adversarial/${name}`);
      expectCanonicalProblem(response, response.statusCode, response.json().code as string);
      expect(response.payload).not.toContain(MARKER);
      expect(response.payload).not.toContain('getter-boom');
      expect(response.payload).not.toContain('proxy-boom');
      expect(response.payload).not.toContain('SELECT');
      expect(response.payload).not.toContain('Bearer');
      expect(response.payload).not.toContain('/srv/');
    });
  }

  it('never serves a native Fastify envelope for hostile input', async () => {
    for (const name of NAMES) {
      const response = await get(`/__m69__/adversarial/${name}`);
      expect(response.headers['content-type']).toContain('application/problem+json');
    }
  });

  it('rejects a client-supplied instance via X-Request-ID', async () => {
    const response = await inject({
      method: 'GET',
      url: '/__m69__/unknown-error',
      headers: { 'x-request-id': `forged/${MARKER}?a=b` },
    });
    const instance = response.json().instance as string;
    expect(instance).toMatch(/^\/requests\/[A-Za-z0-9_-]+$/);
    expect(instance).not.toContain(MARKER);
    expect(instance).not.toContain('forged');
  });
});

/* ─────────────── concurrency: isolation across statuses ─────────────── */

describe('M6.9 concurrency: simultaneous failures stay isolated', () => {
  it('serves concurrent 400/401/403/404/409/500 with distinct correlated IDs', async () => {
    const paths = [
      '/__m69__/app-400',
      '/__m69__/app-401',
      '/__m69__/app-403',
      '/__m69__/app-404',
      '/__m69__/app-409',
      '/__m69__/unknown-error',
    ];
    const responses = (await Promise.all(
      paths.map((url) => app.inject({ method: 'GET', url })),
    )) as unknown as Response[];
    const expectations = [400, 401, 403, 404, 409, 500];
    const instances = new Set<string>();
    responses.forEach((response, index) => {
      expect(response.statusCode).toBe(expectations[index]);
      expect(response.headers['content-type']).toContain('application/problem+json');
      const instance = response.json().instance as string;
      expect(response.headers['x-request-id']).toBe(instance.replace('/requests/', ''));
      instances.add(instance);
      expect(response.payload).not.toContain(MARKER);
    });
    // Every concurrent failure received its own correlation identity.
    expect(instances.size).toBe(paths.length);
  });

  it('keeps hostile concurrent failures contained', async () => {
    const names = ['throwing-getter', 'proxy', 'circular', 'secret', 'malicious-status'];
    const responses = (await Promise.all(
      names.map((name) => app.inject({ method: 'GET', url: `/__m69__/adversarial/${name}` })),
    )) as unknown as Response[];
    const instances = new Set<string>();
    for (const response of responses) {
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(Object.keys(response.json()).sort()).toEqual(ALLOWED_KEYS);
      expect(response.payload).not.toContain(MARKER);
      instances.add(response.json().instance as string);
    }
    expect(instances.size).toBe(names.length);
  });
});

/* ─────────────── lifecycle: post-reply failure ─────────────── */

describe('M6.9 lifecycle: failures around the reply boundary', () => {
  it('survives a throw after the reply was sent without corrupting traffic', async () => {
    const first = await get('/__m69__/throw-after-send');
    // The original 200 stands: a late throw cannot replace a sent reply.
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    // The process is unaffected: the boundary serves the next request.
    const second = await get('/__m69__/app-404');
    expectCanonicalProblem(second, 404, 'USERS_NOT_FOUND');
    const third = await get('/__m69__/unknown-error');
    expectCanonicalProblem(third, 500, 'INTERNAL_ERROR');
  });
});

/* ─────────────── triangulation: wire vs operator log ─────────────── */

describe('M6.9 triangulation: sanitized wire, diagnostic log', () => {
  it('keeps the marker in exactly one error log line and off the wire', async () => {
    const lines: string[] = [];
    const scoped = await buildApp({
      loggerStream: {
        write: (line: string) => {
          lines.push(line);
          return true;
        },
      },
    });
    scoped.get('/__m69__/scoped-boom', async () => {
      throw new Error(`scoped ${MARKER}`);
    });
    await scoped.ready();

    const response = (await scoped.inject({
      method: 'GET',
      url: '/__m69__/scoped-boom',
    })) as unknown as Response;
    expectCanonicalProblem(response, 500, 'INTERNAL_ERROR');
    expect(response.payload).not.toContain(MARKER);

    const instance = response.json().instance as string;
    const requestId = instance.replace('/requests/', '');
    expect(response.headers['x-request-id']).toBe(requestId);

    const errorLines = lines.filter((line) => line.includes('"level":50'));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain(`"reqId":"${requestId}"`);
    expect(errorLines.join('')).toContain(MARKER);

    // Expected errors stay out of the error log entirely.
    lines.length = 0;
    const expected = (await scoped.inject({
      method: 'GET',
      url: '/no-such-scoped-route',
    })) as unknown as Response;
    expect(expected.statusCode).toBe(404);
    expect(lines.filter((line) => line.includes('"level":50'))).toHaveLength(0);

    await scoped.close();
  });
});
