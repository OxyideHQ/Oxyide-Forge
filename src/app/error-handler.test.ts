import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const RAW_SECRET_MESSAGE = 'RAW_SECRET_DO_NOT_LEAK';
const PRISMA_STYLE_MESSAGE =
  "Can't reach database server at 127.0.0.1:5999\n\nPlease make sure your database server is running at 127.0.0.1:5999.";

type AppInstance = FastifyInstance;

async function buildAppWithErrorRoutes(): Promise<AppInstance> {
  const { buildApp } = await import('./app.js');
  const { AppError } = await import('../shared/errors/app-error.js');
  const { ErrorCodes } = await import('../shared/errors/error-codes.js');

  const app = await buildApp();

  app.get('/__test__/throw-raw', async () => {
    throw new Error(RAW_SECRET_MESSAGE);
  });

  app.get('/__test__/throw-prisma', async () => {
    throw new Error(PRISMA_STYLE_MESSAGE);
  });

  app.get('/__test__/throw-app-error', async () => {
    throw new AppError(ErrorCodes.AUTH_FORBIDDEN, 403, 'Forbidden.');
  });

  app.get('/__test__/throw-409', async () => {
    throw new AppError(ErrorCodes.USERS_EMAIL_TAKEN, 409, 'A user with this email already exists.');
  });

  await app.ready();
  return app;
}

function assertNoLeak(payloadText: string): void {
  expect(payloadText).not.toContain(RAW_SECRET_MESSAGE);
  expect(payloadText).not.toContain('127.0.0.1:5999');
  expect(payloadText).not.toContain("Can't reach database server");
  expect(payloadText).not.toContain('at Object.');
  expect(payloadText).not.toContain('.ts:');
  expect(payloadText).not.toContain('node_modules');
}

describe('global error handler (default environment)', () => {
  let app: AppInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('sanitizes an unexpected raw error into a generic 500', async () => {
    app = await buildAppWithErrorRoutes();

    const response = await app.inject({ method: 'GET', url: '/__test__/throw-raw' });
    const body = response.json();

    expect(response.statusCode).toBe(500);
    expect(body.status).toBe(500);
    expect(body.title).toBe('Internal Server Error');
    expect(body.detail).toBe('An unexpected error occurred. Please try again later.');
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.type).toBe('https://docs.oxyide.com/errors/internal-error');
    expect(response.headers['content-type']).toContain('application/problem+json');
    assertNoLeak(response.payload);
  });

  it('does not leak simulated Prisma/database host and port details', async () => {
    app = await buildAppWithErrorRoutes();

    const response = await app.inject({ method: 'GET', url: '/__test__/throw-prisma' });
    const body = response.json();

    expect(response.statusCode).toBe(500);
    expect(body.code).toBe('INTERNAL_ERROR');
    assertNoLeak(response.payload);
  });

  it('preserves AppError 4xx mappings (403 and 409)', async () => {
    app = await buildAppWithErrorRoutes();

    const forbidden = await app.inject({ method: 'GET', url: '/__test__/throw-app-error' });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe('AUTH_FORBIDDEN');

    const conflict = await app.inject({ method: 'GET', url: '/__test__/throw-409' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('USERS_EMAIL_TAKEN');
  });

  it('keeps validation failures at 400', async () => {
    app = await buildAppWithErrorRoutes();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'not-an-email', password: 'short' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('keeps malformed JSON at 400', async () => {
    app = await buildAppWithErrorRoutes();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": ',
    });

    expect(response.statusCode).toBe(400);
  });

  it('keeps unknown routes at 404', async () => {
    app = await buildAppWithErrorRoutes();

    const response = await app.inject({ method: 'GET', url: '/__test__/does-not-exist' });

    expect(response.statusCode).toBe(404);
  });
});

describe('global error handler (NODE_ENV=production)', () => {
  let app: AppInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('sanitizes raw and Prisma-style errors in production mode', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const baseUrl = (process.env.DATABASE_URL ?? 'postgresql://localhost:5432/oxyide_test').split(
      '?',
    )[0];
    vi.stubEnv('DATABASE_URL', `${baseUrl}?sslmode=require`);
    vi.stubEnv('APP_BASE_URL', 'https://app.example.com');
    vi.resetModules();

    app = await buildAppWithErrorRoutes();

    const raw = await app.inject({ method: 'GET', url: '/__test__/throw-raw' });
    expect(raw.statusCode).toBe(500);
    expect(raw.json().title).toBe('Internal Server Error');
    expect(raw.json().code).toBe('INTERNAL_ERROR');
    assertNoLeak(raw.payload);

    const prisma = await app.inject({ method: 'GET', url: '/__test__/throw-prisma' });
    expect(prisma.statusCode).toBe(500);
    expect(prisma.json().code).toBe('INTERNAL_ERROR');
    assertNoLeak(prisma.payload);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});