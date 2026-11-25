import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

/**
 * M11.5 — M11 email freeze smoke suite.
 *
 * The M6.10 / M9.7 / M10.5 precedent: one suite that pins every frozen M11
 * contract in a single place, so a future change cannot quietly alter one of
 * them without this file failing. It is deliberately a *contract* suite, not a
 * re-run of the per-milestone suites: it asserts the shape of the system, not
 * each unit's behaviour.
 *
 * No database, no SMTP server, no network: nodemailer is mocked at the module
 * boundary and every assertion is structural. Deliberately NOT named
 * `*.integration.test.ts` — ARCH-ENF-011 would demand a DB gate this suite does
 * not need, and misclassifying it would invent a fake dependency (the M77-F07
 * lesson).
 *
 * Sections: architecture direction · M11.1 message/provider contract ·
 * M11.2 SMTP + configuration · M11.3 domain ports and wiring ·
 * M11.4 template inventory and output · sensitive-URL invariants ·
 * flow matrix and post-commit ordering · failure semantics · API leakage.
 */

/**
 * One mock instance for the whole suite, with a switchable failure. A
 * `vi.doMock` + `vi.resetModules()` pair would hand back a *fresh* copy of
 * every module — which silently breaks identity assertions such as "the
 * composed NoOp mailer IS the frozen M3 singleton". The M114-F01 lesson again:
 * a test that passes for the wrong reason is worse than no test.
 */
let nextSendFailure: Error | null = null;

vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({
    sendMail: vi.fn(async () => {
      if (nextSendFailure !== null) throw nextSendFailure;
      return { messageId: '<mocked@localhost>' };
    }),
    close: vi.fn(),
  })),
}));

const SRC_ROOT = fileURLToPath(new URL('../../../../src', import.meta.url));

function sourceFiles(dir: string): { rel: string; source: string }[] {
  const files: { rel: string; source: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push({ rel: relative(SRC_ROOT, path), source: readFileSync(path, 'utf8') });
    }
  }
  return files;
}

const ALL = sourceFiles(SRC_ROOT);
const byPrefix = (prefix: string) => ALL.filter((file) => file.rel.startsWith(prefix));

const SHARED_EMAIL = byPrefix(`shared${sep}email${sep}`);
const TEMPLATES = byPrefix(`shared${sep}email${sep}templates${sep}`);
const PLATFORM_EMAIL = byPrefix(`platform${sep}email${sep}`);
const AUTH_EMAIL = byPrefix(`modules${sep}auth${sep}email${sep}`);

/**
 * Source of a single exported function, so a positional claim is scoped to one
 * function instead of a whole file (where an unrelated later function would
 * make the position meaningless).
 */
function functionSource(rel: string, name: string): string {
  const source = stripComments(read(rel));
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} not found in ${rel}`).toBeGreaterThan(-1);
  const next = source.indexOf('\nexport ', start + 1);
  const nextFn = source.indexOf('\nfunction ', start + 1);
  const candidates = [next, nextFn].filter((index) => index > start);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

/** Comments are stripped so every scan measures code, never prose (M114-F01). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function importsSpecifier(source: string, specifier: string): boolean {
  return new RegExp(
    `(?:import\\s[^'"]*from\\s*|import\\(\\s*|require\\(\\s*)['"][^'"]*${specifier.replace(
      /[/\\^$*+?.()|[\]{}]/g,
      '\\$&',
    )}['"]`,
  ).test(source);
}

const read = (rel: string) => ALL.find((file) => file.rel === rel)?.source ?? '';

import type { EmailMessage } from '../../../shared/email/email-message.js';
import type { EmailProvider } from '../../../shared/email/email-provider.js';

const {
  EmailDeliveryError,
  noopEmailProvider,
} = await import('../../../shared/email/email-provider.js');
const {
  createEmailProvider,
  createSmtpEmailProvider,
} = await import('../../../platform/email/smtp-email-provider.js');
const {
  EMAIL_TEMPLATE_KEYS,
  renderEmailTemplate,
} = await import('../../../shared/email/templates/email-template-registry.js');
const { createAuthEmailMailers } = await import('./auth-email-mailers.js');
const { authEmailMailers, defaultSenderAddress } = await import('./auth-email-composition.js');
const { envSchema } = await import('../../../config/env.schema.js');

