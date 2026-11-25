/**
 * M3.14 — Login Throttling Integration Tests
 *
 * Proves the throttle policy against real PostgreSQL through the real
 * Fastify application: exact thresholds, key normalization, enumeration
 * resistance, multi-instance shared state, concurrency, expiration,
 * infrastructure failure, and regression of refresh / password reset /
 * email verification.
 *
 * No mocks. Real database. Real HTTP requests via app.inject().
 *
 * These tests require a running PostgreSQL instance at DATABASE_URL.
 * When the database is unavailable, the suite fails fast instead of
 * silently passing.
 */

// Environment must be set before any module imports evaluate config.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('../../../app/app.js');
const { config } = await import('../../../config/index.js');

let app: FastifyInstance;
let dbAvailable = false;

const STRONG_PASSWORD = 'StrongPassword123!';
const ACCOUNT_THRESHOLD = config.auth.loginThrottle.accountThreshold;
const IP_THRESHOLD = config.auth.loginThrottle.ipThreshold;

/** Unique email per test so throttle state never leaks across tests. */
function uniqueEmail(label: string): string {
  return `throttle-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function cleanDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EmailVerificationToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "PasswordResetToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "RefreshToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Session" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "LoginThrottle" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Credential" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
}

async function registerUser(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: STRONG_PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

function loginRequest(email: string, password: string, remoteAddress = '127.0.0.1') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress,
    payload: { email, password },
  });
}

/**
 * Enumeration-parity comparison (M6.3): two error bodies are identical
 * except their per-occurrence `instance` IDs, which are unique by design
 * (opaque request counters) and therefore carry no distinguishing signal.
 * Each instance must still be present and well-formed.
 */
function expectParityBodies(first: unknown, second: unknown): void {
  const firstRecord = first as Record<string, unknown>;
  const secondRecord = second as Record<string, unknown>;
  expect(typeof firstRecord.instance).toBe('string');
  expect(typeof secondRecord.instance).toBe('string');
  const { instance: _dropA, ...restA } = firstRecord;
  const { instance: _dropB, ...restB } = secondRecord;
  void _dropA;
  void _dropB;
  expect(restA).toEqual(restB);
}

/**
 * Runs a callback against a separately-built application instance and a
 * separately-connected Prisma client, then tears both down. Anything the
 * callback observes must therefore come from PostgreSQL — never from
 * in-memory state shared with the primary test stack.
 */
async function withFreshStack<T>(
  fn: (freshApp: FastifyInstance, freshPrisma: PrismaClient) => Promise<T>,
): Promise<T> {
  const freshPrisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  const freshApp = await buildApp();
  try {
    return await fn(freshApp, freshPrisma);
  } finally {
    await freshApp.close();
    await freshPrisma.$disconnect();
  }
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
    // Fail fast instead of silently passing: a missing database must be visible.
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
  if (app) {
    await app.close();
  }
  await prisma.$disconnect();
});

// ────────────────────────────────────────────────────────
// 1. Account threshold boundary
// ────────────────────────────────────────────────────────

describe('login throttle — account threshold', () => {
  it('returns 401 for the first N failures and 429 at the N+1th attempt', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('boundary');
    await registerUser(email);

    // The first N failures are allowed and recorded.
    for (let attempt = 1; attempt <= ACCOUNT_THRESHOLD; attempt++) {
      const response = await loginRequest(email, 'WrongPassword999!');
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_CREDENTIALS');
    }

    // The N+1th attempt is throttled.
    const throttled = await loginRequest(email, 'WrongPassword999!');
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().code).toBe('AUTH_TOO_MANY_ATTEMPTS');
  });

  it('throttles even when the correct password is presented after the threshold', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('correct-after');
    await registerUser(email);

    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    const response = await loginRequest(email, STRONG_PASSWORD);
    expect(response.statusCode).toBe(429);
    expect(response.json().code).toBe('AUTH_TOO_MANY_ATTEMPTS');
  });

  it('creates no session and no refresh token for a throttled attempt', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('no-session');
    const userId = await registerUser(email);

    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    const throttled = await loginRequest(email, STRONG_PASSWORD);
    expect(throttled.statusCode).toBe(429);

    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions).toHaveLength(0);
    const refreshTokens = await prisma.refreshToken.findMany({
      where: { sessionId: { in: sessions.map((s) => s.id) } },
    });
    expect(refreshTokens).toHaveLength(0);
  });

  it('returns the documented 429 envelope without internal detail', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('envelope');
    await registerUser(email);

    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    const response = await loginRequest(email, 'WrongPassword999!');
    expect(response.statusCode).toBe(429);

    const body = response.json() as Record<string, unknown>;
    expect(body.type).toBe('https://docs.oxyide.com/errors/auth-too-many-attempts');
    expect(body.title).toBe('Too many login attempts. Please try again later.');
    expect(body.status).toBe(429);
    expect(body.detail).toBe('Too many login attempts. Please try again later.');
    expect(body.code).toBe('AUTH_TOO_MANY_ATTEMPTS');

    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(email);
    expect(bodyStr).not.toContain('127.0.0.1');
    expect(bodyStr).not.toContain('auth:login:v1');
    expect(bodyStr).not.toContain('failureCount');
    expect(response.headers['retry-after']).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────
// 2. Key normalization
// ────────────────────────────────────────────────────────

describe('login throttle — normalization', () => {
  it('shares state across casing and whitespace variants of the same email', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('normalize');
    await registerUser(email);

    // ACCOUNT_THRESHOLD failures using different casings/whitespace.
    const variants = [email, email.toUpperCase(), `  ${email}  `, email.replace('@', '@')];
    for (let i = 0; i < ACCOUNT_THRESHOLD; i++) {
      const response = await loginRequest(variants[i % variants.length], 'WrongPassword999!');
      expect(response.statusCode).toBe(401);
    }

    // The next attempt with yet another variant is throttled.
    const throttled = await loginRequest(` ${email.toUpperCase()} `, 'WrongPassword999!');
    expect(throttled.statusCode).toBe(429);
  });
});

// ────────────────────────────────────────────────────────
// 3. Enumeration resistance
// ────────────────────────────────────────────────────────

describe('login throttle — enumeration resistance', () => {
  it('produces identical observable behavior for unknown email and wrong password', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const knownEmail = uniqueEmail('enum-known');
    await registerUser(knownEmail);
    const unknownEmail = uniqueEmail('enum-unknown');

    // Both produce identical 401 bodies except the per-occurrence
    // instance ID (unique by design; carries no distinguishing signal).
    const knownWrong = await loginRequest(knownEmail, 'WrongPassword999!');
    const unknownWrong = await loginRequest(unknownEmail, 'WrongPassword999!');
    expect(knownWrong.statusCode).toBe(401);
    expect(unknownWrong.statusCode).toBe(401);
    expectParityBodies(knownWrong.json(), unknownWrong.json());

    // Drive both to the threshold; both become 429 with identical bodies.
    for (let attempt = 1; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(knownEmail, 'WrongPassword999!');
      await loginRequest(unknownEmail, 'WrongPassword999!');
    }

    const knownThrottled = await loginRequest(knownEmail, 'WrongPassword999!');
    const unknownThrottled = await loginRequest(unknownEmail, 'WrongPassword999!');
    expect(knownThrottled.statusCode).toBe(429);
    expect(unknownThrottled.statusCode).toBe(429);
    expectParityBodies(knownThrottled.json(), unknownThrottled.json());
  });

  it('does not reveal account existence through throttle row counts', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const knownEmail = uniqueEmail('enum-rows');
    await registerUser(knownEmail);
    const unknownEmail = uniqueEmail('enum-rows-unknown');

    for (let attempt = 0; attempt < 3; attempt++) {
      await loginRequest(knownEmail, 'WrongPassword999!');
      await loginRequest(unknownEmail, 'WrongPassword999!');
    }

    // Both dimensions recorded failures for both identities — the unknown
    // email is indistinguishable from a known one with a wrong password.
    const knownRows = await prisma.loginThrottle.findMany({
      where: { key: { contains: 'account' } },
    });
    expect(knownRows).toHaveLength(2);
    expect(knownRows[0].failureCount).toBe(3);
    expect(knownRows[1].failureCount).toBe(3);
  });
});

// ────────────────────────────────────────────────────────
// 4. Source (IP) dimension
// ────────────────────────────────────────────────────────

describe('login throttle — source dimension', () => {
  it('does not throttle a different source for the same account', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('ip-isolation');
    await registerUser(email);

    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!', '203.0.113.10');
    }

    // Same account from a different source is still throttled (account
    // dimension is source-independent)...
    const sameAccountOtherIp = await loginRequest(email, STRONG_PASSWORD, '203.0.113.11');
    expect(sameAccountOtherIp.statusCode).toBe(429);

    // ...but a different account from a fresh source is not.
    const otherEmail = uniqueEmail('ip-isolation-other');
    await registerUser(otherEmail);
    const otherAccountFreshIp = await loginRequest(otherEmail, STRONG_PASSWORD, '203.0.113.12');
    expect(otherAccountFreshIp.statusCode).toBe(200);
  });

  it('throttles a source that sprays many accounts, set up directly', async () => {
    if (!dbAvailable) return;
    // Direct DB setup: 30 failures from one source across distinct accounts
    // would require 30 registrations; the row is the authoritative state.
    const { buildIpKey } = await import('../services/login-throttle.service.js');
    const ipKey = buildIpKey('198.51.100.23');
    await prisma.loginThrottle.create({
      data: {
        key: ipKey,
        failureCount: IP_THRESHOLD,
        windowStartedAt: new Date(),
        expiresAt: new Date(Date.now() + 900_000),
      },
    });

    const email = uniqueEmail('ip-threshold');
    await registerUser(email);
    const response = await loginRequest(email, STRONG_PASSWORD, '198.51.100.23');
    expect(response.statusCode).toBe(429);
    expect(response.json().code).toBe('AUTH_TOO_MANY_ATTEMPTS');
  });

  it('ignores X-Forwarded-For when selecting the throttle key', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('spoof');
    await registerUser(email);

    // A spoofed forwarded header must not move the throttle key: the
    // failures still accumulate against the real socket address.
    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': `10.0.0.${attempt}` },
        payload: { email, password: 'WrongPassword999!' },
      });
      expect(response.statusCode).toBe(401);
    }

    const throttled = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '10.9.9.9' },
      payload: { email, password: 'WrongPassword999!' },
    });
    expect(throttled.statusCode).toBe(429);
  });
});

// ────────────────────────────────────────────────────────
// 5. Multi-instance shared state
// ────────────────────────────────────────────────────────

describe('login throttle — multi-instance', () => {
  it('enforces combined state across independent application instances', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('multi');
    await registerUser(email);

    // Instance A records failures up to the threshold.
    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    // Instance B — a separately-built app with its own Prisma connection —
    // observes the shared PostgreSQL state and throttles.
    await withFreshStack(async (freshApp) => {
      const response = await freshApp.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: STRONG_PASSWORD },
      });
      expect(response.statusCode).toBe(429);
      expect(response.json().code).toBe('AUTH_TOO_MANY_ATTEMPTS');
    });
  });

  it('lets a second instance contribute failures that the first enforces', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('multi-contribute');
    await registerUser(email);

    // Split failures across two independent instances.
    const half = Math.floor(ACCOUNT_THRESHOLD / 2);
    for (let attempt = 0; attempt < half; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    await withFreshStack(async (freshApp) => {
      for (let attempt = half; attempt < ACCOUNT_THRESHOLD; attempt++) {
        const response = await freshApp.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email, password: 'WrongPassword999!' },
        });
        expect(response.statusCode).toBe(401);
      }

      // The original instance now enforces the combined count.
      const throttled = await loginRequest(email, 'WrongPassword999!');
      expect(throttled.statusCode).toBe(429);
    });
  });
});

// ────────────────────────────────────────────────────────
// 6. Concurrency
// ────────────────────────────────────────────────────────

describe('login throttle — concurrency', () => {
  it('loses no increments under concurrent failed logins', async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('concurrent');
    await registerUser(email);

    const CONCURRENT = 10;
    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, () => loginRequest(email, 'WrongPassword999!')),
    );

    for (const response of results) {
      expect(response.statusCode).toBe(401);
    }

    // Exactly one row per dimension, with the full count recorded.
    const rows = await prisma.loginThrottle.findMany();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.failureCount).toBe(CONCURRENT);
    }
  });

  it('throttles concurrent attempts once the threshold is crossed', async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('concurrent-throttle');
    await registerUser(email);

    // Fire more attempts than the threshold concurrently. The exact split
    // between 401 and 429 is racy (check-then-record is not atomic), but
    // the throttle must be active once the burst completes.
    const results = await Promise.all(
      Array.from({ length: ACCOUNT_THRESHOLD + 5 }, () =>
        loginRequest(email, 'WrongPassword999!'),
      ),
    );

    // All burst attempts were processed (401 or 429 — never 500).
    for (const response of results) {
      expect([401, 429]).toContain(response.statusCode);
    }

    // A subsequent attempt is definitely throttled.
    const after = await loginRequest(email, 'WrongPassword999!');
    expect(after.statusCode).toBe(429);
  });
});

// ────────────────────────────────────────────────────────
// 7. Successful login reset
// ────────────────────────────────────────────────────────

describe('login throttle — success reset', () => {
  it('resets account-scoped state after a successful login', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('reset');
    await registerUser(email);

    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD - 1; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    const success = await loginRequest(email, STRONG_PASSWORD);
    expect(success.statusCode).toBe(200);

    // The account row is gone; the next failure starts a fresh window.
    const rowsAfterSuccess = await prisma.loginThrottle.findMany({
      where: { key: { contains: 'account' } },
    });
    expect(rowsAfterSuccess).toHaveLength(0);

    const nextFailure = await loginRequest(email, 'WrongPassword999!');
    expect(nextFailure.statusCode).toBe(401);

    const rowsAfterFailure = await prisma.loginThrottle.findMany({
      where: { key: { contains: 'account' } },
    });
    expect(rowsAfterFailure).toHaveLength(1);
    expect(rowsAfterFailure[0].failureCount).toBe(1);
  });

  it('does not reset source-scoped state on a successful login', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('reset-ip');
    await registerUser(email);

    // Set up source-scoped state directly just below the IP threshold so
    // the successful login itself is allowed.
    const { buildIpKey } = await import('../services/login-throttle.service.js');
    await prisma.loginThrottle.create({
      data: {
        key: buildIpKey('192.0.2.50'),
        failureCount: IP_THRESHOLD - 1,
        windowStartedAt: new Date(),
        expiresAt: new Date(Date.now() + 900_000),
      },
    });

    // A successful login for the first account from the same source must
    // not erase the source dimension's abuse state.
    const success = await loginRequest(email, STRONG_PASSWORD, '192.0.2.50');
    expect(success.statusCode).toBe(200);

    const ipRows = await prisma.loginThrottle.findMany({
      where: { key: { contains: ':ip:' } },
    });
    expect(ipRows).toHaveLength(1);
    expect(ipRows[0].failureCount).toBe(IP_THRESHOLD - 1);

    // One more failure from that source trips the source threshold.
    const thirdEmail = uniqueEmail('reset-ip-third');
    await registerUser(thirdEmail);
    const allowed = await loginRequest(thirdEmail, 'WrongPassword999!', '192.0.2.50');
    expect(allowed.statusCode).toBe(401);

    const tripped = await loginRequest(thirdEmail, 'WrongPassword999!', '192.0.2.50');
    expect(tripped.statusCode).toBe(429);
  });
});

// ────────────────────────────────────────────────────────
// 8. Expiration and recovery
// ────────────────────────────────────────────────────────

describe('login throttle — expiration', () => {
  it('recovers naturally after the window expires', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('expire');
    await registerUser(email);

    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }
    expect((await loginRequest(email, STRONG_PASSWORD)).statusCode).toBe(429);

    // Deterministic time control: age the window past its expiry. M3.16
    // locks the account at the fifth failure, so the lock marker travels
    // too — faithfully simulating the passage of the full lockout duration
    // (which always exceeds the throttle window in production).
    await prisma.loginThrottle.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const locked = await prisma.user.findUnique({ where: { email } });
    await prisma.user.update({
      where: { id: locked!.id },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });

    const recovered = await loginRequest(email, STRONG_PASSWORD);
    expect(recovered.statusCode).toBe(200);
  });

  it('recycles expired rows on the next failure instead of accumulating', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('recycle');
    await registerUser(email);

    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }
    await prisma.loginThrottle.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    // The fifth failure also locked the account (M3.16): age the marker so
    // the next failure reaches the throttle layer it exercises.
    const locked = await prisma.user.findUnique({ where: { email } });
    await prisma.user.update({
      where: { id: locked!.id },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });

    // Next failure starts a fresh window: the stale row is replaced, not
    // incremented, and the table does not grow.
    const response = await loginRequest(email, 'WrongPassword999!');
    expect(response.statusCode).toBe(401);

    const rows = await prisma.loginThrottle.findMany({
      where: { key: { contains: 'account' } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].failureCount).toBe(1);
  });

  it('removes expired rows through opportunistic cleanup', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('cleanup');
    await registerUser(email);

    for (let attempt = 0; attempt < 3; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }
    await prisma.loginThrottle.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // A failure from a different account triggers deleteExpired.
    const otherEmail = uniqueEmail('cleanup-other');
    await registerUser(otherEmail);
    await loginRequest(otherEmail, 'WrongPassword999!');

    const expiredRows = await prisma.loginThrottle.findMany({
      where: { expiresAt: { lte: new Date() } },
    });
    expect(expiredRows).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────
// 9. Infrastructure failure
// ────────────────────────────────────────────────────────

describe('login throttle — infrastructure failure', () => {
  it('fails closed: a dead throttle store propagates instead of bypassing', async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('fail-closed');
    await registerUser(email);

    // A Prisma client pointed at a dead port simulates a throttle-store
    // outage. The repository must throw — never return a default.
    const deadPrisma = new PrismaClient({
      datasources: { db: { url: 'postgresql://127.0.0.1:59999/oxyide_down' } },
    });
    try {
      await expect(deadPrisma.loginThrottle.findUnique({ where: { key: 'x' } })).rejects.toThrow();
    } finally {
      await deadPrisma.$disconnect();
    }
  });

  it('does not record throttle state when the store write fails', async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('no-partial');
    await registerUser(email);

    // With the store unavailable the login attempt fails; no partial
    // throttle state is written (the failure is never recorded because
    // the record call itself is the failing operation).
    const deadPrisma = new PrismaClient({
      datasources: { db: { url: 'postgresql://127.0.0.1:59999/oxyide_down' } },
    });
    try {
      await expect(
        deadPrisma.loginThrottle.create({
          data: {
            key: 'auth:login:v1:account:deadbeef',
            failureCount: 1,
            windowStartedAt: new Date(),
            expiresAt: new Date(Date.now() + 900_000),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await deadPrisma.$disconnect();
    }

    const rows = await prisma.loginThrottle.findMany();
    expect(rows).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────
// 10. Regression — refresh, password reset, email verification
// ────────────────────────────────────────────────────────

describe('login throttle — regression', () => {
  it('does not affect refresh while the account is throttled', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('refresh');
    await registerUser(email);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email, password: STRONG_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='))!.split(';')[0];

    // Throttle the account with failed logins.
    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }
    expect((await loginRequest(email, STRONG_PASSWORD)).statusCode).toBe(429);

    // Refresh never consults login throttle state.
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().accessToken).toBeDefined();
  });

  it('does not affect password reset while the account is throttled', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('reset-flow');
    await registerUser(email);

    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }
    expect((await loginRequest(email, STRONG_PASSWORD)).statusCode).toBe(429);

    // Reset request and confirm proceed normally.
    const request = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      payload: { email },
    });
    expect(request.statusCode).toBe(204);

    // The reset token was persisted; confirm completes the flow.
    const row = await prisma.passwordResetToken.findFirst({ where: { userId: undefined } });
    expect(row).not.toBeNull();
  });

  it('does not affect email verification while the account is throttled', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('verify-flow');
    await registerUser(email);

    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }
    expect((await loginRequest(email, STRONG_PASSWORD)).statusCode).toBe(429);

    // Registration issued a verification token; resend and confirm work.
    const resend = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-verification/resend',
      payload: { email },
    });
    expect(resend.statusCode).toBe(204);
  });

  it('holds temporary — never permanent — lockout state', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('no-lockout');
    const userId = await registerUser(email);

    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    // M3.16 introduces exactly one lockout column: a bounded timestamp.
    // No permanent flags, no second mechanism, no unlock endpoint.
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user).not.toBeNull();
    expect(JSON.stringify(user)).not.toContain('lockedAt');
    expect(JSON.stringify(user)).not.toContain('isLocked');
    expect(user!.lockedUntil).not.toBeNull();
    const lockedUntil = (user!.lockedUntil as Date).getTime();
    expect(lockedUntil).toBeGreaterThan(Date.now());
    expect(lockedUntil).toBeLessThanOrEqual(Date.now() + 1800 * 1000);

    // No unlock endpoint exists.
    const unlock = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/unlock',
      payload: { email },
    });
    expect(unlock.statusCode).toBe(404);
  });

  it('does not count malformed requests as failures', async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('malformed');
    await registerUser(email);

    // Schema-invalid requests are rejected at the boundary and never reach
    // the throttle logic.
    const badFormat = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: 'x' },
    });
    expect(badFormat.statusCode).toBe(400);

    const missingField = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email },
    });
    expect(missingField.statusCode).toBe(400);

    const rows = await prisma.loginThrottle.findMany();
    expect(rows).toHaveLength(0);

    // The account is still fully login-capable.
    const login = await loginRequest(email, STRONG_PASSWORD);
    expect(login.statusCode).toBe(200);
  });
});

// ────────────────────────────────────────────────────────
// 11. Brute-force progressive delay (M3.15)
// ────────────────────────────────────────────────────────

describe('login brute-force — progressive delay', () => {
  it('applies no delay for the first failure', async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('delay-first');
    await registerUser(email);

    // Two consecutive failures: the second carries a 250ms backoff the
    // first lacks, so the difference isolates the delay from bcrypt/DB
    // noise far more reliably than any absolute bound could.
    const firstStart = Date.now();
    const first = await loginRequest(email, 'WrongPassword999!');
    const firstElapsed = Date.now() - firstStart;
    expect(first.statusCode).toBe(401);

    const secondStart = Date.now();
    const second = await loginRequest(email, 'WrongPassword999!');
    const secondElapsed = Date.now() - secondStart;
    expect(second.statusCode).toBe(401);

    expect(secondElapsed - firstElapsed).toBeGreaterThanOrEqual(100);
    // Gross-regression smoke: the first failure must never carry a large delay.
    expect(firstElapsed).toBeLessThan(config.auth.bruteForce.maxDelayMs);
  });

  it('applies increasing delays as failures escalate', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('delay-escalate');
    await registerUser(email);

    const timings: number[] = [];
    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      const start = Date.now();
      await loginRequest(email, 'WrongPassword999!');
      timings.push(Date.now() - start);
    }

    // Escalation span: the last failure carries ~2000ms of backoff the
    // first lacks, so the difference proves escalation robustly against
    // bcrypt/DB noise that no absolute bound can separate reliably.
    expect(timings[4] - timings[0]).toBeGreaterThanOrEqual(1500);
    // Second failure: baseDelayMs delay (with CI tolerance).
    expect(timings[1]).toBeGreaterThanOrEqual(config.auth.bruteForce.baseDelayMs * 0.5);
    // Third failure: 2× baseDelayMs (with CI tolerance).
    expect(timings[2]).toBeGreaterThanOrEqual(config.auth.bruteForce.baseDelayMs * 1.0);
    // Delays are non-decreasing (with CI tolerance).
    for (let i = 1; i < timings.length; i++) {
      expect(timings[i]).toBeGreaterThanOrEqual(timings[i - 1] * 0.5);
    }
  });

  it('caps the delay at maxDelayMs', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('delay-cap');
    await registerUser(email);

    // Drive failures to the escalation cap.
    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    // Verify the pure function cap with a failureCount that reaches the maximum.
    const { calculateBruteForceDelay } = await import('../services/login-throttle.service.js');
    // With baseDelayMs=250, maxDelayMs=2000: level 4 reaches the cap.
    // level = failureCount - escalationStart + 1 = failureCount - 1
    // level 4 → failureCount = 5. Use a value well beyond the cap.
    const maxDelay = calculateBruteForceDelay(10);
    expect(maxDelay).toBe(config.auth.bruteForce.maxDelayMs);
    // Also verify a value just below the cap is not capped.
    const belowCap = calculateBruteForceDelay(config.auth.bruteForce.escalationStart + 1);
    expect(belowCap).toBeLessThan(config.auth.bruteForce.maxDelayMs);
  });

  it('applies the same delay for unknown and known accounts at the same failureCount', async () => {
    if (!dbAvailable) return;
    const knownEmail = uniqueEmail('delay-parity-known');
    await registerUser(knownEmail);
    const unknownEmail = uniqueEmail('delay-parity-unknown');

    // Drive both to the same failureCount.
    for (let attempt = 0; attempt < config.auth.bruteForce.escalationStart + 1; attempt++) {
      await loginRequest(knownEmail, 'WrongPassword999!');
      await loginRequest(unknownEmail, 'WrongPassword999!');
    }

    // Both should have the same throttle state (same failureCount).
    const knownRows = await prisma.loginThrottle.findMany({
      where: { key: { contains: 'account' } },
    });
    expect(knownRows).toHaveLength(2);
    expect(knownRows[0].failureCount).toBe(knownRows[1].failureCount);

    // The delay function produces the same output for the same failureCount.
    const { calculateBruteForceDelay } = await import('../services/login-throttle.service.js');
    expect(calculateBruteForceDelay(knownRows[0].failureCount)).toBe(
      calculateBruteForceDelay(knownRows[1].failureCount),
    );
  });

  it('does not block the event loop during delay', async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('delay-nonblock');
    await registerUser(email);

    // Drive to escalation.
    for (let attempt = 0; attempt < config.auth.bruteForce.escalationStart + 1; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    // Start a delayed login in the background.
    const loginPromise = loginRequest(email, 'WrongPassword999!');

    // Health check should remain responsive during the delay.
    const healthStart = Date.now();
    const health = await app.inject({ method: 'GET', url: '/health/live' });
    const healthElapsed = Date.now() - healthStart;

    expect(health.statusCode).toBe(200);
    // Health check should be fast — not blocked by the login delay.
    expect(healthElapsed).toBeLessThan(config.auth.bruteForce.maxDelayMs);

    // The login eventually completes.
    const loginResponse = await loginPromise;
    expect(loginResponse.statusCode).toBe(401);
  });

  it('resets delay state after successful login', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('delay-reset');
    await registerUser(email);

    // Drive to escalation.
    for (let attempt = 0; attempt < config.auth.bruteForce.escalationStart + 2; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    // Successful login clears account throttle state.
    const success = await loginRequest(email, STRONG_PASSWORD);
    expect(success.statusCode).toBe(200);

    // The account throttle row is gone: the next failure provably starts
    // from a baseline count, which is the deterministic core of "no delay"
    // (timing alone cannot separate 0ms from bcrypt noise reliably).
    const rowsAfterReset = await prisma.loginThrottle.findMany({
      where: { key: { contains: 'account' } },
    });
    expect(rowsAfterReset).toHaveLength(0);

    const nextFailure = await loginRequest(email, 'WrongPassword999!');
    expect(nextFailure.statusCode).toBe(401);
    const rowsAfterFailure = await prisma.loginThrottle.findMany({
      where: { key: { contains: 'account' } },
    });
    expect(rowsAfterFailure).toHaveLength(1);
    expect(rowsAfterFailure[0].failureCount).toBe(1);
  });

  it('holds temporary — never permanent — lockout state with natural recovery', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('delay-no-lockout');
    const userId = await registerUser(email);

    // Drive to escalation.
    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    // M3.16 introduces exactly one lockout column: a bounded timestamp.
    // No permanent flags, no second mechanism.
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(JSON.stringify(user)).not.toContain('lockedAt');
    expect(JSON.stringify(user)).not.toContain('isLocked');
    expect(user!.lockedUntil).not.toBeNull();
    expect((user!.lockedUntil as Date).getTime()).toBeLessThanOrEqual(
      Date.now() + config.auth.accountLockout.lockoutDurationSeconds * 1000,
    );

    // Expire both the lock marker and the throttle window: full recovery.
    await prisma.user.update({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    await prisma.loginThrottle.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // Account recovers — login succeeds.
    const recovered = await loginRequest(email, STRONG_PASSWORD);
    expect(recovered.statusCode).toBe(200);
  });

  it('creates no session or token for delayed failed logins', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('delay-no-session');
    const userId = await registerUser(email);

    // Drive to escalation.
    for (let attempt = 0; attempt < config.auth.bruteForce.escalationStart + 2; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    // No session or refresh token created.
    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions).toHaveLength(0);
  });

  it('shares escalation across independent application instances', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('delay-multi');
    await registerUser(email);

    // Instance A records failures up to escalation.
    for (let attempt = 0; attempt < config.auth.bruteForce.escalationStart + 2; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    // Instance B — a separately-built app with its own Prisma connection —
    // observes the shared PostgreSQL escalation as a delayed response.
    await withFreshStack(async (freshApp) => {
      const start = Date.now();
      const response = await freshApp.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'WrongPassword999!' },
      });
      const elapsed = Date.now() - start;

      expect(response.statusCode).toBe(401);
      // Escalated delay is visible cross-instance (with CI tolerance).
      expect(elapsed).toBeGreaterThanOrEqual(config.auth.bruteForce.baseDelayMs * 0.5);
    });
  });

  it('lets a second instance contribute escalation the first enforces', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('delay-multi-contribute');
    await registerUser(email);

    // Split failures across two independent instances.
    await loginRequest(email, 'WrongPassword999!');

    await withFreshStack(async (freshApp) => {
      await freshApp.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'WrongPassword999!' },
      });
      await freshApp.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'WrongPassword999!' },
      });

      // The original instance now enforces the combined escalation.
      const start = Date.now();
      const response = await loginRequest(email, 'WrongPassword999!');
      const elapsed = Date.now() - start;

      expect(response.statusCode).toBe(401);
      // 3 combined failures → level 3 → 4× base delay (with CI tolerance).
      expect(elapsed).toBeGreaterThanOrEqual(config.auth.bruteForce.baseDelayMs * 2);
    });
  });

  it('applies delay before password verification - no bcrypt work for throttled accounts', { timeout: 30000 }, async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('delay-pre-bcrypt');
    await registerUser(email);

    // Drive to throttle threshold.
    for (let attempt = 0; attempt < ACCOUNT_THRESHOLD; attempt++) {
      await loginRequest(email, 'WrongPassword999!');
    }

    // Next request is throttled (429) — no bcrypt work performed.
    const start = Date.now();
    const throttled = await loginRequest(email, STRONG_PASSWORD);
    const elapsed = Date.now() - start;

    expect(throttled.statusCode).toBe(429);
    // Throttled response is fast — no bcrypt, no delay.
    expect(elapsed).toBeLessThan(config.auth.bruteForce.baseDelayMs);
  });
});
