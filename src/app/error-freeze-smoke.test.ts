import type { FastifyInstance, InjectOptions } from 'fastify';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

/**
 * M6.10 — final freeze smoke suite.
 *
 * A compact, DB-free end-to-end pass over the frozen M6 contract: every
 * case drives the REAL application boundary (route → handler → mapper →
 * serializer → wire) and asserts the canonical six-field
 * `application/problem+json` response. This suite is the permanent
 * freeze guard — if a future change breaks any frozen behavior here, the
 * freeze record names exactly which contract moved.
 */

const { buildApp } = await import('./app.js');
const { AppError } = await import('../shared/errors/app-error.js');
const { ErrorCodes } = await import('../shared/errors/error-codes.js');
const { AUTH_FORBIDDEN_DETAIL } = await import('../shared/errors/error-mapper.js');

const ALLOWED_KEYS = ['code', 'detail', 'instance', 'status', 'title', 'type'];
const MARKER = 'M10FREEZE';

type Response = {
  statusCode: number;
  headers: Record<string, string>;
  payload: string;
  json(): Record<string, unknown>;
};

function expectFrozenContract(response: Response, status: number, code: string): void {
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
  for (const absent of ['error', 'message', 'stack', 'cause', 'requestId', 'details', 'metadata', 'debug', 'traceId', 'internalCode']) {
    expect(Object.keys(body)).not.toContain(absent);
  }
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ loggerStream: { write: () => true } });

  app.get('/__m10__/app-400', async () => {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 400, 'The request failed validation.', {
      title: 'Bad Request',
    });
  });
  app.get('/__m10__/app-403', async () => {
    throw new AppError(ErrorCodes.AUTH_FORBIDDEN, 403, AUTH_FORBIDDEN_DETAIL, {
      title: 'Forbidden',
    });
  });
  app.get('/__m10__/app-404', async () => {
    throw new AppError(ErrorCodes.USERS_NOT_FOUND, 404, 'User not found.');
  });
  app.get('/__m10__/app-409', async () => {
    throw new AppError(ErrorCodes.USERS_EMAIL_TAKEN, 409, 'A user with this email already exists.');
  });
  app.get('/__m10__/app-413', async () => {
    throw new AppError(ErrorCodes.BODY_TOO_LARGE, 413, 'The request body is too large.', {
      title: 'Payload Too Large',
    });
  });
  app.get('/__m10__/app-415', async () => {
    throw new AppError(
      ErrorCodes.UNSUPPORTED_MEDIA_TYPE,
      415,
      'Unsupported Media Type. Use application/json.',
      { title: 'Unsupported Media Type' },
    );
  });
  app.get('/__m10__/app-429', async () => {
    throw new AppError(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS, 429, 'Too many attempts. Try again later.');
  });
  app.get('/__m10__/boom', async () => {
    throw new Error(`unexpected ${MARKER} password=hunter2 SELECT * FROM "User"`);
  });
  app.get('/__m10__/prisma-unknown', async () => {
    throw new Prisma.PrismaClientUnknownRequestError(`engine failed ${MARKER}`, {
      clientVersion: '6.12.0',
    });
  });
  app.get('/__m10__/hostile', async () => {
    throw new Proxy(
      {},
      {
        get(_target, property) {
          if (property === Symbol.toStringTag) return 'Error';
          throw new Error(`proxy-boom ${MARKER}`);
        },
      },
    );
  });
  app.get('/__m10__/bad-status', async () => {
    throw new AppError(ErrorCodes.BAD_REQUEST, 99999, 'x');
  });
  app.get('/__m10__/bad-code', async () => {
    throw new AppError('../../evil-type', 400, 'x');
  });
  app.get('/__m10__/bad-detail', async () => {
    const error = new AppError(ErrorCodes.BAD_REQUEST, 400, 'safe');
    Object.defineProperty(error, 'detail', { value: { forged: MARKER } });
    return error;
  });
  app.get('/__m10__/bad-title', async () => {
    const error = new AppError(ErrorCodes.BAD_REQUEST, 400, 'safe');
    Object.defineProperty(error, 'title', { value: 42 });
    throw error;
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

describe('M6.10 freeze smoke: canonical statuses', () => {
  it('1. normal 400', async () => {
    expectFrozenContract(await get('/__m10__/app-400'), 400, 'VALIDATION_FAILED');
  });
  it('2. normal 401 (live missing-auth)', async () => {
    const response = await get('/api/v1/auth/me');
    expectFrozenContract(response, 401, 'AUTH_INVALID_TOKEN');
    expect(response.headers['www-authenticate']).toBeDefined();
  });
  it('3. normal 403', async () => {
    expectFrozenContract(await get('/__m10__/app-403'), 403, 'AUTH_FORBIDDEN');
  });
  it('4. normal 404 (unknown route + mapped)', async () => {
    expectFrozenContract(await get('/__m10__/no-such-route'), 404, 'NOT_FOUND');
    expectFrozenContract(await get('/__m10__/app-404'), 404, 'USERS_NOT_FOUND');
  });
  it('5. normal 409', async () => {
    expectFrozenContract(await get('/__m10__/app-409'), 409, 'USERS_EMAIL_TAKEN');
  });
  it('6. normal 413', async () => {
    expectFrozenContract(await get('/__m10__/app-413'), 413, 'BODY_TOO_LARGE');
  });
  it('7. normal 415', async () => {
    expectFrozenContract(await get('/__m10__/app-415'), 415, 'UNSUPPORTED_MEDIA_TYPE');
  });
  it('8. normal 429', async () => {
    expectFrozenContract(await get('/__m10__/app-429'), 429, 'AUTH_TOO_MANY_ATTEMPTS');
  });
  it('9. unexpected 500 sanitized', async () => {
    const response = await get('/__m10__/boom');
    expectFrozenContract(response, 500, 'INTERNAL_ERROR');
    expect(response.payload).not.toContain(MARKER);
    expect(response.payload).not.toContain('hunter2');
    expect(response.payload).not.toContain('SELECT');
  });
});

describe('M6.10 freeze smoke: mapping + security boundary', () => {
  it('10. unknown Error → 500', async () => {
    expectFrozenContract(await get('/__m10__/boom'), 500, 'INTERNAL_ERROR');
  });
  it('11. Prisma unknown error → 500', async () => {
    const response = await get('/__m10__/prisma-unknown');
    expectFrozenContract(response, 500, 'INTERNAL_ERROR');
    expect(response.payload).not.toContain(MARKER);
  });
  it('12. hostile object → canonical 500, never native', async () => {
    const response = await get('/__m10__/hostile');
    expectFrozenContract(response, 500, 'INTERNAL_ERROR');
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.payload).not.toContain(MARKER);
    expect(response.payload).not.toContain('proxy-boom');
  });
  it('13. malicious status fails closed', async () => {
    expectFrozenContract(await get('/__m10__/bad-status'), 500, 'INTERNAL_ERROR');
  });
  it('14. malicious code fails closed with internal type', async () => {
    const response = await get('/__m10__/bad-code');
    expectFrozenContract(response, 500, 'INTERNAL_ERROR');
    expect(response.json().type).toBe('https://docs.oxyide.com/errors/internal-error');
    expect(response.payload).not.toContain('evil');
  });
  it('15. malicious detail fails closed as string body', async () => {
    const response = await get('/__m10__/bad-detail');
    expectFrozenContract(response, 500, 'INTERNAL_ERROR');
    expect(typeof response.json().detail).toBe('string');
  });
  it('16. malicious title fails closed', async () => {
    expectFrozenContract(await get('/__m10__/bad-title'), 500, 'INTERNAL_ERROR');
  });
  it('17. malicious type cannot be shaped (covered by 14)', async () => {
    // `type` derives solely from registered codes; case 14 proves a
    // hostile code yields the fixed internal-error type URI.
    const response = await get('/__m10__/bad-code');
    expect(response.json().type).toBe('https://docs.oxyide.com/errors/internal-error');
  });
  it('18. forged request ID rejected', async () => {
    const response = await inject({
      method: 'GET',
      url: '/__m10__/boom',
      headers: { 'x-request-id': `forged/${MARKER}` },
    });
    const instance = response.json().instance as string;
    expect(instance).toMatch(/^\/requests\/[A-Za-z0-9_-]+$/);
    expect(instance).not.toContain('forged');
    expect(instance).not.toContain(MARKER);
  });
  it('19. concurrent errors isolated with distinct IDs', async () => {
    const paths = ['/__m10__/app-400', '/__m10__/app-403', '/__m10__/boom', '/__m10__/hostile'];
    const responses = (await Promise.all(
      paths.map((url) => app.inject({ method: 'GET', url })),
    )) as unknown as Response[];
    const instances = new Set<string>();
    for (const response of responses) {
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(Object.keys(response.json()).sort()).toEqual(ALLOWED_KEYS);
      expect(response.payload).not.toContain(MARKER);
      instances.add(response.json().instance as string);
    }
    expect(instances.size).toBe(paths.length);
  });
  it('20. 403 vocabulary absent', async () => {
    const response = await get('/__m10__/app-403');
    expect(response.json().detail).toBe(AUTH_FORBIDDEN_DETAIL);
    for (const vocabulary of ['users:', 'roles:', "Role '", "'user'", 'canDeleteUser', 'Required role', 'does not have permission']) {
      expect(response.payload).not.toContain(vocabulary);
    }
  });
  it('21. exact response keys', async () => {
    for (const path of ['/__m10__/app-400', '/__m10__/boom', '/__m10__/no-such-route']) {
      expect(Object.keys((await get(path)).json()).sort()).toEqual(ALLOWED_KEYS);
    }
  });
  it('22. Content-Type on every error', async () => {
    for (const path of ['/__m10__/app-400', '/__m10__/app-403', '/__m10__/boom', '/__m10__/hostile']) {
      expect((await get(path)).headers['content-type']).toContain('application/problem+json');
    }
  });
  it('23. public/log separation', async () => {
    const lines: string[] = [];
    const scoped = await buildApp({
      loggerStream: {
        write: (line: string) => {
          lines.push(line);
          return true;
        },
      },
    });
    scoped.get('/__m10__/scoped-boom', async () => {
      throw new Error(`scoped ${MARKER}`);
    });
    await scoped.ready();
    const response = (await scoped.inject({ method: 'GET', url: '/__m10__/scoped-boom' })) as unknown as Response;
    expectFrozenContract(response, 500, 'INTERNAL_ERROR');
    expect(response.payload).not.toContain(MARKER);
    const errorLines = lines.filter((line) => line.includes('"level":50'));
    expect(errorLines).toHaveLength(1);
    expect(errorLines.join('')).toContain(MARKER);
    expect(errorLines[0]).toContain(`"reqId":"${(response.json().instance as string).replace('/requests/', '')}"`);
    await scoped.close();
  });
  it('24. native-error bypass impossible', async () => {
    for (const path of ['/__m10__/hostile', '/__m10__/bad-status', '/__m10__/boom']) {
      const response = await get(path);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).not.toHaveProperty('error');
      expect(response.json()).not.toHaveProperty('statusCode');
    }
  });
});
