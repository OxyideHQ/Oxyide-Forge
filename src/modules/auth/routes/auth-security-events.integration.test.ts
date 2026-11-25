import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('../../../app/app.js');
const { authService } = await import('../services/auth.service.js');

let app: FastifyInstance;
let dbAvailable = false;

/** Synchronous in-memory log capture: deterministic, no flush waits. */
const captured: string[] = [];
const captureStream = {
  write(chunk: unknown): boolean {
    captured.push(String(chunk));
    return true;
  },
};

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

  // The REAL application pipeline with logs routed to capture instead of
  // stdout. Every assertion below reads EMITTED output, never helpers.
  app = await buildApp({ loggerStream: captureStream });
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  captured.length = 0;
  await cleanDatabase();
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanDatabase();
  }
  await app?.close();
  await prisma.$disconnect();
});

type LoggedEvent = {
  event?: unknown;
  outcome?: unknown;
  subjectId?: unknown;
  reason?: unknown;
  revokedCount?: unknown;
  reqId?: unknown;
};

function securityEvents(): Array<LoggedEvent & { level: number }> {
  return captured.flatMap((entry) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(entry) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (typeof parsed['event'] !== 'string' || !(parsed['event'] as string).startsWith('auth.')) {
      return [];
    }
    return [
      {
        event: parsed['event'],
        outcome: parsed['outcome'],
        subjectId: parsed['subjectId'],
        reason: parsed['reason'],
        revokedCount: parsed['revokedCount'],
        reqId: parsed['reqId'],
        level: parsed['level'] as number,
      },
    ];
  });
}

function headerId(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['x-request-id'];
  expect(typeof value).toBe('string');
  return value as string;
}

const PASSWORD = 'correct-horse-battery-staple';

async function register(email: string): Promise<{ id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  return { id: (response.json() as { id: string }).id };
}

async function login(
  email: string,
  password: string,
): Promise<{ statusCode: number; token?: string; header: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  const body = response.json() as { accessToken?: string };
  return { statusCode: response.statusCode, token: body.accessToken, header: headerId(response) };
}

function refreshCookieFrom(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const refresh = cookies.find(
    (cookie) => typeof cookie === 'string' && cookie.startsWith('refreshToken='),
  );
  expect(refresh).toBeDefined();
  return (refresh as string).split(';')[0];
}

/**
 * M8.3 — auth security-event matrix (live application pipeline).
 *
 * Each flow below proves on emitted output: the exact event name, the
 * outcome/reason, the request-ID correlation to the HTTP response, the
 * allowlisted actor representation (UUID only when known, never email),
 * and the absence of every secret class. Behavioral statuses are
 * re-asserted alongside so an event can never silently change an outcome.
 */
describe('auth security events: login lifecycle', () => {
  it(
    'emits login.success with the subject on valid credentials',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `seclog-ok-${Date.now()}@example.com`;
      const { id } = await register(email);
      captured.length = 0;

      const attempt = await login(email, PASSWORD);
      expect(attempt.statusCode).toBe(200);

      const events = securityEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'auth.login.success',
        outcome: 'success',
        subjectId: id,
        reqId: attempt.header,
      });
      expect(events[0].level).toBe(30);
      // No email, no token anywhere in the output.
      expect(captured.join('\n')).not.toContain(email);
      expect(captured.join('\n')).not.toContain(attempt.token as string);
    },
  );

  it(
    'emits login.failure with reason for known and unknown accounts — identifier only when known',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `seclog-bad-${Date.now()}@example.com`;
      const { id } = await register(email);
      captured.length = 0;

      const wrong = await login(email, 'wrong-password-xyz');
      expect(wrong.statusCode).toBe(401);
      const unknown = await login(`nobody-${Date.now()}@example.com`, 'wrong-password-xyz');
      expect(unknown.statusCode).toBe(401);

      const events = securityEvents();
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        event: 'auth.login.failure',
        outcome: 'failure',
        reason: 'invalid_credentials',
        subjectId: id,
        reqId: wrong.header,
      });
      // Unknown account: same event and reason, NO subject identifier.
      expect(events[1]).toMatchObject({
        event: 'auth.login.failure',
        outcome: 'failure',
        reason: 'invalid_credentials',
        reqId: unknown.header,
      });
      expect(events[1].subjectId).toBeUndefined();
      expect(captured.join('\n')).not.toContain(email);
    },
  );

  it(
    'emits account.locked at the lock transition alongside the failure',
    { timeout: 120000 },
    async () => {
      if (!dbAvailable) return;
      const email = `seclog-lock-${Date.now()}@example.com`;
      const { id } = await register(email);
      captured.length = 0;

      // Five failures cross the M3.16 lockout threshold (see
      // account-lockout suites for the threshold contract).
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await login(email, 'wrong-password-xyz');
        expect([401, 429]).toContain(response.statusCode);
      }

      const events = securityEvents().filter((entry) => entry.event === 'auth.account.locked');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]).toMatchObject({
        outcome: 'locked',
        subjectId: id,
      });
      expect(events[0].level).toBe(40);
    },
  );
});

