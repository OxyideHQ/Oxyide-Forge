import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('./app.js');
const { config } = await import('../config/index.js');

let app: FastifyInstance;
let dbAvailable = false;

const OVER_LIMIT = config.http.bodyLimitBytes + 1024;

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

  app = await buildApp();
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

/**
 * M5.3 — explicit request body limit (live).
 *
 * Proves the transport cap rejects oversized bodies with a sanitized 413
 * before any handler, service, or database work runs, and that security
 * headers still apply to the rejection.
 */
describe('explicit request body limit', () => {
  it(
    'rejects an oversized registration body with 413 and creates nothing',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `oversized-${Date.now()}@example.com`;

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email,
          password: 'correct-horse-battery-staple',
          displayName: 'x'.repeat(OVER_LIMIT),
        }),
      });

      expect(response.statusCode).toBe(413);
      const body = response.json();
      expect(body.code).toBe('BODY_TOO_LARGE');
      expect(JSON.stringify(body)).not.toContain('x'.repeat(100));
      expect(JSON.stringify(body)).not.toContain('passwordHash');
      expect(response.headers['x-content-type-options']).toBe('nosniff');

      // Handler never ran: no user, no credential, no throttle state.
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
      expect(await prisma.loginThrottle.findMany()).toHaveLength(0);
    },
  );

  it(
    'accepts ordinary payloads below the limit unchanged',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `normal-${Date.now()}@example.com`;

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email,
          password: 'correct-horse-battery-staple',
          displayName: 'Normal User',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    },
  );

  it(
    'exposes the configured limits from the canonical config',
    async () => {
      expect(config.http.bodyLimitBytes).toBe(1048576);
      expect(config.http.maxParamLength).toBe(100);
      expect(Object.isFrozen(config.http)).toBe(true);
    },
  );
});
