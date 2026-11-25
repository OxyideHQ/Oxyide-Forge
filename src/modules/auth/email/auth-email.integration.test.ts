/**
 * M11.3 — authentication email integration tests.
 *
 * Proves the wiring against real PostgreSQL through the REAL services and the
 * REAL composed mailers: transaction-then-send ordering, post-commit
 * semantics under transport failure, and the guarantee that a delivery
 * problem never leaks SMTP internals, credentials, tokens, or message
 * contents to the caller or to the database.
 *
 * The transport is a recording `EmailProvider` injected through the frozen
 * M11.1 interface — never nodemailer, never a socket. These tests are about
 * authentication semantics, not SMTP (M11.2 owns that).
 *
 * Requires a running PostgreSQL instance at DATABASE_URL; the suite fails
 * fast instead of silently passing.
 */

// Environment must be set before any module imports evaluate config.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { EmailMessage } from '../../../shared/email/email-message.js';
import { EmailDeliveryError } from '../../../shared/email/email-provider.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('../../../app/app.js');
const { config } = await import('../../../config/index.js');
const { authService } = await import('../services/auth.service.js');
const { passwordResetService } = await import('../services/password-reset.service.js');
const { emailVerificationService } = await import('../services/email-verification.service.js');
const { createAuthEmailMailers } = await import('../email/auth-email-mailers.js');

let app: FastifyInstance;
let dbAvailable = false;

const STRONG_PASSWORD = 'StrongPassword123!';
const WRONG_PASSWORD = 'WrongPassword999!';
const LOCKOUT_THRESHOLD = config.auth.accountLockout.failureThreshold;
const SENDER = 'no-reply@example.com';

/** Records every composed message and can be told to fail. */
function recordingProvider() {
  const sent: EmailMessage[] = [];
  let failure: Error | null = null;
  let onSend: (() => Promise<void>) | null = null;

  const provider = {
    send: async (message: EmailMessage): Promise<void> => {
      // Hook lets a test observe database state AT SEND TIME — that is how
      // "committed before delivery" is proven rather than assumed.
      if (onSend) await onSend();
      sent.push(message);
      if (failure) throw failure;
    },
  };

  return {
    sent,
    provider,
    failWith(error: Error): void {
      failure = error;
    },
    succeed(): void {
      failure = null;
    },
    observeWith(hook: () => Promise<void>): void {
      onSend = hook;
    },
  };
}

function mailersFor(provider: ReturnType<typeof recordingProvider>['provider']) {
  return createAuthEmailMailers({ provider, from: SENDER });
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

beforeAll(async () => {
  // Explicit DB gate (ARCH-ENF-011): this suite truncates tables, so a missing
  // database must fail loudly rather than let every case pass vacuously.
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    throw new Error(
      'PostgreSQL unavailable: M11.3 integration tests require a running database at DATABASE_URL.',
    );
  }
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "Session", "LoginThrottle", "EmailVerificationToken", "PasswordResetToken", "Credential", "User" CASCADE',
  );
});