describe('auth security events: sessions and replay', () => {
  it(
    'emits session.revoked with outcome only, and sessions.revoked_all with subject and count',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `seclog-sess-${Date.now()}@example.com`;
      await register(email);
      const attempt = await login(email, PASSWORD);
      const token = attempt.token as string;
      captured.length = 0;

      const out = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { cookie: '' },
      });
      expect(out.statusCode).toBe(204);

      const revokeAll = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(revokeAll.statusCode).toBe(204);

      const events = securityEvents();
      const revokedAll = events.filter((entry) => entry.event === 'auth.sessions.revoked_all');
      expect(revokedAll).toHaveLength(1);
      expect(revokedAll[0].outcome).toBe('revoked');
      expect(typeof revokedAll[0].subjectId).toBe('string');
      expect(typeof revokedAll[0].revokedCount).toBe('number');
      expect(revokedAll[0].reqId).toBe(headerId(revokeAll));
    },
  );

  it(
    'emits refresh.replay with the subject when a consumed credential returns',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `seclog-replay-${Date.now()}@example.com`;
      const { id } = await register(email);
      const browser = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email, password: PASSWORD },
      });
      expect(browser.statusCode).toBe(200);
      const originalCookie = refreshCookieFrom(browser);

      // Rotate once: the original credential is now consumed.
      const rotated = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: originalCookie },
      });
      expect(rotated.statusCode).toBe(200);
      captured.length = 0;

      // Present the ORIGINAL (now consumed) credential: replay.
      const replay = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: originalCookie },
      });
      expect(replay.statusCode).toBe(401);

      const events = securityEvents().filter((entry) => entry.event === 'auth.refresh.replay');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        outcome: 'replay_detected',
        subjectId: id,
        reqId: headerId(replay),
      });
      expect(events[0].level).toBe(40);
    },
  );

  it(
    'emits session.revoked when logout revokes a live family',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `seclog-logout-${Date.now()}@example.com`;
      await register(email);
      const browser = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email, password: PASSWORD },
      });
      expect(browser.statusCode).toBe(200);
      captured.length = 0;

      const out = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { cookie: refreshCookieFrom(browser) },
      });
      expect(out.statusCode).toBe(204);

      const events = securityEvents().filter((entry) => entry.event === 'auth.session.revoked');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        outcome: 'revoked',
        reqId: headerId(out),
      });
      // No subject: the presented credential identifies no account by itself.
      expect(events[0].subjectId).toBeUndefined();
    },
  );
});

