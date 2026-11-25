import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

/**
 * M11.3 — composition tests.
 *
 * `config` is parsed at module load from `process.env`, so transport
 * selection is exercised by re-importing the composition module with a fresh
 * module graph and a controlled environment. Nodemailer is mocked: this suite
 * proves WHICH transport is selected and what it is handed — never that SMTP
 * itself works (M11.2 owns that).
 */

vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({
    sendMail: vi.fn(async () => ({ messageId: '<mocked@localhost>' })),
    close: vi.fn(),
  })),
}));

const SMTP_ENV = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_SECURITY: 'starttls',
} as const;

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURITY'] as const;

/**
 * Imports the composition module with the given SMTP environment, restoring
 * the caller's environment afterwards. Returns a FRESH nodemailer mock: a
 * module reset gives each load its own mock instance, so call counts never
 * leak between cases.
 */
async function loadWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    const composition = await import('./auth-email-composition.js');
    const nodemailer = await import('nodemailer');
    const passwordResetService = await import('../services/password-reset.service.js');
    const emailVerificationService = await import('../services/email-verification.service.js');
    const securityNotificationService = await import('../services/security-notification.service.js');
    // A module reset does not necessarily hand back a fresh mock instance, so
    // call history is cleared explicitly: each case asserts only its own sends.
    vi.mocked(nodemailer.createTransport).mockClear();
    return {
      composition,
      nodemailer,
      passwordResetService,
      emailVerificationService,
      securityNotificationService,
    };
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const RESET_REQUEST = {
  to: 'user@example.com',
  resetUrl: 'https://app.example.com/reset-password?token=sentinel-q7w2',
};

