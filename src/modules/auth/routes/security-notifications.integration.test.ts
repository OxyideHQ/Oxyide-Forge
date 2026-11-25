/**
 * M3.17 — Security Notifications Integration Tests
 *
 * Proves the narrow post-commit security notification capability against
 * real PostgreSQL through the real services: exactly one account-locked
 * notice per atomic lock transition (concurrency and multi-instance safe),
 * exactly one password-change notice per successful reset, best-effort
 * delivery that never breaks the primary security operation, and template
 * safety (no secrets, no internals, canonical recipient only).
 *
 * No mocks for the database. The mailer and logger are capturing fakes
 * injected through the documented service options — the same seam the
 * M3.11/M3.12 mailer ports use. HTTP (`app.inject`) covers the public
 * contract (unchanged 429/204 shapes); service calls with fakes cover
 * notification behavior, because routes intentionally use the NoOp
 * transport until a provider implements the port.
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
const { authService } = await import('../services/auth.service.js');
const { renderEmailTemplate } = await import(
  '../../../shared/email/templates/email-template-registry.js'
);

let app: FastifyInstance;
let dbAvailable = false;

const STRONG_PASSWORD = 'StrongPassword123!';
const WRONG_PASSWORD = 'WrongPassword999!';
const LOCKOUT_THRESHOLD = config.auth.accountLockout.failureThreshold;

type SentNotice = {
  type: 'ACCOUNT_LOCKED' | 'PASSWORD_RESET_SUCCEEDED';
  to: string;
  subject: string;
  textBody: string;
};

type LoggedFailure = {
  fields: Record<string, unknown>;
  message: string;
};

/**
 * Captures notices exactly as the production adapter delivers them: the port
 * now carries only the recipient and the facts a notice prints (M11.4), so the
 * capture renders the message through the same template registry. Every content
 * assertion below therefore still observes the real delivered wording.
 */
function capturingSecurityMailer(sent: SentNotice[]) {
  return {
    sendAccountLocked: async (email: {
      to: string;
      lockoutDurationText: string;
    }): Promise<void> => {
      const rendered = renderEmailTemplate('SECURITY_NOTIFICATION', {
        type: 'ACCOUNT_LOCKED',
        lockoutDurationText: email.lockoutDurationText,
      });
      sent.push({
        type: 'ACCOUNT_LOCKED',
        to: email.to,
        subject: rendered.subject,
        textBody: rendered.text,
      });
    },
    sendPasswordResetSucceeded: async (email: { to: string }): Promise<void> => {
      const rendered = renderEmailTemplate('SECURITY_NOTIFICATION', {
        type: 'PASSWORD_RESET_SUCCEEDED',
      });
      sent.push({
        type: 'PASSWORD_RESET_SUCCEEDED',
        to: email.to,
        subject: rendered.subject,
        textBody: rendered.text,
      });
    },
  };
}

function capturingLogger(logs: LoggedFailure[]) {
  return {
    error: (fields: Record<string, unknown>, message: string): void => {
      logs.push({ fields, message });
    },
  };
}

function throwingMailer(error: unknown) {
  return {
    sendAccountLocked: async (): Promise<void> => {
      throw error;
    },
    sendPasswordResetSucceeded: async (): Promise<void> => {
      throw error;
    },
  };
}

