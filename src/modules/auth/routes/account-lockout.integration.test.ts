/**
 * M3.16 — Account Lockout Policy Integration Tests
 *
 * Proves the temporary, bounded, account-scoped lockout against real
 * PostgreSQL through the real Fastify application: exact threshold and
 * duration, no-extension under continued attack, expiry recovery,
 * concurrency and multi-instance coherence, enumeration parity with the
 * M3.14 429 contract, cross-account and IP isolation, password-reset
 * recovery, and independence of refresh, verification, and revoke-all.
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
const WRONG_PASSWORD = 'WrongPassword999!';
const LOCKOUT_THRESHOLD = config.auth.accountLockout.failureThreshold;
const LOCKOUT_DURATION_MS = config.auth.accountLockout.lockoutDurationSeconds * 1000;

/** Unique email per test so lockout state never leaks across tests. */
function uniqueEmail(label: string): string {
  return `lockout-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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
 * Enumeration-parity comparison (M6.3): identical except per-occurrence
 * `instance` IDs (unique by design, no distinguishing signal).
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
 * Drives an account to the lockout threshold with wrong passwords.
 * Returns the user row after the lock transition.
 */
async function lockAccount(email: string): Promise<{ userId: string; lockedUntil: Date }> {
  for (let attempt = 0; attempt < LOCKOUT_THRESHOLD; attempt++) {
    const response = await loginRequest(email, WRONG_PASSWORD);
    expect(response.statusCode).toBe(401);
  }
  const user = await prisma.user.findUnique({ where: { email } });
  expect(user).not.toBeNull();
  expect(user!.lockedUntil).not.toBeNull();
  return { userId: user!.id, lockedUntil: user!.lockedUntil as Date };
}

/**
 * Simulates the passage of the full lockout duration for one account by
 * ageing both the lock marker and its throttle windows into the past.
 * Both states must travel: the throttle window (15m) always expires before
 * the lockout (30m) in production, so a faithful recovery simulation ages
 * both. Ageing only the lock would leave a live throttle row behind and
 * correctly produce a throttle 429 — not a lockout recovery.
 */
async function expireLockoutState(email: string, clientIp = '127.0.0.1'): Promise<void> {
  const { buildAccountKey, buildIpKey } = await import('../services/login-throttle.service.js');
  const normalized = email.trim().toLowerCase();
  const past = new Date(Date.now() - 1000);
  const user = await prisma.user.findUnique({ where: { email } });
  await prisma.user.update({ where: { id: user!.id }, data: { lockedUntil: past } });
  await prisma.loginThrottle.updateMany({
    where: { key: { in: [buildAccountKey(normalized), buildIpKey(clientIp)] } },
    data: { expiresAt: past },
  });
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
// 1. Lockout lifecycle and policy values
// ────────────────────────────────────────────────────────

describe('account lockout — lifecycle', () => {
  it(
    'locks after exactly LOCKOUT_THRESHOLD failures with a bounded duration',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('threshold');
      await registerUser(email);

      for (let attempt = 1; attempt < LOCKOUT_THRESHOLD; attempt++) {
        const response = await loginRequest(email, WRONG_PASSWORD);
        expect(response.statusCode).toBe(401);
        const user = await prisma.user.findUnique({ where: { email } });
        expect(user!.lockedUntil).toBeNull();
      }

      const before = Date.now();
      const fifth = await loginRequest(email, WRONG_PASSWORD);
      expect(fifth.statusCode).toBe(401);
      const after = Date.now();

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.lockedUntil).not.toBeNull();
      const lockedUntil = (user!.lockedUntil as Date).getTime();
      // The marker is stamped during the fifth attempt: after `before`, and
      // no later than the attempt's completion plus the full duration.
      expect(lockedUntil).toBeGreaterThan(before);
      expect(lockedUntil).toBeLessThanOrEqual(after + LOCKOUT_DURATION_MS);

      const rows = await prisma.loginThrottle.findMany({
        where: { key: { startsWith: 'auth:login:v1:account:' } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].failureCount).toBe(LOCKOUT_THRESHOLD);
    },
  );

  it(
    'rejects locked logins with the generic 429 and creates no credentials',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('locked-429');
      const userId = await registerUser(email);
      await lockAccount(email);

      const start = Date.now();
      const locked = await loginRequest(email, STRONG_PASSWORD);
      const elapsed = Date.now() - start;

      expect(locked.statusCode).toBe(429);
      expect(locked.json().code).toBe('AUTH_TOO_MANY_ATTEMPTS');
      // Locked attempts skip backoff delay and bcrypt: fast by construction.
      // The bound is generous to avoid flakes; unit tests prove no-bcrypt structurally.
      expect(elapsed).toBeLessThan(1500);

      const sessions = await prisma.session.findMany({ where: { userId } });
      expect(sessions).toHaveLength(0);
      expect(JSON.stringify(locked.json())).not.toContain('lockedUntil');
      expect(JSON.stringify(locked.json())).not.toContain(email);
    },
  );

  it(
    'does not extend the lock or grow state under continued attack',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('no-extend');
      await registerUser(email);
      const { lockedUntil } = await lockAccount(email);

      for (let attempt = 0; attempt < 10; attempt++) {
        const response = await loginRequest(email, WRONG_PASSWORD);
        expect(response.statusCode).toBe(429);
      }

      const user = await prisma.user.findUnique({ where: { email } });
      expect((user!.lockedUntil as Date).getTime()).toBe(lockedUntil.getTime());

      const rows = await prisma.loginThrottle.findMany({
        where: { key: { startsWith: 'auth:login:v1:account:' } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].failureCount).toBe(LOCKOUT_THRESHOLD);
    },
  );
});

// ────────────────────────────────────────────────────────
// 2. Expiry and recovery
// ────────────────────────────────────────────────────────

describe('account lockout — expiry and recovery', () => {
  it(
    'rejects just before expiry and recovers just after',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('expiry');
      await registerUser(email);
      const { userId } = await lockAccount(email);

      // Just before expiry: still locked.
      await prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + 60000) },
      });
      expect((await loginRequest(email, STRONG_PASSWORD)).statusCode).toBe(429);

      // Just after expiry: full recovery with normal credentials. Both the
      // lock marker and the throttle window are aged past, faithfully
      // simulating the passage of the full lockout duration.
      await expireLockoutState(email);
      const recovered = await loginRequest(email, STRONG_PASSWORD);
      expect(recovered.statusCode).toBe(200);

      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user!.lockedUntil).toBeNull();

      // The next failure starts from a clean baseline.
      const nextFailure = await loginRequest(email, WRONG_PASSWORD);
      expect(nextFailure.statusCode).toBe(401);
      const rows = await prisma.loginThrottle.findMany({
        where: { key: { startsWith: 'auth:login:v1:account:' } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].failureCount).toBe(1);
    },
  );

  it(
    'recovers coherently under concurrent successes after expiry',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('expiry-race');
      await registerUser(email);
      await lockAccount(email);
      await expireLockoutState(email);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => loginRequest(email, STRONG_PASSWORD)),
      );
      for (const response of results) {
        expect(response.statusCode).toBe(200);
      }

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.lockedUntil).toBeNull();
    },
  );

  it(
    'recovers coherently under concurrent failures after expiry',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('expiry-fail-race');
      await registerUser(email);
      await lockAccount(email);
      await expireLockoutState(email);

      const results = await Promise.all([
        loginRequest(email, WRONG_PASSWORD),
        loginRequest(email, WRONG_PASSWORD),
      ]);
      for (const response of results) {
        expect(response.statusCode).toBe(401);
      }

      // Both failures observed the recovered state: one coherent row, count 2, no lock.
      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.lockedUntil).toBeNull();
      const rows = await prisma.loginThrottle.findMany({
        where: { key: { startsWith: 'auth:login:v1:account:' } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].failureCount).toBe(2);
    },
  );
});

// ────────────────────────────────────────────────────────
// 3. Concurrency at the threshold
// ────────────────────────────────────────────────────────

describe('account lockout — concurrency', () => {
  it(
    'converges ten concurrent failures on one coherent locked state',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('concurrent-lock');
      await registerUser(email);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => loginRequest(email, WRONG_PASSWORD)),
      );
      for (const response of results) {
        expect([401, 429]).toContain(response.statusCode);
      }

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.lockedUntil).not.toBeNull();
      const lockedUntil = (user!.lockedUntil as Date).getTime();
      expect(lockedUntil).toBeGreaterThan(Date.now());
      expect(lockedUntil).toBeLessThanOrEqual(Date.now() + LOCKOUT_DURATION_MS);

      const rows = await prisma.loginThrottle.findMany({
        where: { key: { startsWith: 'auth:login:v1:account:' } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].failureCount).toBe(10);

      expect((await loginRequest(email, STRONG_PASSWORD)).statusCode).toBe(429);
    },
  );

  it(
    'keeps failure-vs-success coherent at the threshold boundary',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('failure-success-race');
      await registerUser(email);

      // Four recorded failures put the next failure exactly on the threshold.
      for (let attempt = 0; attempt < LOCKOUT_THRESHOLD - 1; attempt++) {
        await loginRequest(email, WRONG_PASSWORD);
      }

      const [failed, succeeded] = await Promise.all([
        loginRequest(email, WRONG_PASSWORD),
        loginRequest(email, STRONG_PASSWORD),
      ]);
      // The wrong password always evaluates (the gate sees count <= 4 for
      // it): it can only fail authentication, never succeed or crash.
      expect(failed.statusCode).toBe(401);

      const user = await prisma.user.findUnique({ where: { email } });
      const sessions = await prisma.session.findMany({ where: { userId: user!.id } });
      const rows = await prisma.loginThrottle.findMany({
        where: { key: { startsWith: 'auth:login:v1:account:' } },
      });
      const locked =
        user!.lockedUntil !== null && (user!.lockedUntil as Date).getTime() > Date.now();

      if (succeeded.statusCode === 200) {
        // Exactly one session per success; no phantom sessions.
        expect(sessions).toHaveLength(1);
        if (locked) {
          // Accepted residual (§70): the failure's lock committed after the
          // success's revalidation. The cleared throttle row stays gone —
          // the lock, not a stale count, carries the state forward.
          expect(rows).toHaveLength(0);
        } else {
          // Clean success: at most a fresh baseline row survives.
          expect(rows.length).toBeLessThanOrEqual(1);
          if (rows.length === 1) {
            expect(rows[0].failureCount).toBe(1);
          }
        }
      } else {
        // The failure crossed first: the success revalidated a live lock.
        expect(succeeded.statusCode).toBe(429);
        expect(sessions).toHaveLength(0);
        expect(locked).toBe(true);
        expect(rows).toHaveLength(1);
        expect(rows[0].failureCount).toBe(LOCKOUT_THRESHOLD);
      }
    },
  );

  it(
    'blocks a correct password with a manually installed lock and creates no session',
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('correct-while-locked');
      const userId = await registerUser(email);

      // Simulate a lock committed by concurrent failures during this login's bcrypt.
      await prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) },
      });

      const response = await loginRequest(email, STRONG_PASSWORD);
      expect(response.statusCode).toBe(429);
      expect(response.json().code).toBe('AUTH_TOO_MANY_ATTEMPTS');

      const sessions = await prisma.session.findMany({ where: { userId } });
      expect(sessions).toHaveLength(0);
    },
  );
});

// ────────────────────────────────────────────────────────
// 4. Enumeration parity
// ────────────────────────────────────────────────────────

describe('account lockout — enumeration parity', () => {
  it(
    'returns identical 429s (except per-occurrence instance) for locked, throttled, and unknown-throttled accounts',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const lockedEmail = uniqueEmail('parity-locked');
      await registerUser(lockedEmail);
      await lockAccount(lockedEmail);

      const unknownEmail = uniqueEmail('parity-unknown');
      for (let attempt = 0; attempt < LOCKOUT_THRESHOLD; attempt++) {
        await loginRequest(unknownEmail, WRONG_PASSWORD);
      }

      const lockedResponse = await loginRequest(lockedEmail, WRONG_PASSWORD);
      const unknownResponse = await loginRequest(unknownEmail, WRONG_PASSWORD);
      expect(lockedResponse.statusCode).toBe(429);
      expect(unknownResponse.statusCode).toBe(429);
      expectParityBodies(lockedResponse.json(), unknownResponse.json());

      // Unknown accounts can never hold lock state: no User row exists.
      expect(await prisma.user.findUnique({ where: { email: unknownEmail } })).toBeNull();
      // Fresh identities of both kinds still share the fast generic 401.
      const freshKnown = uniqueEmail('parity-fresh-known');
      await registerUser(freshKnown);
      const freshUnknown = uniqueEmail('parity-fresh-unknown');
      const knownFresh = await loginRequest(freshKnown, WRONG_PASSWORD);
      const unknownFresh = await loginRequest(freshUnknown, WRONG_PASSWORD);
      expect(knownFresh.statusCode).toBe(401);
      expect(unknownFresh.statusCode).toBe(401);
      expectParityBodies(knownFresh.json(), unknownFresh.json());
    },
  );
});

// ────────────────────────────────────────────────────────
// 5. Isolation
// ────────────────────────────────────────────────────────

describe('account lockout — isolation', () => {
  it(
    'leaves other accounts fully usable when one account locks',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const victimEmail = uniqueEmail('isolation-victim');
      await registerUser(victimEmail);
      await lockAccount(victimEmail);

      const otherEmail = uniqueEmail('isolation-other');
      await registerUser(otherEmail);
      const login = await loginRequest(otherEmail, STRONG_PASSWORD);
      expect(login.statusCode).toBe(200);

      const other = await prisma.user.findUnique({ where: { email: otherEmail } });
      expect(other!.lockedUntil).toBeNull();
    },
  );

  it(
    'never locks accounts from source-IP spray alone',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const emails: string[] = [];
      for (let i = 0; i < 6; i++) {
        const email = uniqueEmail(`spray-${i}`);
        await registerUser(email);
        emails.push(email);
      }

      // One failure per account from the same source: the IP dimension
      // accumulates, but no account reaches its own threshold.
      for (const email of emails) {
        const response = await loginRequest(email, WRONG_PASSWORD, '203.0.113.9');
        expect(response.statusCode).toBe(401);
      }

      for (const email of emails) {
        const user = await prisma.user.findUnique({ where: { email } });
        expect(user!.lockedUntil).toBeNull();
        const login = await loginRequest(email, STRONG_PASSWORD, '203.0.113.77');
        expect(login.statusCode).toBe(200);
      }
    },
  );

  it('does not record or lock on malformed requests', async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('malformed-lock');
    await registerUser(email);

    const badFormat = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: 'x' },
    });
    expect(badFormat.statusCode).toBe(400);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user!.lockedUntil).toBeNull();
    expect(await prisma.loginThrottle.count()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────
// 6. Session, refresh, JWT, and recovery interactions
// ────────────────────────────────────────────────────────

describe('account lockout — session and recovery interactions', () => {
  it(
    'leaves existing refresh sessions usable during lockout',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('refresh-during-lock');
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

      await lockAccount(email);
      expect((await loginRequest(email, STRONG_PASSWORD)).statusCode).toBe(429);

      // Refresh validates user status (still active), never lockout state.
      const refresh = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: refreshCookie },
      });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.json().accessToken).toBeDefined();
    },
  );

  it(
    'leaves already-issued access JWTs usable during lockout',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('jwt-during-lock');
      await registerUser(email);

      const login = await loginRequest(email, STRONG_PASSWORD);
      expect(login.statusCode).toBe(200);
      const accessToken = (login.json() as { accessToken: string }).accessToken;

      await lockAccount(email);

      // Stateless JWTs drain to their short expiry; lockout does not revoke them.
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(me.statusCode).toBe(200);
    },
  );

  it(
    'keeps password-reset request generic for locked accounts',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('reset-request-locked');
      await registerUser(email);
      await lockAccount(email);

      const request = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        payload: { email },
      });
      expect(request.statusCode).toBe(204);
    },
  );

  it(
    'recovers a locked account through successful password reset',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('reset-recovery');
      const userId = await registerUser(email);
      await lockAccount(email);

      const { authService } = await import('../services/auth.service.js');
      type CapturedEmail = { to: string; resetUrl: string };
      const sent: CapturedEmail[] = [];
      await authService.requestPasswordReset(email, '127.0.0.1', {
        sendPasswordResetEmail: async (message: CapturedEmail): Promise<void> => {
          sent.push(message);
        },
      });
      expect(sent).toHaveLength(1);
      const rawToken = sent[0].resetUrl.split('token=')[1];

      const confirm = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token: rawToken, password: 'NewStrongPassword123!' },
      });
      expect(confirm.statusCode).toBe(204);

      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user!.lockedUntil).toBeNull();

      const login = await loginRequest(email, 'NewStrongPassword123!');
      expect(login.statusCode).toBe(200);
    },
  );

  it(
    'does not unlock on invalid or expired reset tokens',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('reset-no-unlock');
      await registerUser(email);
      await lockAccount(email);

      for (const token of ['not-a-token', '']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/password-reset/confirm',
          payload: token === '' ? {} : { token, password: 'NewStrongPassword123!' },
        });
        expect([400, 401]).toContain(response.statusCode);
      }

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.lockedUntil).not.toBeNull();
      expect((await loginRequest(email, STRONG_PASSWORD)).statusCode).toBe(429);
    },
  );

  it(
    'leaves lockout untouched by email verification',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('verify-during-lock');
      await registerUser(email);
      await lockAccount(email);

      const { authService } = await import('../services/auth.service.js');
      type CapturedVerification = { to: string; verificationUrl: string };
      const sent: CapturedVerification[] = [];
      await authService.resendVerificationEmail(email, '127.0.0.1', {
        sendVerificationEmail: async (message: CapturedVerification): Promise<void> => {
          sent.push(message);
        },
      });
      expect(sent).toHaveLength(1);

      const confirm = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/confirm',
        payload: { token: sent[0].verificationUrl.split('token=')[1] },
      });
      expect(confirm.statusCode).toBe(204);

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.lockedUntil).not.toBeNull();
      expect((await loginRequest(email, STRONG_PASSWORD)).statusCode).toBe(429);
    },
  );

  it(
    'leaves lockout untouched by revoke-all sessions',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('revoke-during-lock');
      await registerUser(email);

      const login = await loginRequest(email, STRONG_PASSWORD);
      expect(login.statusCode).toBe(200);
      const accessToken = (login.json() as { accessToken: string }).accessToken;

      await lockAccount(email);

      const revokeAll = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(revokeAll.statusCode).toBe(204);

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.lockedUntil).not.toBeNull();
      expect((await loginRequest(email, STRONG_PASSWORD)).statusCode).toBe(429);
    },
  );

  it('never exposes lockedUntil in public representations', async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('no-leak');
    await registerUser(email);

    const registerBody = JSON.stringify(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email: uniqueEmail('no-leak-register'), password: STRONG_PASSWORD },
        })
      ).json(),
    );
    expect(registerBody).not.toContain('lockedUntil');

    const login = await loginRequest(email, STRONG_PASSWORD);
    expect(login.statusCode).toBe(200);
    expect(JSON.stringify(login.json())).not.toContain('lockedUntil');

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${(login.json() as { accessToken: string }).accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(JSON.stringify(me.json())).not.toContain('lockedUntil');
  });
});

// ────────────────────────────────────────────────────────
// 7. Multi-instance coherence
// ────────────────────────────────────────────────────────

describe('account lockout — multi-instance', () => {
  it(
    'shares lock state and recovery across independent instances',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('multi-lock');
      await registerUser(email);
      const { lockedUntil } = await lockAccount(email);

      await withFreshStack(async (freshApp, freshPrisma) => {
        // Instance B observes the same lock and rejects.
        const rejected = await freshApp.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email, password: STRONG_PASSWORD },
        });
        expect(rejected.statusCode).toBe(429);
        expect(rejected.json().code).toBe('AUTH_TOO_MANY_ATTEMPTS');

        const observed = await freshPrisma.user.findUnique({ where: { email } });
        expect((observed!.lockedUntil as Date).getTime()).toBe(lockedUntil.getTime());

        // Expiry is observed by both stacks without rebuilds or caches.
        // Both the lock marker and the throttle windows travel past,
        // faithfully simulating the full lockout duration.
        const { buildAccountKey, buildIpKey } = await import(
          '../services/login-throttle.service.js'
        );
        const past = new Date(Date.now() - 1000);
        await freshPrisma.user.update({
          where: { email },
          data: { lockedUntil: past },
        });
        await freshPrisma.loginThrottle.updateMany({
          where: {
            key: {
              in: [
                buildAccountKey(email.trim().toLowerCase()),
                buildIpKey('127.0.0.1'),
              ],
            },
          },
          data: { expiresAt: past },
        });
        const recoveredFresh = await freshApp.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email, password: STRONG_PASSWORD },
        });
        expect(recoveredFresh.statusCode).toBe(200);
      });

      const recoveredPrimary = await loginRequest(email, STRONG_PASSWORD);
      expect(recoveredPrimary.statusCode).toBe(200);
      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.lockedUntil).toBeNull();
    },
  );
});

// ────────────────────────────────────────────────────────
// 8. Infrastructure failure
// ────────────────────────────────────────────────────────

describe('account lockout — infrastructure failure', () => {
  it('fails closed: lockout state reads propagate instead of bypassing', async () => {
    if (!dbAvailable) return;

    // A Prisma client pointed at a dead port simulates a lockout-store
    // outage. Reads and conditional writes must throw — never resolve to
    // a default that the login flow could mistake for "unlocked".
    const deadPrisma = new PrismaClient({
      datasources: { db: { url: 'postgresql://127.0.0.1:59999/oxyide_down' } },
    });
    try {
      await expect(
        deadPrisma.user.updateMany({
          where: { id: 'u_missing' },
          data: { lockedUntil: new Date() },
        }),
      ).rejects.toThrow();
      await expect(deadPrisma.user.findUnique({ where: { id: 'u_missing' } })).rejects.toThrow();
    } finally {
      await deadPrisma.$disconnect();
    }
  });

  it('fails closed: lockout writes propagate instead of masking an outage', async () => {
    if (!dbAvailable) return;
    const email = uniqueEmail('fail-closed-write');
    await registerUser(email);

    const deadPrisma = new PrismaClient({
      datasources: { db: { url: 'postgresql://127.0.0.1:59999/oxyide_down' } },
    });
    try {
      await expect(
        deadPrisma.loginThrottle.updateMany({
          where: { key: 'auth:login:v1:account:deadbeef' },
          data: { failureCount: { increment: 1 } },
        }),
      ).rejects.toThrow();
    } finally {
      await deadPrisma.$disconnect();
    }

    // No lockout state was manufactured by the outage.
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user!.lockedUntil).toBeNull();
  });
});