describe('sender derivation', () => {
  it('derives no-reply from the validated application host', async () => {
    const { composition } = await loadWithEnv({});

    expect(composition.defaultSenderAddress('https://app.example.com')).toBe(
      'no-reply@app.example.com',
    );
  });

  it('ignores scheme, port, and path — only the host is identity', async () => {
    const { composition } = await loadWithEnv({});

    expect(composition.defaultSenderAddress('https://app.example.com:8443/base/')).toBe(
      'no-reply@app.example.com',
    );
  });

  it('produces a deterministic, credential-free address', async () => {
    const { composition } = await loadWithEnv({});
    const sender = composition.defaultSenderAddress('https://customer.example.com');

    expect(sender).toBe(composition.defaultSenderAddress('https://customer.example.com'));
    for (const forbidden of ['password', 'secret', '@smtp', 'token']) {
      expect(sender, `sender leaked ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('transport selection without SMTP', () => {
  it('returns the frozen M3 NoOp ports verbatim', async () => {
    const {
      composition,
      nodemailer,
      passwordResetService,
      emailVerificationService,
      securityNotificationService,
    } = await loadWithEnv({
      SMTP_HOST: undefined,
      SMTP_PORT: undefined,
      SMTP_SECURITY: undefined,
    });

    expect(composition.authEmailMailers.passwordReset).toBe(
      passwordResetService.noopPasswordResetMailer,
    );
    expect(composition.authEmailMailers.emailVerification).toBe(
      emailVerificationService.noopEmailVerificationMailer,
    );
    expect(composition.authEmailMailers.securityNotification).toBe(
      securityNotificationService.noopSecurityNotificationMailer,
    );
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('delivers nothing and constructs no message', async () => {
    const { composition, nodemailer } = await loadWithEnv({
      SMTP_HOST: undefined,
      SMTP_PORT: undefined,
      SMTP_SECURITY: undefined,
    });

    await expect(
      composition.authEmailMailers.passwordReset.sendPasswordResetEmail(RESET_REQUEST),
    ).resolves.toBeUndefined();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
});

describe('transport selection with SMTP configured', () => {
  it('adapts the domain ports onto the SMTP transport', async () => {
    const { composition, nodemailer, passwordResetService } = await loadWithEnv(SMTP_ENV);

    expect(composition.authEmailMailers.passwordReset).not.toBe(
      passwordResetService.noopPasswordResetMailer,
    );

    await composition.authEmailMailers.passwordReset.sendPasswordResetEmail(RESET_REQUEST);

    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
  });

  it('passes validated transport options and never a plaintext downgrade', async () => {
    const { composition, nodemailer } = await loadWithEnv(SMTP_ENV);

    await composition.authEmailMailers.passwordReset.sendPasswordResetEmail(RESET_REQUEST);

    const options = vi.mocked(nodemailer.createTransport).mock.calls[0]?.[0];
    expect(options).toMatchObject({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
    });
    expect(JSON.stringify(options)).not.toContain('rejectUnauthorized');
  });

  it('hands the transport one message with the derived sender and the reset link', async () => {
    const { composition, nodemailer } = await loadWithEnv(SMTP_ENV);

    await composition.authEmailMailers.passwordReset.sendPasswordResetEmail(RESET_REQUEST);

    const transporter = vi.mocked(nodemailer.createTransport).mock.results[0]?.value as {
      sendMail: ReturnType<typeof vi.fn>;
    };
    const sent = transporter.sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      from: composition.defaultSenderAddress(process.env.APP_BASE_URL ?? ''),
      to: ['user@example.com'],
      subject: 'Reset your Oxyide password',
    });
    expect(sent['text']).toContain(RESET_REQUEST.resetUrl);
  });

  it('never leaks SMTP credentials into the delivered message', async () => {
    const { composition, nodemailer } = await loadWithEnv({
      ...SMTP_ENV,
      SMTP_USER: 'forge-user',
      SMTP_PASSWORD: 'smtp-sentinel-secret-k7x2',
    });

    await composition.authEmailMailers.passwordReset.sendPasswordResetEmail(RESET_REQUEST);

    const transporter = vi.mocked(nodemailer.createTransport).mock.results[0]?.value as {
      sendMail: ReturnType<typeof vi.fn>;
    };
    const sent = JSON.stringify(transporter.sendMail.mock.calls[0]?.[0]);
    for (const secret of ['smtp-sentinel-secret-k7x2', 'forge-user']) {
      expect(sent, `message leaked ${secret}`).not.toContain(secret);
    }
  });

  it('delivers each of the three ports exactly one message', async () => {
    const { composition, nodemailer } = await loadWithEnv(SMTP_ENV);

    await composition.authEmailMailers.passwordReset.sendPasswordResetEmail(RESET_REQUEST);
    await composition.authEmailMailers.emailVerification.sendVerificationEmail({
      to: 'user@example.com',
      verificationUrl: 'https://app.example.com/verify-email?token=sentinel-r3m8',
    });
    await composition.authEmailMailers.securityNotification.sendAccountLocked({
      to: 'user@example.com',
      lockoutDurationText: '30 minutes',
    });

    expect(vi.mocked(nodemailer.createTransport)).toHaveBeenCalledTimes(3);
  });
});

describe('composition is transport-agnostic to callers', () => {
  it('the SMTP environment does not change the domain port shapes services see', async () => {
    const withoutSmtp = await loadWithEnv({});
    const withSmtp = await loadWithEnv(SMTP_ENV);

    for (const mailer of ['passwordReset', 'emailVerification', 'securityNotification'] as const) {
      // The shape the auth services depend on is identical either way; only the
      // implementation behind it differs.
      expect(Object.keys(withSmtp.composition.authEmailMailers[mailer]).sort()).toEqual(
        Object.keys(withoutSmtp.composition.authEmailMailers[mailer]).sort(),
      );
    }
  });
});

describe('configuration coherence is enforced upstream', () => {
  it('a partial SMTP group is rejected by configuration, never silently composed', async () => {
    const { envSchema } = await import('../../../config/env.schema.js');

    expect(() =>
      envSchema.parse({
        DATABASE_URL: 'postgresql://localhost:5432/oxyide_test',
        JWT_SECRET: 'test-jwt-secret-key-min-32-chars-long',
        ...SMTP_ENV,
        SMTP_SECURITY: undefined,
      }),
    ).toThrow(/SMTP_SECURITY/);
  });

  it('the composition module reads no SMTP variable directly', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./auth-email-composition.ts', import.meta.url), 'utf8');

    for (const key of SMTP_KEYS) {
      expect(source, `composition reads ${key} directly`).not.toContain(`env.${key}`);
      expect(source).not.toContain(`process.env.${key}`);
    }
  });
});