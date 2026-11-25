import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from './app-error.js';
import { ErrorCodes } from './error-codes.js';
import {
  buildInstance,
  buildProblemBody,
  INTERNAL_ERROR_BODY,
  mapError,
  sendMappedError,
  WWW_AUTHENTICATE,
} from './error-mapper.js';

/**
 * M6.2 — centralized mapper proofs.
 *
 * The mapper is reply-independent (pure classification) except for the
 * single `sendMappedError` builder owned by the global handler. Tests
 * assert the canonical model, the preserved public contract, and that
 * causes/arbitrary properties/hostile values never cross into it.
 */
describe('mapError — AppError', () => {
  it('preserves code, status, and safe message/detail semantics', () => {
    const mapped = mapError(
      new AppError(ErrorCodes.USERS_EMAIL_TAKEN, 409, 'A user with this email already exists.'),
    );

    expect(mapped).toMatchObject({
      kind: 'app',
      statusCode: 409,
      code: 'USERS_EMAIL_TAKEN',
      type: 'https://docs.oxyide.com/errors/users-email-taken',
      title: 'A user with this email already exists.',
      detail: 'A user with this email already exists.',
      expected: true,
    });
  });

  it('preserves explicit title/detail overrides (guard bodies)', () => {
    const mapped = mapError(
      new AppError(ErrorCodes.AUTH_FORBIDDEN, 403, "Role 'user' lacks 'x'.", {
        title: 'Forbidden',
      }),
    );

    expect(mapped).toMatchObject({
      kind: 'app',
      title: 'Forbidden',
      detail: "Role 'user' lacks 'x'.",
    });
  });

  it('attaches WWW-Authenticate for auth 401 codes and nothing else', () => {
    const unauth = mapError(
      new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 401, 'Invalid.', { title: 'Unauthorized' }),
    );
    expect(unauth.kind).toBe('app');
    if (unauth.kind === 'app') {
      expect(unauth.headers).toEqual({ 'WWW-Authenticate': WWW_AUTHENTICATE });
    }

    const expired = mapError(
      new AppError(ErrorCodes.AUTH_TOKEN_EXPIRED, 401, 'Expired.', { title: 'Unauthorized' }),
    );
    if (expired.kind === 'app') {
      expect(expired.headers).toEqual({ 'WWW-Authenticate': WWW_AUTHENTICATE });
    }

    const forbidden = mapError(new AppError(ErrorCodes.AUTH_FORBIDDEN, 403, 'No.'));
    if (forbidden.kind === 'app') {
      expect(forbidden.headers).toEqual({});
    }
  });

  it('marks 5xx AppErrors unexpected (logged) without changing their mapping', () => {
    const mapped = mapError(new AppError(ErrorCodes.BAD_REQUEST, 500, 'Fault.'));
    expect(mapped.kind).toBe('app');
    if (mapped.kind === 'app') {
      expect(mapped.expected).toBe(false);
      expect(mapped.statusCode).toBe(500);
    }
  });
});