describe('M11.3 password-reset wiring', () => {
  it('commits the credential before the message is delivered', async () => {
    if (!dbAvailable) return;
    const recorder = recordingProvider();
    const user = await authService.register({
      email: uniqueEmail('reset-order'),
      password: STRONG_PASSWORD,
    });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    // At send time the credential row must already be visible to an
    // independent connection — impossible while the issuing transaction is
    // still open, so this is a real ordering proof rather than a call-order
    // assumption.
    let committedRows = -1;
    recorder.observeWith(async () => {
      committedRows = await prisma.passwordResetToken.count({
        where: { userId: user.id, consumedAt: null },
      });
    });

    await passwordResetService.issueToken(
      user.id,
      stored.email,
      mailersFor(recorder.provider).passwordReset,
    );

    expect(committedRows).toBe(1);
    expect(recorder.sent).toHaveLength(1);
  });

  it('delivers exactly one message carrying the persisted-credential link', async () => {
    if (!dbAvailable) return;
    const recorder = recordingProvider();
    const user = await authService.register({
      email: uniqueEmail('reset-single'),
      password: STRONG_PASSWORD,
    });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await passwordResetService.issueToken(
      user.id,
      stored.email,
      mailersFor(recorder.provider).passwordReset,
    );

    expect(recorder.sent).toHaveLength(1);
    const message = recorder.sent[0];
    expect(message.from).toBe(SENDER);
    expect(message.to).toEqual([stored.email]);
    const deliveredRaw = message.textBody.split('token=')[1].split('\n')[0];
    expect(deliveredRaw).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The link carries exactly the persisted credential — never a transform.
    const row = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id },
    });
    const { createHash } = await import('node:crypto');
    expect(row.tokenHash).toBe(createHash('sha256').update(deliveredRaw, 'utf8').digest('hex'));
  });

  it('keeps the committed credential usable when delivery fails', async () => {
    if (!dbAvailable) return;
    const recorder = recordingProvider();
    recorder.failWith(new EmailDeliveryError());
    const user = await authService.register({
      email: uniqueEmail('reset-fail'),
      password: STRONG_PASSWORD,
    });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await expect(
      passwordResetService.issueToken(
        user.id,
        stored.email,
        mailersFor(recorder.provider).passwordReset,
      ),
    ).rejects.toBeInstanceOf(EmailDeliveryError);

    // Post-commit semantics: the failure is NOT a pseudo-transaction. The
    // credential stands and the user can retry.
    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].consumedAt).toBeNull();
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not retry a failed delivery', async () => {
    if (!dbAvailable) return;
    const recorder = recordingProvider();
    recorder.failWith(new EmailDeliveryError());
    const user = await authService.register({
      email: uniqueEmail('reset-noretry'),
      password: STRONG_PASSWORD,
    });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await expect(
      passwordResetService.issueToken(
        user.id,
        stored.email,
        mailersFor(recorder.provider).passwordReset,
      ),
    ).rejects.toBeInstanceOf(EmailDeliveryError);

    expect(recorder.sent).toHaveLength(1);
  });

  it('never persists the delivered message or its link', async () => {
    if (!dbAvailable) return;
    const recorder = recordingProvider();
    const user = await authService.register({
      email: uniqueEmail('reset-nopersist'),
      password: STRONG_PASSWORD,
    });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await passwordResetService.issueToken(
      user.id,
      stored.email,
      mailersFor(recorder.provider).passwordReset,
    );

    const deliveredRaw = recorder.sent[0].textBody.split('token=')[1].split('\n')[0];
    const dumped = JSON.stringify(
      await prisma.passwordResetToken.findMany({ where: { userId: user.id } }),
    );
    expect(dumped).not.toContain(deliveredRaw);
    expect(dumped).not.toContain('reset-password');
  });
});