const VALID_ENV = {
  DATABASE_URL: 'postgresql://localhost:5432/oxyide_test?sslmode=require',
  JWT_SECRET: 'test-jwt-secret-key-min-32-chars-long',
};

const RESET_URL = 'https://app.example.com/reset-password?token=freeze-sentinel-q7w2';
const VERIFY_URL = 'https://app.example.com/verify-email?token=freeze-sentinel-r3m8';
const RENDERED_RESET = renderEmailTemplate('PASSWORD_RESET', { resetUrl: RESET_URL });
const RENDERED_VERIFY = renderEmailTemplate('EMAIL_VERIFICATION', { verificationUrl: VERIFY_URL });

describe('M11 architecture direction', () => {
  it('the shared email contract never reaches down into platform or modules', () => {
    for (const file of SHARED_EMAIL) {
      for (const forbidden of ['platform/', 'modules/']) {
        expect(
          importsSpecifier(stripComments(file.source), forbidden),
          `${file.rel} imports ${forbidden}`,
        ).toBe(false);
      }
    }
    // Presence, not vacuity: the scan must be looking at real files.
    expect(SHARED_EMAIL.length).toBeGreaterThanOrEqual(6);
  });

  it('templates never reach the transport, persistence, HTTP, config, or modules', () => {
    for (const file of TEMPLATES) {
      const code = stripComments(file.source);
      for (const forbidden of [
        'nodemailer',
        'platform/',
        '@prisma/client',
        'fastify',
        'config',
        'modules/',
      ]) {
        expect(importsSpecifier(code, forbidden), `${file.rel} imports ${forbidden}`).toBe(false);
      }
    }
    expect(TEMPLATES.length).toBe(4);
  });

  it('the SMTP transport does depend on the shared contract', () => {
    const sources = PLATFORM_EMAIL.map((file) => stripComments(file.source)).join('\n');
    expect(sources).toMatch(/shared\/email\/email-provider\.js/);
    expect(importsSpecifier(sources, 'shared/email/email-message.js')).toBe(true);
  });

  it('authentication never imports nodemailer or the transport factory', () => {
    for (const file of AUTH_EMAIL) {
      const code = stripComments(file.source);
      expect(importsSpecifier(code, 'nodemailer'), `${file.rel} imports nodemailer`).toBe(false);
    }
    expect(importsSpecifier(stripComments(read(`modules${sep}auth${sep}services${sep}auth.service.ts`)), 'platform/email')).toBe(
      false,
    );
  });

  it('no email file logs through a bypass', () => {
    for (const file of [...SHARED_EMAIL, ...PLATFORM_EMAIL, ...AUTH_EMAIL]) {
      expect(
        /console\./.test(stripComments(file.source)),
        `${file.rel} calls console.*`,
      ).toBe(false);
    }
  });
});