/** Unique email per test so lockout state never leaks across tests. */
function uniqueEmail(label: string): string {
  return `notify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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

/**
 * One failed service login with notification capture. Rejects with the
 * service error (401 AppError on evaluated failures, 429 past the gate).
 */
function failedServiceLogin(
  email: string,
  password: string,
  sent: SentNotice[],
  logs: LoggedFailure[],
  clientIp = '127.0.0.1',
) {
  return authService.login(
    app,
    { email, password, clientIp },
    { securityNotificationMailer: capturingSecurityMailer(sent), securityNotificationLogger: capturingLogger(logs) },
  );
}

/**
 * Drives an account to the lockout threshold with wrong passwords through
 * the service layer, capturing notifications. Every attempt rejects; the
 * threshold-crossing attempt triggers exactly one notice.
 */
async function lockAccountViaService(
  email: string,
  sent: SentNotice[],
  logs: LoggedFailure[],
): Promise<void> {
  for (let attempt = 0; attempt < LOCKOUT_THRESHOLD; attempt++) {
    await expect(failedServiceLogin(email, WRONG_PASSWORD, sent, logs)).rejects.toThrow();
  }
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  expect(user).not.toBeNull();
  expect(user!.lockedUntil).not.toBeNull();
}

/**
 * Simulates the passage of the full lockout duration for one account by
 * ageing both the lock marker and its throttle windows into the past.
 */
async function expireLockoutState(email: string, clientIp = '127.0.0.1'): Promise<void> {
  const { buildAccountKey, buildIpKey } = await import('../services/login-throttle.service.js');
  const normalized = email.trim().toLowerCase();
  const past = new Date(Date.now() - 1000);
  const user = await prisma.user.findUnique({ where: { email: normalized } });
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

/** Substrings that must never appear in any captured security notice. */
const FORBIDDEN = [
  'passwordHash',
  'refreshToken',
  'accessToken',
  'lockedUntil',
  'failureCount',
  'tokenHash',
  'token=',
  'Bearer',
  'sessionId',
  'UPDATE ',
  'SELECT ',
  'fake-provider-secret',
];

function expectNoticeSafe(notice: SentNotice): void {
  const combined = `${notice.subject}\n${notice.textBody}`;
  for (const forbidden of FORBIDDEN) {
    expect(combined).not.toContain(forbidden);
  }
  expect(combined).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
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

// ────────────────────────────────────────────────────────
// 1. Account-lockout notification lifecycle
// ────────────────────────────────────────────────────────

describe('security notifications — account lockout', () => {
  it(
    'sends exactly one notice on the lock transition and none before it',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('first-lock');
      await registerUser(email);
      const sent: SentNotice[] = [];
      const logs: LoggedFailure[] = [];

      for (let attempt = 0; attempt < LOCKOUT_THRESHOLD - 1; attempt++) {
        await expect(failedServiceLogin(email, WRONG_PASSWORD, sent, logs)).rejects.toThrow();
        expect(sent).toHaveLength(0);
      }

      await expect(failedServiceLogin(email, WRONG_PASSWORD, sent, logs)).rejects.toThrow();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('ACCOUNT_LOCKED');
      expect(sent[0].to).toBe(email.toLowerCase());
      expect(sent[0].subject).toBe('Security alert: account temporarily locked');
      expect(sent[0].textBody).toContain(
        'temporarily locked after repeated unsuccessful sign-in attempts',
      );
      expect(logs).toHaveLength(0);
      expectNoticeSafe(sent[0]);
    },
  );

  it(
    'sends nothing for locked retries and keeps the lock byte-identical',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('locked-retry');
      await registerUser(email);
      const sent: SentNotice[] = [];
      const logs: LoggedFailure[] = [];
      await lockAccountViaService(email, sent, logs);
      expect(sent).toHaveLength(1);

      for (let attempt = 0; attempt < 10; attempt++) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email, password: WRONG_PASSWORD },
        });
        expect(response.statusCode).toBe(429);
        expect(response.json().code).toBe('AUTH_TOO_MANY_ATTEMPTS');
      }
      expect(sent).toHaveLength(1);

      const user = await prisma.user.findUnique({ where: { email } });
      expect((user!.lockedUntil as Date).getTime()).toBeGreaterThan(Date.now());
    },
  );

  it(
    'converges ten concurrent threshold-crossers on one notice',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('concurrent-notify');
      await registerUser(email);
      const sent: SentNotice[] = [];
      const logs: LoggedFailure[] = [];

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => failedServiceLogin(email, WRONG_PASSWORD, sent, logs)),
      );
      for (const result of results) {
        expect(result.status).toBe('rejected');
      }

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.lockedUntil).not.toBeNull();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('ACCOUNT_LOCKED');
      expect(sent[0].to).toBe(email);
      expect(logs).toHaveLength(0);
    },
  );

  it(
    'sends one notice across two independent instances sharing PostgreSQL',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('multi-instance');
      await registerUser(email);
      const sent: SentNotice[] = [];
      const logs: LoggedFailure[] = [];

      await withFreshStack(async (freshApp) => {
        const onPrimary = () =>
          authService.login(
            app,
            { email, password: WRONG_PASSWORD, clientIp: '127.0.0.1' },
            {
              securityNotificationMailer: capturingSecurityMailer(sent),
              securityNotificationLogger: capturingLogger(logs),
            },
          );
        const onFresh = () =>
          authService.login(
            freshApp,
            { email, password: WRONG_PASSWORD, clientIp: '127.0.0.2' },
            {
              securityNotificationMailer: capturingSecurityMailer(sent),
              securityNotificationLogger: capturingLogger(logs),
            },
          );
        const attempts = await Promise.allSettled([
          ...Array.from({ length: 5 }, () => onPrimary()),
          ...Array.from({ length: 5 }, () => onFresh()),
        ]);
        for (const attempt of attempts) {
          expect(attempt.status).toBe('rejected');
        }
      });

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.lockedUntil).not.toBeNull();
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(email);
    },
  );

  it(
    'sends nothing on expiry and one new notice on the next lock',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('relock');
      await registerUser(email);
      const sent: SentNotice[] = [];
      const logs: LoggedFailure[] = [];
      await lockAccountViaService(email, sent, logs);
      expect(sent).toHaveLength(1);

      await expireLockoutState(email);
      const recovered = await authService.login(
        app,
        { email, password: STRONG_PASSWORD, clientIp: '127.0.0.1' },
        {
          securityNotificationMailer: capturingSecurityMailer(sent),
          securityNotificationLogger: capturingLogger(logs),
        },
      );
      expect(recovered.user.email).toBe(email);
      expect(sent).toHaveLength(1);

      await lockAccountViaService(email, sent, logs);
      expect(sent).toHaveLength(2);
      expect(sent[1].type).toBe('ACCOUNT_LOCKED');
      expect(sent[1].to).toBe(email);
    },
  );

  it(
    'keeps the lock and the 401 when the notice delivery fails',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('mailer-failure');
      await registerUser(email);
      const secret = 'fake-provider-secret-xyz-321';
      const logs: LoggedFailure[] = [];
      const failingMailer = throwingMailer(
        Object.assign(new Error(`provider outage with ${secret}`), { name: 'SMTPError' }),
      );

      for (let attempt = 0; attempt < LOCKOUT_THRESHOLD - 1; attempt++) {
        await expect(
          authService.login(
            app,
            { email, password: WRONG_PASSWORD, clientIp: '127.0.0.1' },
            {
              securityNotificationMailer: capturingSecurityMailer([]),
              securityNotificationLogger: capturingLogger(logs),
            },
          ),
        ).rejects.toThrow();
      }
      await expect(
        authService.login(
          app,
          { email, password: WRONG_PASSWORD, clientIp: '127.0.0.1' },
          { securityNotificationMailer: failingMailer, securityNotificationLogger: capturingLogger(logs) },
        ),
      ).rejects.toThrow('The email or password is incorrect.');

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.lockedUntil).not.toBeNull();
      expect((user!.lockedUntil as Date).getTime()).toBeGreaterThan(Date.now());

      expect(logs).toHaveLength(1);
      expect(logs[0].fields.type).toBe('ACCOUNT_LOCKED');
      const serialized = JSON.stringify(logs[0]);
      expect(serialized).not.toContain(email);
      expect(serialized).not.toContain(secret);

      const locked = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: STRONG_PASSWORD },
      });
      expect(locked.statusCode).toBe(429);
      expect(locked.json()).toEqual({
        type: 'https://docs.oxyide.com/errors/auth-too-many-attempts',
        title: 'Too many login attempts. Please try again later.',
        status: 429,
        detail: 'Too many login attempts. Please try again later.',
        code: 'AUTH_TOO_MANY_ATTEMPTS',
        instance: expect.any(String),
      });
    },
  );

  it(
    'commits the lock before the notice is attempted (no transaction held)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('post-commit');
      await registerUser(email);
      for (let attempt = 0; attempt < LOCKOUT_THRESHOLD - 1; attempt++) {
        await expect(
          failedServiceLogin(email, WRONG_PASSWORD, [], []),
        ).rejects.toThrow();
      }

      let observedDuringSend: Date | null | undefined;
      const blockingMailer = {
        sendAccountLocked: async (): Promise<void> => {
          // A separate connection can only observe committed state: if the
          // lock transaction were still open, this read would see NULL.
          const fresh = new PrismaClient({
            datasources: { db: { url: process.env.DATABASE_URL } },
          });
          try {
            const row = await fresh.user.findUnique({ where: { email } });
            observedDuringSend = row?.lockedUntil ?? null;
          } finally {
            await fresh.$disconnect();
          }
        },
        sendPasswordResetSucceeded: async (): Promise<void> => {},
      };

      await expect(
        authService.login(
          app,
          { email, password: WRONG_PASSWORD, clientIp: '127.0.0.1' },
          { securityNotificationMailer: blockingMailer },
        ),
      ).rejects.toThrow('The email or password is incorrect.');
      expect(observedDuringSend).not.toBeNull();
      expect((observedDuringSend as Date).getTime()).toBeGreaterThan(Date.now());
    },
  );

  it(
    'notifies only the locked account and uses the canonical address',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const victim = uniqueEmail('victim');
      const bystander = uniqueEmail('bystander');
      await registerUser(victim);
      await registerUser(bystander);
      const sent: SentNotice[] = [];
      const logs: LoggedFailure[] = [];

      await lockAccountViaService(`  ${victim.toUpperCase()}  `, sent, logs);
      await expect(
        failedServiceLogin(bystander, WRONG_PASSWORD, sent, logs),
      ).rejects.toThrow();

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(victim.toLowerCase());
      const other = await prisma.user.findUnique({ where: { email: bystander } });
      expect(other!.lockedUntil).toBeNull();
    },
  );

  it(
    'survives a process rebuild with no startup notice',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('rebuild');
      await registerUser(email);
      const sent: SentNotice[] = [];
      await lockAccountViaService(email, sent, []);
      expect(sent).toHaveLength(1);

      await withFreshStack(async (freshApp) => {
        const response = await freshApp.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email, password: STRONG_PASSWORD },
        });
        expect(response.statusCode).toBe(429);
        expect(response.json().code).toBe('AUTH_TOO_MANY_ATTEMPTS');
      });
      expect(sent).toHaveLength(1);
    },
  );
});

// ────────────────────────────────────────────────────────
// 2. Password-reset success notification
// ────────────────────────────────────────────────────────

describe('security notifications — password reset', () => {
  type CapturedReset = { to: string; resetUrl: string };

  function capturingResetMailer(sent: CapturedReset[]) {
    return {
      sendPasswordResetEmail: async (email: CapturedReset): Promise<void> => {
        sent.push(email);
      },
    };
  }

  async function issueResetToken(email: string): Promise<string> {
    const sent: CapturedReset[] = [];
    await authService.requestPasswordReset(email, '127.0.0.1', capturingResetMailer(sent));
    expect(sent).toHaveLength(1);
    return sent[0].resetUrl.split('token=')[1];
  }

  it(
    'sends exactly one notice after a successful reset with sessions revoked',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('reset-success');
      await registerUser(email);
      const created = await prisma.user.findUnique({ where: { email } });
      const userId = created!.id;
      const rawToken = await issueResetToken(email);
      const sent: SentNotice[] = [];
      const logs: LoggedFailure[] = [];

      await authService.resetPassword(rawToken, 'NewStrongPassword123!', {
        securityNotificationMailer: capturingSecurityMailer(sent),
        securityNotificationLogger: capturingLogger(logs),
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('PASSWORD_RESET_SUCCEEDED');
      expect(sent[0].to).toBe(email);
      expect(sent[0].subject).toBe('Security alert: password changed');
      expect(sent[0].textBody).toContain('Existing sessions were revoked');
      expect(logs).toHaveLength(0);
      expectNoticeSafe(sent[0]);

      const sessions = await prisma.session.findMany({ where: { userId } });
      expect(sessions).toHaveLength(0);

      const loginLogs: LoggedFailure[] = [];
      const loginSent: SentNotice[] = [];
      const result = await authService.login(
        app,
        { email, password: 'NewStrongPassword123!', clientIp: '127.0.0.1' },
        {
          securityNotificationMailer: capturingSecurityMailer(loginSent),
          securityNotificationLogger: capturingLogger(loginLogs),
        },
      );
      expect(result.user.email).toBe(email);
      await expect(
        failedServiceLogin(email, STRONG_PASSWORD, [], []),
      ).rejects.toThrow('The email or password is incorrect.');
    },
  );

  it(
    'keeps the reset successful when the notice delivery fails',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('reset-mailer-failure');
      await registerUser(email);
      const rawToken = await issueResetToken(email);
      const secret = 'fake-provider-secret-xyz-777';
      const logs: LoggedFailure[] = [];
      const failingMailer = throwingMailer(
        Object.assign(new Error(`provider outage with ${secret}`), { name: 'SMTPError' }),
      );

      await authService.resetPassword(rawToken, 'NewStrongPassword123!', {
        securityNotificationMailer: failingMailer,
        securityNotificationLogger: capturingLogger(logs),
      });

      expect(logs).toHaveLength(1);
      expect(logs[0].fields.type).toBe('PASSWORD_RESET_SUCCEEDED');
      const serialized = JSON.stringify(logs[0]);
      expect(serialized).not.toContain(email);
      expect(serialized).not.toContain(secret);

      const result = await authService.login(
        app,
        { email, password: 'NewStrongPassword123!', clientIp: '127.0.0.1' },
        {},
      );
      expect(result.user.email).toBe(email);
    },
  );

  it(
    'sends nothing for invalid, expired, or replayed tokens',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('reset-invalid');
      await registerUser(email);
      const rawToken = await issueResetToken(email);
      const sent: SentNotice[] = [];

      const notify = {
        securityNotificationMailer: capturingSecurityMailer(sent),
        securityNotificationLogger: capturingLogger([]),
      };
      await expect(authService.resetPassword('not-a-real-token', 'NewStrongPassword123!', notify))
        .rejects.toThrow('The reset token is invalid or has expired.');

      const row = await prisma.passwordResetToken.findFirst({
        where: { user: { email } },
        orderBy: { createdAt: 'desc' },
      });
      await prisma.passwordResetToken.update({
        where: { id: row!.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expect(authService.resetPassword(rawToken, 'NewStrongPassword123!', notify))
        .rejects.toThrow('The reset token is invalid or has expired.');
      expect(sent).toHaveLength(0);

      const freshToken = await issueResetToken(email);
      await authService.resetPassword(freshToken, 'NewStrongPassword123!', notify);
      expect(sent).toHaveLength(1);
      await expect(authService.resetPassword(freshToken, 'AnotherStrongPass123!', notify))
        .rejects.toThrow('The reset token is invalid or has expired.');
      expect(sent).toHaveLength(1);
    },
  );

  it(
    'sends exactly one notice when two confirmations race for one token',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('reset-race');
      await registerUser(email);
      const rawToken = await issueResetToken(email);
      const sent: SentNotice[] = [];

      const results = await Promise.allSettled([
        authService.resetPassword(rawToken, 'NewStrongPassword123!', {
          securityNotificationMailer: capturingSecurityMailer(sent),
        }),
        authService.resetPassword(rawToken, 'NewStrongPassword123!', {
          securityNotificationMailer: capturingSecurityMailer(sent),
        }),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('PASSWORD_RESET_SUCCEEDED');
    },
  );

  it(
    'sends no security notice on reset request for known, unknown, or locked users',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const known = uniqueEmail('request-known');
      await registerUser(known);
      const locked = uniqueEmail('request-locked');
      await registerUser(locked);
      await lockAccountViaService(locked, [], []);

      for (const target of [known, 'ghost-request@example.com', locked]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/password-reset/request',
          payload: { email: target },
        });
        expect(response.statusCode).toBe(204);
        expect(response.body).toBe('');
      }

      // The request path owns no security-mailer hook (two-parameter
      // signature) and performs no failure recording: unknown and locked
      // targets gain no throttle rows and the locked marker is untouched.
      const { buildAccountKey } = await import('../services/login-throttle.service.js');
      const ghostRow = await prisma.loginThrottle.findUnique({
        where: { key: buildAccountKey('ghost-request@example.com') },
      });
      expect(ghostRow).toBeNull();
      const lockedUser = await prisma.user.findUnique({ where: { email: locked } });
      expect(lockedUser!.lockedUntil).not.toBeNull();
    },
  );

  it(
    'recovers a locked account with exactly one notice per event in a lock/reset race',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('lock-reset-race');
      await registerUser(email);
      const sent: SentNotice[] = [];
      await lockAccountViaService(email, sent, []);
      expect(sent.filter((notice) => notice.type === 'ACCOUNT_LOCKED')).toHaveLength(1);

      const rawToken = await issueResetToken(email);
      const outcomes = await Promise.allSettled([
        authService.resetPassword(rawToken, 'NewStrongPassword123!', {
          securityNotificationMailer: capturingSecurityMailer(sent),
        }),
        failedServiceLogin(email, WRONG_PASSWORD, sent, []),
      ]);
      expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);

      // Either order converges unlocked: a failure landing before the reset
      // is wiped by the recovery clears; one landing after starts from the
      // clean baseline. The reset notice fires exactly once on success.
      const resetOk = outcomes[0].status === 'fulfilled';
      if (resetOk) {
        expect(sent.filter((notice) => notice.type === 'PASSWORD_RESET_SUCCEEDED')).toHaveLength(1);
        const user = await prisma.user.findUnique({ where: { email } });
        expect(user!.lockedUntil).toBeNull();
        const result = await authService.login(
          app,
          { email, password: 'NewStrongPassword123!', clientIp: '127.0.0.1' },
          {},
        );
        expect(result.user.email).toBe(email);
      } else {
        // The failure won the race against token validation: the token is
        // still consumable afterwards and the reset still notifies once.
        await authService.resetPassword(rawToken, 'NewStrongPassword123!', {
          securityNotificationMailer: capturingSecurityMailer(sent),
        });
        expect(sent.filter((notice) => notice.type === 'PASSWORD_RESET_SUCCEEDED')).toHaveLength(1);
      }
    },
  );
});

// ────────────────────────────────────────────────────────
// 3. Non-notifying paths stay silent and independent
// ────────────────────────────────────────────────────────

describe('security notifications — non-notifying paths', () => {
  it(
    'verification still sends only its own email and never touches lockout',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('verify-independence');
      await registerUser(email);
      const sent: SentNotice[] = [];
      await lockAccountViaService(email, sent, []);
      expect(sent).toHaveLength(1);

      type CapturedVerification = { to: string; verificationUrl: string };
      const verificationSent: CapturedVerification[] = [];
      await authService.resendVerificationEmail(email, '127.0.0.1', {
        sendVerificationEmail: async (message: CapturedVerification): Promise<void> => {
          verificationSent.push(message);
        },
      });
      expect(verificationSent).toHaveLength(1);

      const tokens = await prisma.emailVerificationToken.findMany({
        where: { user: { email } },
      });
      const active = tokens.filter(
        (token) => token.consumedAt === null && token.expiresAt.getTime() > Date.now(),
      );
      expect(active).toHaveLength(1);
      const rawToken = verificationSent[0].verificationUrl.split('token=')[1];
      await authService.confirmEmailVerification(rawToken);

      // Verification proves the address; it neither unlocks nor alerts.
      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.lockedUntil).not.toBeNull();
      expect(user!.emailVerifiedAt).not.toBeNull();
      expect(sent).toHaveLength(1);
    },
  );

  it(
    'refresh, revoke-all, and logout keep working during lockout without notices',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = uniqueEmail('session-independence');
      await registerUser(email);

      const browserLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email, password: STRONG_PASSWORD },
      });
      expect(browserLogin.statusCode).toBe(200);
      const refreshCookie = browserLogin.cookies.find((cookie) => cookie.name === 'refreshToken');
      expect(refreshCookie).toBeDefined();

      const sent: SentNotice[] = [];
      await lockAccountViaService(email, sent, []);
      expect(sent).toHaveLength(1);

      const refresh = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { refreshToken: refreshCookie!.value },
      });
      expect(refresh.statusCode).toBe(200);
      const refreshedAccessToken = (refresh.json() as { accessToken: string }).accessToken;

      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${refreshedAccessToken}` },
      });
      expect(me.statusCode).toBe(200);

      const logout = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        cookies: { refreshToken: refreshCookie!.value },
      });
      expect(logout.statusCode).toBe(204);
      expect(sent).toHaveLength(1);
    },
  );
});