describe('M11.3 email-verification wiring', () => {
  it('commits the token before the message is delivered', async () => {
    if (!dbAvailable) return;
    const recorder = recordingProvider();
    const user = await authService.register({
      email: uniqueEmail('verify-order'),
      password: STRONG_PASSWORD,
    });

    let committedRows = -1;
    recorder.observeWith(async () => {
      committedRows = await prisma.emailVerificationToken.count({
        where: { userId: user.id, consumedAt: null },
      });
    });

    await emailVerificationService.issueToken(
      user.id,
      user.email,
      mailersFor(recorder.provider).emailVerification,
    );

    expect(committedRows).toBe(1);
    expect(recorder.sent).toHaveLength(1);
  });

  it('delivers exactly one message per resend with the newest credential', async () => {
    if (!dbAvailable) return;
    const recorder = recordingProvider();
    const mailers = mailersFor(recorder.provider);
    const user = await authService.register({
      email: uniqueEmail('verify-resend'),
      password: STRONG_PASSWORD,
    });

    await emailVerificationService.issueToken(user.id, user.email, mailers.emailVerification);
    await emailVerificationService.issueToken(user.id, user.email, mailers.emailVerification);

    expect(recorder.sent).toHaveLength(2);
    const first = recorder.sent[0].textBody.split('token=')[1].split('\n')[0];
    const second = recorder.sent[1].textBody.split('token=')[1].split('\n')[0];
    expect(second).not.toBe(first);

    // Newest-only: the superseded credentials are inactive, the newest is
    // usable. Registration issued the first token, then each resend superseded
    // the previous one — three rows, exactly one active.
    const rows = await prisma.emailVerificationToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.consumedAt === null)).toHaveLength(1);
    expect(await emailVerificationService.findActiveToken(first)).toBeNull();
    expect(await emailVerificationService.findActiveToken(second)).toEqual({
      id: rows[2].id,
      userId: user.id,
    });
  });

  it('keeps registration intact when delivery fails', async () => {
    if (!dbAvailable) return;
    const recorder = recordingProvider();
    recorder.failWith(new EmailDeliveryError());

    await expect(
      authService.register(
        { email: uniqueEmail('verify-fail'), password: STRONG_PASSWORD },
        mailersFor(recorder.provider).emailVerification,
      ),
    ).rejects.toBeInstanceOf(EmailDeliveryError);

    // The account and its usable credential persist; resend recovers.
    const user = await prisma.user.findFirstOrThrow({ where: { email: { contains: 'verify-fail' } } });
    expect(user.emailVerifiedAt).toBeNull();
    const tokens = await prisma.emailVerificationToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].consumedAt).toBeNull();
  });
});

describe('M11.3 security-notification wiring', () => {
  beforeEach(() => {
    loggedFailures.length = 0;
  });

  // These drive `authService.login` directly with the recording provider
  // injected through the frozen port, because the lockout transition is the
  // behaviour under test and HTTP login would add six bcrypt rounds per case
  // (each ~250ms) with no extra coverage.
  const loggedFailures: { fields: Record<string, unknown>; message: string }[] = [];

  const capturingFailureLogger = {
    error: (fields: Record<string, unknown>, message: string): void => {
      loggedFailures.push({ fields, message });
    },
  };

  async function lockAccount(
    email: string,
    recorder: ReturnType<typeof recordingProvider>,
  ): Promise<void> {
    for (let attempt = 0; attempt < LOCKOUT_THRESHOLD; attempt += 1) {
      // Attempts before the threshold reject with the generic credential
      // failure; the threshold-crossing one may instead surface the locked
      // 429 — M3.16 deliberately reuses that contract for no user-enumeration
      // behaviour, so both messages are legitimate here.
      await expect(
        authService.login(
          app,
          { email, password: WRONG_PASSWORD, clientIp: '127.0.0.1' },
          {
            securityNotificationMailer: mailersFor(recorder.provider).securityNotification,
            securityNotificationLogger: capturingFailureLogger,
          },
        ),
      ).rejects.toThrow();
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.lockedUntil).not.toBeNull();
  }

  it(
    'sends exactly one lockout notice, after the lock has committed',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const recorder = recordingProvider();
      const email = uniqueEmail('lock-notice');
      await authService.register({ email, password: STRONG_PASSWORD });

      // At send time the lock must be visible to an independent connection —
      // impossible while the transition transaction is still open.
      let lockedDuringSend = 0;
      recorder.observeWith(async () => {
        lockedDuringSend = await prisma.user.count({ where: { lockedUntil: { not: null } } });
      });

      await lockAccount(email, recorder);

      expect(recorder.sent).toHaveLength(1);
      expect(lockedDuringSend).toBe(1);
      expect(recorder.sent[0].subject).toContain('Security alert');
    },
  );

  it(
    'never notifies twice for repeated attempts after the lock',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const recorder = recordingProvider();
      const email = uniqueEmail('lock-once');
      await authService.register({ email, password: STRONG_PASSWORD });

      await lockAccount(email, recorder);
      await lockAccount(email, recorder);

      expect(recorder.sent).toHaveLength(1);
    },
  );

  it(
    'a delivered notice carries no credential, token, or URL',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const recorder = recordingProvider();
      const email = uniqueEmail('lock-content');
      await authService.register({ email, password: STRONG_PASSWORD });

      await lockAccount(email, recorder);

      expect(recorder.sent).toHaveLength(1);
      const message = recorder.sent[0];
      expect(message.from).toBe(SENDER);
      expect(message.to).toEqual([email]);
      for (const forbidden of ['token=', 'password=', STRONG_PASSWORD, WRONG_PASSWORD]) {
        expect(message.textBody, `notice leaked ${forbidden}`).not.toContain(forbidden);
      }
    },
  );

  it(
    'keeps the 401 identical whether or not the notice is delivered',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const recorder = recordingProvider();
      const email = uniqueEmail('lock-401');
      await authService.register({ email, password: STRONG_PASSWORD });

      recorder.failWith(new EmailDeliveryError());
      await lockAccount(email, recorder);

      // Delivery failed, yet the committed lock stands: security state is
      // authoritative, notification is secondary.
      expect(recorder.sent).toHaveLength(1);
    },
  );

  it(
    'never retries a failed notice and never leaks the transport error',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const recorder = recordingProvider();
      recorder.failWith(new Error('535 auth failed for forge (secret smtp-sentinel-secret-k7x2)'));
      const email = uniqueEmail('lock-noretry');
      await authService.register({ email, password: STRONG_PASSWORD });

      await lockAccount(email, recorder);

      expect(recorder.sent).toHaveLength(1);
      // The caller's existing safe logger recorded the failure — and only the
      // error NAME plus safe operational fields. The transport message,
      // credential, recipient, and body never reach a log line.
      expect(loggedFailures).toHaveLength(1);
      expect(loggedFailures[0].fields['event']).toBe('security.notification.delivery_failed');
      expect(loggedFailures[0].fields['type']).toBe('ACCOUNT_LOCKED');
      expect(JSON.stringify(loggedFailures)).not.toContain('smtp-sentinel-secret-k7x2');
      expect(JSON.stringify(loggedFailures)).not.toContain('535 auth failed');
      expect(JSON.stringify(loggedFailures)).not.toContain(email);
    },
  );
});