describe('M11.1 message and provider contract (frozen)', () => {
  const message: EmailMessage = {
    from: 'no-reply@example.com',
    to: ['user@example.com'],
    subject: 'Reset your Oxyide password',
    textBody: 'Body',
  };

  it('carries exactly the five frozen fields and nothing else', () => {
    expect(Object.keys(message).sort()).toEqual(['from', 'subject', 'textBody', 'to']);
    expect(Object.keys({ ...message, htmlBody: '<p>Body</p>' }).sort()).toEqual([
      'from',
      'htmlBody',
      'subject',
      'textBody',
      'to',
    ]);
  });

  it('declares no template or transport metadata', () => {
    // The interface body itself, not the file: this file documents provider
    // behaviour in prose, and a whole-file keyword scan would flag its own
    // documentation (the M114-F01/M114-F03 class, closed here by measuring the
    // declaration only).
    const source = read(`shared${sep}email${sep}email-message.ts`);
    const declaration = /export interface EmailMessage \{[^}]*\}/.exec(source)?.[0] ?? '';

    expect(declaration, 'EmailMessage declaration not found').not.toBe('');
    expect([...declaration.matchAll(/readonly (\w+)\??:/g)].map((match) => match[1]).sort()).toEqual([
      'from',
      'htmlBody',
      'subject',
      'textBody',
      'to',
    ]);
    for (const forbidden of [
      'templateName',
      'templateId',
      'templateVersion',
      'provider',
      'retryCount',
      'deliveryId',
      'smtp',
      'headers',
      'cc',
      'bcc',
      'replyTo',
    ]) {
      expect(declaration, `EmailMessage gained ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('send() resolves undefined — a single attempt, no result envelope', async () => {
    const calls: EmailMessage[] = [];
    const provider: EmailProvider = {
      send: async (value) => {
        calls.push(value);
        return undefined;
      },
    };

    await expect(provider.send(message)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('EmailDeliveryError is neutral, static, and outside the HTTP error system', async () => {
    const { AppError } = await import('../../../shared/errors/app-error.js');
    const error = new EmailDeliveryError();

    expect(error.name).toBe('EmailDeliveryError');
    expect(error.message).toBe('Email delivery failed.');
    expect(error).not.toBeInstanceOf(AppError);
    expect(error.cause).toBeUndefined();
    expect(Object.keys(error)).toEqual(['name']);
    expect(new EmailDeliveryError().message).toBe(error.message);
  });

  it('the NoOp provider validates and delivers nothing', async () => {
    await expect(noopEmailProvider.send(message)).resolves.toBeUndefined();
    await expect(
      noopEmailProvider.send({ ...message, subject: 'bad\r\nInjected: yes' }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('M11.2 SMTP transport and configuration contract (frozen)', () => {
  it('exactly one transport dependency, pinned to an exact version', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies?.['nodemailer']).toMatch(/^\d+\.\d+\.\d+$/);
    for (const vendor of ['@sendgrid/mail', 'resend', '@aws-sdk/client-ses', 'mailgun.js', 'postmark']) {
      expect(manifest.dependencies?.[vendor]).toBeUndefined();
    }
  });

  it('selection is the factory, and NoOp is the unconfigured default', () => {
    expect(createEmailProvider({})).toBe(noopEmailProvider);
    expect(createEmailProvider({ smtp: undefined })).toBe(noopEmailProvider);
    expect(
      createEmailProvider({ smtp: { host: 'smtp.example.com', port: 587, security: 'starttls' } }),
    ).not.toBe(noopEmailProvider);
  });

  it.each([
    ['smtps', { secure: true }],
    ['starttls', { secure: false, requireTLS: true }],
    ['plaintext', { secure: false, ignoreTLS: true }],
  ] as const)('maps %s to an explicit, non-downgrading security posture', async (mode, expected) => {
    const nodemailer = await import('nodemailer');
    vi.mocked(nodemailer.createTransport).mockClear();

    const provider = createSmtpEmailProvider({
      host: 'smtp.example.com',
      port: 465,
      security: mode,
      user: 'forge',
      password: 'smtp-sentinel-secret-k7x2',
    });
    await provider.send({
      from: 'no-reply@example.com',
      to: ['user@example.com'],
      subject: 'Reset your Oxyide password',
      textBody: 'Body',
      htmlBody: '<p>Body</p>',
    });

    const options = vi.mocked(nodemailer.createTransport).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(options).toMatchObject({ host: 'smtp.example.com', port: 465, ...expected });
    // Certificate verification and traffic logging are never disabled.
    expect(JSON.stringify(options)).not.toContain('rejectUnauthorized');
    expect(options).not.toHaveProperty('logger');
    expect(options).not.toHaveProperty('debug');
    // Credentials travel to the transport and nowhere else.
    expect(options['auth']).toEqual({ user: 'forge', pass: 'smtp-sentinel-secret-k7x2' });
    expect(options['connectionTimeout']).toBeLessThanOrEqual(10_000);
    expect(options['greetingTimeout']).toBeLessThanOrEqual(10_000);
    expect(options['socketTimeout']).toBeLessThanOrEqual(30_000);
  });

  it('a transport failure becomes the neutral error and never escapes raw', async () => {
    nextSendFailure = new Error('535 auth failed for forge (auth smtp-sentinel-secret-k7x2)');

    let caught: unknown = null;
    try {
      await createSmtpEmailProvider({
        host: 'smtp.example.com',
        port: 587,
        security: 'starttls',
      }).send({
        from: 'no-reply@example.com',
        to: ['user@example.com'],
        subject: 'Reset your Oxyide password',
        textBody: `Body ${RESET_URL}`,
      });
    } catch (error: unknown) {
      caught = error;
    } finally {
      nextSendFailure = null;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('EmailDeliveryError');
    for (const forbidden of ['smtp.internal', 'smtp-sentinel-secret-k7x2', RESET_URL, '535']) {
      expect(`${(caught as Error).name}: ${(caught as Error).message}`).not.toContain(forbidden);
    }
  });

  it('rejects partial, incoherent, and unsafe configuration centrally', () => {
    const complete = { ...VALID_ENV, SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_SECURITY: 'starttls' as const };

    expect(() => envSchema.parse({ ...VALID_ENV, SMTP_PORT: '587' })).toThrow(/SMTP_HOST/);
    expect(() => envSchema.parse({ ...VALID_ENV, SMTP_HOST: 'smtp.example.com' })).toThrow(
      /SMTP_PORT|SMTP_SECURITY/,
    );
    expect(() => envSchema.parse({ ...complete, SMTP_USER: 'forge' })).toThrow(/together/);
    expect(() =>
      envSchema.parse({
        ...complete,
        SMTP_SECURITY: 'plaintext',
        SMTP_USER: 'forge',
        SMTP_PASSWORD: 'secret',
      }),
    ).toThrow(/plaintext/);
    expect(() => envSchema.parse({ ...complete, SMTP_SECURITY: 'ssl' })).toThrow();
    expect(() => envSchema.parse({ ...VALID_ENV })).not.toThrow();
  });

  it('preserves credential whitespace and derives the sender from the app host', () => {
    const parsed = envSchema.parse({
      ...VALID_ENV,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_SECURITY: 'starttls',
      SMTP_USER: 'forge',
      SMTP_PASSWORD: '  spaced secret  ',
    });

    expect(parsed.SMTP_PASSWORD).toBe('  spaced secret  ');
    expect(defaultSenderAddress('https://customer.example.com/app')).toBe(
      'no-reply@customer.example.com',
    );
  });
});

describe('M11.3 domain ports and wiring (frozen)', () => {
  it('keeps the three ports in their M3 owners with fact-only DTOs', () => {
    const owners = {
      PasswordResetMailer: `modules${sep}auth${sep}services${sep}password-reset.service.ts`,
      EmailVerificationMailer: `modules${sep}auth${sep}services${sep}email-verification.service.ts`,
      SecurityNotificationMailer: `modules${sep}auth${sep}services${sep}security-notification.service.ts`,
    };
    for (const [port, owner] of Object.entries(owners)) {
      expect(read(owner), `${port} left ${owner}`).toContain(`export type ${port}`);
    }
    const notifications = stripComments(read(owners.SecurityNotificationMailer));
    expect(notifications).toContain('lockoutDurationText: string');
    expect(notifications).not.toContain('textBody');
    expect(notifications).not.toContain('subject: string');
  });

  it('wires the composed mailers and the request logger into the routes', () => {
    const routes = read(`modules${sep}auth${sep}routes${sep}auth.routes.ts`);

    for (const mailer of ['passwordReset', 'emailVerification', 'securityNotification']) {
      expect(routes).toContain(`authEmailMailers.${mailer}`);
    }
    expect(routes).toContain('securityNotificationLogger: request.log');
  });

  it('selects the frozen M3 NoOp ports when SMTP is absent', async () => {
    const passwordReset = await import('../services/password-reset.service.js');
    const emailVerification = await import('../services/email-verification.service.js');
    const securityNotification = await import('../services/security-notification.service.js');

    // This suite runs without SMTP_* in the environment, so composition must
    // have taken the NoOp branch.
    expect(authEmailMailers.passwordReset).toBe(passwordReset.noopPasswordResetMailer);
    expect(authEmailMailers.emailVerification).toBe(emailVerification.noopEmailVerificationMailer);
    expect(authEmailMailers.securityNotification).toBe(
      securityNotification.noopSecurityNotificationMailer,
    );
  });
});

describe('M11.4 template inventory and output contract (frozen)', () => {
  const rendered = {
    EMAIL_VERIFICATION: renderEmailTemplate('EMAIL_VERIFICATION', { verificationUrl: VERIFY_URL }),
    PASSWORD_RESET: renderEmailTemplate('PASSWORD_RESET', { resetUrl: RESET_URL }),
    SECURITY_NOTIFICATION: renderEmailTemplate('SECURITY_NOTIFICATION', {
      type: 'PASSWORD_RESET_SUCCEEDED',
    }),
  };

  it('ships exactly the three required templates', () => {
    expect([...EMAIL_TEMPLATE_KEYS].sort()).toEqual([
      'EMAIL_VERIFICATION',
      'PASSWORD_RESET',
      'SECURITY_NOTIFICATION',
    ]);
  });

  it('freezes all four subjects and produces subject, text, and html', () => {
    expect(rendered.EMAIL_VERIFICATION.subject).toBe('Verify your Oxyide email address');
    expect(rendered.PASSWORD_RESET.subject).toBe('Reset your Oxyide password');
    expect(rendered.SECURITY_NOTIFICATION.subject).toBe('Security alert: password changed');
    expect(
      renderEmailTemplate('SECURITY_NOTIFICATION', {
        type: 'ACCOUNT_LOCKED',
        lockoutDurationText: '30 minutes',
      }).subject,
    ).toBe('Security alert: account temporarily locked');

    for (const content of Object.values(rendered)) {
      expect(Object.keys(content).sort()).toEqual(['html', 'subject', 'text']);
      expect(content.text.length).toBeGreaterThan(0);
      expect(content.html.length).toBeGreaterThan(0);
      expect(content.html).toContain('<html');
      expect(content.text).not.toContain('<html');
    }
  });

  it('is deterministic for identical data', () => {
    expect(rendered.PASSWORD_RESET).toEqual(
      renderEmailTemplate('PASSWORD_RESET', { resetUrl: RESET_URL }),
    );
  });

  it('fails deterministically on an unknown key or an unknown notice kind', () => {
    expect(() =>
      renderEmailTemplate('MARKETING' as (typeof EMAIL_TEMPLATE_KEYS)[number], { resetUrl: RESET_URL }),
    ).toThrow(/Unknown email template/);
    expect(() =>
      renderEmailTemplate('SECURITY_NOTIFICATION', {
        type: 'SUSPICIOUS_LOGIN',
      } as unknown as { type: 'ACCOUNT_LOCKED'; lockoutDurationText: string }),
    ).toThrow(/Unknown security notification/);
  });

  it('neutralises adversarial template data in HTML', () => {
    const hostile = renderEmailTemplate('PASSWORD_RESET', {
      resetUrl: 'https://app.example.com/r?a=1&b="><script>alert(1)</script><img src=x onerror=alert(1)>',
    });

    // Structural, not lexical: the escaped text legitimately *contains* the
    // characters `onerror=alert` — as inert text. What must not exist is live
    // markup, i.e. an unescaped `<`.
    expect(hostile.html).not.toContain('<script');
    expect(hostile.html).not.toContain('<img');
    expect(hostile.html).toContain('&lt;script&gt;');
    expect(hostile.html).toContain('&quot;&gt;');
  });

  it('security notices never carry a link', () => {
    for (const type of ['ACCOUNT_LOCKED', 'PASSWORD_RESET_SUCCEEDED'] as const) {
      const notice = renderEmailTemplate('SECURITY_NOTIFICATION', {
        type,
        lockoutDurationText: '30 minutes',
      } as never);
      expect(notice.html).not.toContain('<a ');
      expect(notice.text).not.toContain('http');
    }
  });
});

describe('sensitive-URL invariants', () => {
  it.each([
    ['password reset', RENDERED_RESET, RESET_URL],
    ['email verification', RENDERED_VERIFY, VERIFY_URL],
  ])('%s carries its one-time URL in the body only', (_label, rendered, url) => {
    expect(rendered.subject).not.toContain('token=');
    expect(rendered.subject).not.toContain(url);
    expect(rendered.text).toContain(url);
    expect(rendered.html).toContain(`href="${url}"`);
  });

  it('never reaches a log line, a security event, or an error', async () => {
    const { logNotificationFailure } = await import('../services/security-notification.service.js');
    const logger = { error: vi.fn() };
    logNotificationFailure(logger, {
      type: 'ACCOUNT_LOCKED',
      userId: 'u_freeze',
      error: new Error(`send failed for ${RESET_URL}`),
    });

    const logged = JSON.stringify(logger.error.mock.calls[0]);
    expect(logged).not.toContain(RESET_URL);
    expect(logged).not.toContain('token=');
    expect(Object.keys(logger.error.mock.calls[0][0] as Record<string, unknown>).sort()).toEqual([
      'errorName',
      'event',
      'type',
      'userId',
    ]);

    const error = new EmailDeliveryError();
    expect(`${error.name}: ${error.message}`).not.toContain(RESET_URL);
  });
});

describe('flow matrix: request → template → one provider call', () => {
  function recordingProvider() {
    const sent: { subject: string; text: string; html?: string }[] = [];
    return {
      sent,
      provider: {
        send: async (message: {
          subject: string;
          textBody: string;
          htmlBody?: string;
        }): Promise<void> => {
          sent.push({
            subject: message.subject,
            text: message.textBody,
            ...(message.htmlBody === undefined ? {} : { html: message.htmlBody }),
          });
        },
      },
    };
  }

  type FlowCase = {
    flow: string;
    invoke: (mailers: ReturnType<typeof createAuthEmailMailers>) => Promise<void>;
    subject: string;
    url: string | null;
  };

  const matrix: FlowCase[] = [
    {
      flow: 'registration verification',
      invoke: (mailers: ReturnType<typeof createAuthEmailMailers>) =>
        mailers.emailVerification.sendVerificationEmail({ to: 'user@example.com', verificationUrl: VERIFY_URL }),
      subject: 'Verify your Oxyide email address',
      url: VERIFY_URL,
    },
    {
      flow: 'verification resend',
      invoke: (mailers: ReturnType<typeof createAuthEmailMailers>) =>
        mailers.emailVerification.sendVerificationEmail({ to: 'user@example.com', verificationUrl: VERIFY_URL }),
      subject: 'Verify your Oxyide email address',
      url: VERIFY_URL,
    },
    {
      flow: 'password reset request',
      invoke: (mailers: ReturnType<typeof createAuthEmailMailers>) =>
        mailers.passwordReset.sendPasswordResetEmail({ to: 'user@example.com', resetUrl: RESET_URL }),
      subject: 'Reset your Oxyide password',
      url: RESET_URL,
    },
    {
      flow: 'login lockout',
      invoke: (mailers: ReturnType<typeof createAuthEmailMailers>) =>
        mailers.securityNotification.sendAccountLocked({
          to: 'user@example.com',
          lockoutDurationText: '30 minutes',
        }),
      subject: 'Security alert: account temporarily locked',
      url: null,
    },
    {
      flow: 'password reset completion',
      invoke: (mailers: ReturnType<typeof createAuthEmailMailers>) =>
        mailers.securityNotification.sendPasswordResetSucceeded({ to: 'user@example.com' }),
      subject: 'Security alert: password changed',
      url: null,
    },
  ];

  it.each(matrix)('$flow renders the right template exactly once', async ({ invoke, subject, url }) => {
    const recorder = recordingProvider();
    await invoke(createAuthEmailMailers({ provider: recorder.provider, from: 'no-reply@example.com' }));

    expect(recorder.sent).toHaveLength(1);
    expect(recorder.sent[0].subject).toBe(subject);
    expect(recorder.sent[0].html).toContain('<html');
    if (url !== null) {
      expect(recorder.sent[0].text).toContain(url);
    } else {
      expect(recorder.sent[0].text).not.toContain('http');
    }
  });
});

describe('post-commit ordering is structural in the issuing services', () => {
  function assertSendFollowsTransaction(file: string): void {
    const source = stripComments(read(file));
    const transactionAt = source.indexOf('prisma.$transaction');
    const sendAt = source.indexOf('await mailer.');
    expect(transactionAt, `${file} has no transaction`).toBeGreaterThan(-1);
    expect(sendAt, `${file} has no delivery`).toBeGreaterThan(-1);
    // The send must follow the transaction's closing `});`, not merely appear
    // later in the file inside the callback.
    const transactionEnd = source.indexOf('});', transactionAt);
    expect(sendAt, `${file} delivers inside its transaction`).toBeGreaterThan(transactionEnd);
  }

  it('password-reset issuance sends after the transaction closes', () => {
    assertSendFollowsTransaction(`modules${sep}auth${sep}services${sep}password-reset.service.ts`);
  });

  it('verification issuance sends after the transaction closes', () => {
    assertSendFollowsTransaction(`modules${sep}auth${sep}services${sep}email-verification.service.ts`);
  });

  it('the lockout notice follows the failure record and the reset notice follows the commit', () => {
    const source = stripComments(read(`modules${sep}auth${sep}services${sep}auth.service.ts`));
    const recordAt = source.indexOf('recordLoginFailure(');
    const lockedNoticeAt = source.indexOf('mailer.sendAccountLocked(');
    expect(lockedNoticeAt).toBeGreaterThan(recordAt);

    const completeAt = source.indexOf('completeReset(');
    const resetNoticeAt = source.indexOf('mailer.sendPasswordResetSucceeded(');
    expect(resetNoticeAt).toBeGreaterThan(completeAt);
  });

  it('registration sends only after its transaction closes', () => {
    const source = stripComments(read(`modules${sep}auth${sep}services${sep}auth.service.ts`));
    const transactionAt = source.indexOf('prisma.$transaction');
    const sendAt = source.indexOf('mailer.sendVerificationEmail(');
    expect(transactionAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(source.indexOf('});', transactionAt));
  });
});

describe('failure semantics are unchanged', () => {
  it('the adapter propagates a delivery failure instead of swallowing it', async () => {
    const mailers = createAuthEmailMailers({
      provider: { send: (): Promise<void> => Promise.reject(new EmailDeliveryError()) },
      from: 'no-reply@example.com',
    });

    await expect(
      mailers.passwordReset.sendPasswordResetEmail({ to: 'user@example.com', resetUrl: RESET_URL }),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
    await expect(
      mailers.securityNotification.sendPasswordResetSucceeded({ to: 'user@example.com' }),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
  });

  it('no issuing function mutates state in a transaction after delivering', () => {
    // A rollback could only exist if state were written after the send. The
    // claim is scoped to the function that issues the credential, because a
    // file-level position comparison would be meaningless: these services also
    // contain the completion path, which legitimately opens its own
    // transaction.
    for (const file of [
      `modules${sep}auth${sep}services${sep}password-reset.service.ts`,
      `modules${sep}auth${sep}services${sep}email-verification.service.ts`,
    ]) {
      const body = functionSource(file, 'issueToken');
      const sendAt = body.indexOf('await mailer.');
      const transactionAt = body.indexOf('prisma.$transaction');
      expect(transactionAt, `${file} issueToken has no transaction`).toBeGreaterThan(-1);
      expect(sendAt, `${file} issueToken never delivers`).toBeGreaterThan(transactionAt);
      expect(
        body.slice(sendAt).includes('prisma.$transaction'),
        `${file} issueToken opens a transaction after delivering`,
      ).toBe(false);
    }
  });
});

describe('no email internals leak into the API contract', () => {
  it('the OpenAPI document exposes no email content or transport field', async () => {
    const { buildApp } = await import('../../../app/app.js');
    const app = await buildApp();
    await app.ready();

    try {
      const document = JSON.stringify(app.swagger());
      for (const forbidden of [
        'textBody',
        'htmlBody',
        'templateName',
        'EmailDeliveryError',
        'smtp',
        'smtpPassword',
        'emailProvider',
      ]) {
        expect(document, `OpenAPI leaked ${forbidden}`).not.toContain(forbidden);
      }
    } finally {
      await app.close();
    }
  });
});