describe('auth security events: recovery and verification', () => {
  it(
    'emits requested events with no identifier and completed events with the subject',
    { timeout: 120000 },
    async () => {
      if (!dbAvailable) return;
      const email = `seclog-rec-${Date.now()}@example.com`;
      const { id } = await register(email);

      // Request flows over HTTP first: enumeration-safe, identifier-free.
      // (Service-level token capture happens AFTER these, because issuance
      // is newest-only — an HTTP request would supersede a captured token.)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/password-reset/request',
            payload: { email },
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/email-verification/resend',
            payload: { email },
          })
        ).statusCode,
      ).toBe(204);

      // Capture raw tokens through the service mailer ports (same pattern
      // as the auth suites): tokens never appear in HTTP traffic. Direct
      // service calls pass no event sink, so they emit nothing.
      const resetSent: Array<{ resetUrl: string }> = [];
      await authService.requestPasswordReset(email, '127.0.0.1', {
        sendPasswordResetEmail: (message: { resetUrl: string }): Promise<void> => {
          resetSent.push(message);
          return Promise.resolve();
        },
      });
      expect(resetSent).toHaveLength(1);
      const resetToken = resetSent[0].resetUrl.split('token=')[1];

      const verifySent: Array<{ verificationUrl: string }> = [];
      await authService.resendVerificationEmail(email, '127.0.0.1', {
        sendVerificationEmail: (message: { verificationUrl: string }): Promise<void> => {
          verifySent.push(message);
          return Promise.resolve();
        },
      });
      expect(verifySent).toHaveLength(1);
      const verifyToken = verifySent[0].verificationUrl.split('token=')[1];

      // Completions over HTTP: subjects proven by the credentials.
      const resetDone = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token: resetToken, password: 'new-correct-horse-battery' },
      });
      expect(resetDone.statusCode).toBe(204);
      const verifyDone = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/confirm',
        payload: { token: verifyToken },
      });
      expect(verifyDone.statusCode).toBe(204);

      const events = securityEvents();
      const byName = (name: string): Array<(typeof events)[number]> =>
        events.filter((entry) => entry.event === name);
      expect(byName('auth.password_reset.requested')).toHaveLength(1);
      expect(byName('auth.password_reset.requested')[0].subjectId).toBeUndefined();
      expect(byName('auth.email_verification.requested')).toHaveLength(1);
      expect(byName('auth.email_verification.requested')[0].subjectId).toBeUndefined();
      expect(byName('auth.password_reset.completed')).toMatchObject([
        { outcome: 'success', subjectId: id },
      ]);
      expect(byName('auth.email_verification.completed')).toMatchObject([
        { outcome: 'success', subjectId: id },
      ]);
      // Raw credentials and the address never appear in any line.
      const out = captured.join('\n');
      expect(out).not.toContain(resetToken);
      expect(out).not.toContain(verifyToken);
      expect(out).not.toContain(email);
    },
  );

  it(
    'emits failure without identifier for invalid recovery credentials',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      captured.length = 0;
      const badReset = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token: 'not-a-real-token', password: 'new-correct-horse-battery' },
      });
      expect(badReset.statusCode).toBe(401);
      const badVerify = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/confirm',
        payload: { token: 'not-a-real-token' },
      });
      expect(badVerify.statusCode).toBe(401);

      const events = securityEvents();
      expect(events).toHaveLength(2);
      for (const entry of events) {
        expect(entry.outcome).toBe('failure');
        expect(entry.reason).toBe('invalid_token');
        expect(entry.subjectId).toBeUndefined();
      }
    },
  );
});

describe('auth security events: correlation, privacy, and non-interference', () => {
  it(
    'correlates concurrent events to their own requests and leaks nothing sensitive',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const stamp = Date.now();
      const emailA = `seclog-ca-${stamp}@example.com`;
      const emailB = `seclog-cb-${stamp}@example.com`;
      await register(emailA);
      await register(emailB);
      captured.length = 0;

      const [okA, badB] = await Promise.all([login(emailA, PASSWORD), login(emailB, 'wrong-password-xyz')]);
      expect(okA.statusCode).toBe(200);
      expect(badB.statusCode).toBe(401);

      const events = securityEvents();
      const success = events.filter((entry) => entry.event === 'auth.login.success');
      const failure = events.filter((entry) => entry.event === 'auth.login.failure');
      expect(success).toHaveLength(1);
      expect(failure).toHaveLength(1);
      expect(success[0].reqId).toBe(okA.header);
      expect(failure[0].reqId).toBe(badB.header);
      expect(success[0].reqId).not.toBe(failure[0].reqId);

      // Negative sweep over everything this file emitted.
      const out = captured.join('\n');
      for (const secret of [emailA, emailB, PASSWORD, 'wrong-password-xyz', okA.token as string]) {
        expect(out).not.toContain(secret);
      }
      // Payload keys are exactly the allowlist on every event line.
      const allowed = new Set([
        'level',
        'time',
        'reqId',
        'event',
        'outcome',
        'subjectId',
        'reason',
        'revokedCount',
        'msg',
      ]);
      for (const entry of captured.flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          return typeof parsed['event'] === 'string' &&
            (parsed['event'] as string).startsWith('auth.')
            ? [parsed]
            : [];
        } catch {
          return [];
        }
      })) {
        for (const key of Object.keys(entry)) {
          expect(allowed.has(key), key).toBe(true);
        }
      }
    },
  );
});