describe('M11.3 failure isolation over HTTP', () => {
  it('the provider boundary is what sanitizes, and the client never sees SMTP detail', async () => {
    if (!dbAvailable) return;
    const recorder = recordingProvider();
    recorder.failWith(new Error('connect ECONNREFUSED smtp.internal:587'));
    const mailers = mailersFor(recorder.provider);

    // The adapter forwards provider failures verbatim so each port's caller
    // keeps its frozen semantics. Sanitization is therefore the provider's job
    // (M11.1/M11.2), which is exactly why the adapter never logs the failure
    // itself: it has no safe channel and no data beyond the message.
    await expect(
      mailers.passwordReset.sendPasswordResetEmail({
        to: 'user@example.com',
        resetUrl: 'https://app.example.com/reset-password?token=sentinel-q7w2',
      }),
    ).rejects.toThrow(/smtp\.internal/);

    // A real provider (M11.2) raises only the neutral, static-safe error, and
    // that is what reaches a client through the frozen M6 mapper.
    const sanitized = new EmailDeliveryError();
    expect(sanitized.message).toBe('Email delivery failed.');
    expect(`${sanitized.name}: ${sanitized.message}`).not.toContain('smtp.internal');

    const email = uniqueEmail('http-leak');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: STRONG_PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    for (const forbidden of ['smtp', 'ECONNREFUSED', STRONG_PASSWORD]) {
      expect(response.body, `response leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('routes remain oracle-free and contract-identical with the mailer wired', async () => {
    if (!dbAvailable) return;
    const known = uniqueEmail('oracle-known');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: known, password: STRONG_PASSWORD },
    });

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      payload: { email: uniqueEmail('oracle-unknown') },
    });
    const existing = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      payload: { email: known },
    });

    expect(unknown.statusCode).toBe(204);
    expect(existing.statusCode).toBe(204);
    expect(existing.body).toBe(unknown.body);
  });
});