describe('mapError — Fastify classification (M6.4)', () => {
  it('maps schema validation to VALIDATION_FAILED preserving the value-free message', () => {
    const validationError = Object.assign(
      new Error("body must have required property 'password'"),
      { statusCode: 400, code: 'FST_ERR_VALIDATION' },
    );
    const mapped = mapError(validationError);
    expect(mapped).toEqual({
      kind: 'app',
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      type: 'https://docs.oxyide.com/errors/validation-failed',
      title: 'Bad Request',
      detail: "body must have required property 'password'",
      headers: {},
      expected: true,
    });
  });

  it('maps malformed and empty JSON bodies to MALFORMED_JSON', () => {
    for (const code of ['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']) {
      const mapped = mapError({ statusCode: 400, code, message: 'whatever parser said' });
      expect(mapped).toMatchObject({
        kind: 'app',
        statusCode: 400,
        code: 'MALFORMED_JSON',
        detail: 'The request body is not valid JSON.',
      });
    }
  });

  it('maps body-limit and media-type errors with static details', () => {
    expect(
      mapError({ statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE', message: 'x'.repeat(5000) }),
    ).toMatchObject({ kind: 'app', statusCode: 413, code: 'BODY_TOO_LARGE' });
    expect(
      mapError({
        statusCode: 415,
        code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
        message: 'Unsupported Media Type: application/x-evil-SECRET',
      }),
    ).toMatchObject({ kind: 'app', statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    const media = mapError({ statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' });
    expect(JSON.stringify(media)).not.toContain('x-evil-SECRET');
  });

  it('preserves the MongoDB-driver status fallback via BAD_REQUEST', () => {
    expect(mapError({ status: 409 })).toMatchObject({
      kind: 'app',
      statusCode: 409,
      code: 'BAD_REQUEST',
    });
  });

  it('maps other sub-500 status-carrying errors to BAD_REQUEST with status preserved', () => {
    expect(mapError({ statusCode: 418, custom: 'whatever' })).toMatchObject({
      kind: 'app',
      statusCode: 418,
      code: 'BAD_REQUEST',
      expected: true,
    });
  });

  it('maps 5xx-shaped errors to sanitized internal', () => {
    expect(mapError({ statusCode: 503 })).toEqual({
      kind: 'internal',
      statusCode: 500,
      expected: false,
    });
  });
});

describe('mapError — unknown errors', () => {
  it('maps unknown Errors to the sanitized internal model', () => {
    const mapped = mapError(new Error('RAW_SECRET_DO_NOT_LEAK'));
    expect(mapped).toEqual({ kind: 'internal', statusCode: 500, expected: false });
  });

  it.each([[undefined], [null], ['boom'], [42], [{ odd: 'shape' }]])(
    'maps non-Error input (%s) to internal without reflecting it',
    (input) => {
      expect(mapError(input)).toEqual({ kind: 'internal', statusCode: 500, expected: false });
    },
  );

  it('never copies causes, stacks, or arbitrary properties', () => {
    const hostile = Object.assign(new Error('boom'), {
      cause: new Error('password=hunter2'),
      password: 'hunter2',
      config: { jwtSecret: 'shh' },
      statusCode: undefined,
    });
    const mapped = mapError(hostile);
    expect(mapped.kind).toBe('internal');
    expect(JSON.stringify(mapped)).not.toContain('hunter2');
    expect(JSON.stringify(mapped)).not.toContain('shh');
    expect(JSON.stringify(mapped)).not.toContain('cause');
  });
});

describe('adversarial serializer boundary (M6.3 focused; M6.8 owns full hardening)', () => {
  it('holds exact shape under giant developer-authored fields', () => {
    const mapped = mapError(
      new AppError(ErrorCodes.BAD_REQUEST, 400, 'd'.repeat(100000), { title: 't'.repeat(100000) }),
    );
    expect(mapped.kind).toBe('app');
    if (mapped.kind === 'app') {
      expect(mapped.title).toHaveLength(100000);
      expect(Object.keys(mapped)).toEqual(
        expect.arrayContaining(['kind', 'statusCode', 'code', 'type', 'title', 'detail', 'headers', 'expected']),
      );
    }
  });

  it('drops hostile extra properties including circular causes and proto keys', () => {
    const hostile = new AppError(ErrorCodes.BAD_REQUEST, 400, 'Bad.');
    Object.assign(hostile, {
      cause: { password: 'hunter2', self: null as unknown },
      token: 'tok',
      __proto__: { polluted: true },
    });
    (hostile as unknown as Record<string, unknown>).cause = hostile;
    const mapped = mapError(hostile);
    expect(mapped.kind).toBe('app');
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('tok');
    expect(serialized).not.toContain('cause');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('serializes hostile detail strings without transformation or breakout', () => {
    const evil = 'x\nSet-Cookie: a=b\x1b[31mred{"code":"FORGED"}';
    const body = buildProblemBody(
      { type: 't', title: 'ti', status: 400, detail: evil, code: 'X' },
      '/requests/req-1',
    );
    expect(Object.keys(body).sort()).toEqual(
      ['code', 'detail', 'instance', 'status', 'title', 'type'].sort(),
    );
    // Single JSON document: newlines/escapes stay inside the string field.
    expect(JSON.stringify(body).split('\n')).toHaveLength(1);
    expect(body.detail).toBe(evil);
  });

  it('buildInstance is total and safe on hostile input', () => {
    expect(buildInstance('req-1')).toBe('/requests/req-1');
    expect(buildInstance('')).toBe('/requests/unknown');
    expect(buildInstance(undefined)).toBe('/requests/unknown');
    expect(buildInstance(null)).toBe('/requests/unknown');
    expect(buildInstance(42)).toBe('/requests/unknown');
    expect(buildInstance({})).toBe('/requests/unknown');
    expect(buildInstance('/etc/passwd')).toBe('/requests//etc/passwd');
  });
});

describe('mapError — Prisma classification (M6.4)', () => {
  function knownRequestError(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('db failed', {
      code,
      clientVersion: '6.12.0',
      meta,
    });
  }

  it('maps escaped P2002 to generic 409 CONFLICT without internals', () => {
    const mapped = mapError(
      knownRequestError('P2002', { modelName: 'User', target: ['email'] }),
    );
    expect(mapped).toMatchObject({
      kind: 'app',
      statusCode: 409,
      code: 'CONFLICT',
      type: 'https://docs.oxyide.com/errors/conflict',
    });
    expect(JSON.stringify(mapped)).not.toContain('User');
    expect(JSON.stringify(mapped)).not.toContain('email');
  });

  it('maps P2024 pool/timeout failures to sanitized 500 (no 503 taxonomy)', () => {
    expect(mapError(knownRequestError('P2024', { connectionString: 'postgresql://u:p@h/db' }))).toEqual(
      { kind: 'internal', statusCode: 500, expected: false },
    );
  });

  it('maps escaped P2025 to generic 404 absence', () => {
    expect(mapError(knownRequestError('P2025'))).toMatchObject({
      kind: 'app',
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('sanitizes unknown Prisma error classes and hostile meta', () => {
    const hostile = knownRequestError('P2002', {
      target: ["password=hunter2', DATABASE_URL=postgresql://u:p@h/db"],
      sql: 'SELECT * FROM "User" WHERE password = \'hunter2\'',
    });
    const mapped = mapError(hostile);
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('DATABASE_URL');
    expect(serialized).not.toContain('SELECT');

    expect(
      mapError(new Prisma.PrismaClientUnknownRequestError('rust exploded', { clientVersion: '6.12.0' })),
    ).toEqual({ kind: 'internal', statusCode: 500, expected: false });
    expect(
      mapError(
        new Prisma.PrismaClientInitializationError('cannot connect', '6.12.0'),
      ),
    ).toEqual({ kind: 'internal', statusCode: 500, expected: false });
  });

  it('does not treat Prisma-like duck types as Prisma errors', () => {
    // Identity is instanceof, not shape: a plain object with a code is
    // handled by the generic status rules, never the Prisma branch.
    expect(mapError({ code: 'P2002', message: 'x' })).toEqual({
      kind: 'internal',
      statusCode: 500,
      expected: false,
    });
  });
});

describe('sendMappedError — single construction site', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it('builds the current AppError envelope byte-for-byte with headers', async () => {
    app.get('/throw-app', async (_request, reply) => {
      sendMappedError(
        reply,
        mapError(
          new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 401, 'Invalid.', {
            title: 'Unauthorized',
          }),
        ),
        '/requests/req-test',
      );
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/throw-app' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(WWW_AUTHENTICATE);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toEqual({
      type: 'https://docs.oxyide.com/errors/auth-invalid-token',
      title: 'Unauthorized',
      status: 401,
      detail: 'Invalid.',
      code: 'AUTH_INVALID_TOKEN',
      instance: '/requests/req-test',
    });
  });

  it('builds the sanitized internal body', async () => {
    app.get('/throw-internal', async (_request, reply) => {
      sendMappedError(reply, mapError(new Error('boom')), '/requests/req-test');
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/throw-internal' });
    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toEqual({ ...INTERNAL_ERROR_BODY, instance: '/requests/req-test' });
  });
});
