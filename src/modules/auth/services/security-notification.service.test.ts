import { beforeEach, describe, expect, it, vi } from 'vitest';

// Required before the service import evaluates validated config.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const { config } = await import('../../../config/index.js');
const {
  buildAccountLockedEmail,
  buildPasswordResetSucceededEmail,
  logNotificationFailure,
  lockoutDurationText,
  noopSecurityNotificationLogger,
  noopSecurityNotificationMailer,
  securityNotificationService,
} = await import('./security-notification.service.js');
const { renderEmailTemplate } = await import(
  '../../../shared/email/templates/email-template-registry.js'
);

/**
 * Renders a notice exactly as the adapter does: domain request → template data
 * → rendered content. Content ownership moved to the M11.4 template system, so
 * every content assertion below is made against the real rendered message while
 * still starting from the real domain request. The M3.17 policy statements are
 * unchanged — only the owner of the wording changed.
 */
function renderedLockoutNotice(to: string) {
  const request = buildAccountLockedEmail(to);
  return renderEmailTemplate('SECURITY_NOTIFICATION', {
    type: 'ACCOUNT_LOCKED',
    lockoutDurationText: request.lockoutDurationText,
  });
}

function renderedPasswordChangeNotice(to: string) {
  const request = buildPasswordResetSucceededEmail(to);
  const notice = renderEmailTemplate('SECURITY_NOTIFICATION', { type: 'PASSWORD_RESET_SUCCEEDED' });
  expect(request.to).toBe(to);
  return notice;
}

/** Substrings that must never appear in any security notice. */
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
];

/**
 * M3.17 — security notification content, contract, and redaction unit tests.
 *
 * Pure builders plus the safe failure logger. No database, no mailer
 * transport, no timers. Delivery ordering, deduplication, and concurrency
 * are proven against live PostgreSQL in the integration suite.
 */
describe('securityNotificationService content', () => {
  it('addresses the canonical recipient with a static lockout subject', () => {
    const request = buildAccountLockedEmail('alice@example.com');
    const notice = renderedLockoutNotice('alice@example.com');

    expect(request.to).toBe('alice@example.com');
    expect(notice.subject).toBe('Security alert: account temporarily locked');
    expect(notice.text).toContain(
      'temporarily locked after repeated unsuccessful sign-in attempts',
    );
  });

  it('carries no rendered content, only the facts a notice prints', () => {
    // M11.4: the port owns facts, the template owns presentation. A DTO that
    // still carried a subject or body would mean two presentation owners.
    const locked = buildAccountLockedEmail('alice@example.com');
    const reset = buildPasswordResetSucceededEmail('alice@example.com');

    expect(Object.keys(locked).sort()).toEqual(['lockoutDurationText', 'to']);
    expect(Object.keys(reset)).toEqual(['to']);
    expect(JSON.stringify(locked)).not.toContain('<');
    expect(JSON.stringify(reset)).not.toContain('<');
  });

  it('states the policy-derived duration, never a raw timestamp', () => {
    const notice = renderedLockoutNotice('alice@example.com');
    const minutes = Math.round(config.auth.accountLockout.lockoutDurationSeconds / 60);

    expect(notice.text).toContain(`${minutes} minutes`);
    expect(notice.text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(notice.text).not.toContain('lockedUntil');
  });

  it('never claims compromise and names only the existing recovery flow', () => {
    const notice = renderedLockoutNotice('alice@example.com');
    const lower = notice.text.toLowerCase();

    expect(lower).not.toContain('hack');
    expect(lower).not.toContain('breach');
    expect(lower).not.toContain('attacker');
    expect(notice.text).toContain('password recovery flow');
    expect(notice.text).not.toContain('http://');
    expect(notice.text).not.toContain('https://');
    expect(notice.text).not.toContain('support');
    expect(notice.text).not.toContain('unlock');
  });

  it('never exposes the failure count in the lockout notice', () => {
    const notice = renderedLockoutNotice('alice@example.com');

    expect(notice.text).not.toMatch(/\d+ failed attempts/);
    expect(notice.text).not.toContain('failureCount');
    expect(notice.subject).not.toMatch(/\d+/);
  });

  it('addresses the canonical recipient with a static password-change subject', () => {
    const notice = renderedPasswordChangeNotice('alice@example.com');

    expect(notice.subject).toBe('Security alert: password changed');
    expect(notice.text).toContain('password was successfully changed');
  });

  it('states session revocation factually without secrets or links', () => {
    const notice = renderedPasswordChangeNotice('alice@example.com');

    expect(notice.text).toContain('Existing sessions were revoked');
    expect(notice.text).not.toContain('http://');
    expect(notice.text).not.toContain('https://');
    expect(notice.text).not.toContain('token');
    expect(notice.text).not.toContain('passwordHash');
    expect(notice.text).not.toContain('JWT');
    // A security alert must not become a credential channel: no action link.
    expect(notice.html).not.toContain('<a ');
  });

  it('keeps user-controlled addresses out of subjects', () => {
    const locked = renderedLockoutNotice('alice@example.com');
    const reset = renderedPasswordChangeNotice('alice@example.com');

    expect(locked.subject).not.toContain('alice@example.com');
    expect(reset.subject).not.toContain('alice@example.com');
  });

  it('contains no forbidden secret or internal substrings in either template', () => {
    const notices = [
      renderedLockoutNotice('alice@example.com'),
      renderedPasswordChangeNotice('alice@example.com'),
    ];

    for (const notice of notices) {
      const combined = `${notice.subject}\n${notice.text}`;
      for (const forbidden of FORBIDDEN) {
        expect(combined).not.toContain(forbidden);
      }
    }
  });

  it('derives the duration text from policy, not a hardcoded string', () => {
    const minutes = Math.round(config.auth.accountLockout.lockoutDurationSeconds / 60);
    expect(lockoutDurationText()).toBe(`${minutes} minutes`);
  });

  it('NoOp mailer resolves without delivering', async () => {
    await expect(
      noopSecurityNotificationMailer.sendAccountLocked(buildAccountLockedEmail('a@b.com')),
    ).resolves.toBeUndefined();
    await expect(
      noopSecurityNotificationMailer.sendPasswordResetSucceeded(
        buildPasswordResetSucceededEmail('a@b.com'),
      ),
    ).resolves.toBeUndefined();
  });

  it('NoOp logger discards without throwing', () => {
    expect(() =>
      noopSecurityNotificationLogger.error({ event: 'x' }, 'dropped'),
    ).not.toThrow();
  });
});

describe('logNotificationFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records type and userId with a static message and error class only', () => {
    const logger = { error: vi.fn() };
    const providerError = Object.assign(new Error('SMTP 550 rejected'), { name: 'SMTPError' });

    logNotificationFailure(logger, {
      type: 'ACCOUNT_LOCKED',
      userId: 'u_alice',
      error: providerError,
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [fields, message] = logger.error.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(fields).toEqual({
      event: 'security.notification.delivery_failed',
      type: 'ACCOUNT_LOCKED',
      userId: 'u_alice',
      errorName: 'SMTPError',
    });
    expect(message).toBe('security notification delivery failed');
  });

  it('never logs the recipient, message payload, or provider secret', () => {
    const logger = { error: vi.fn() };
    const secret = 'fake-provider-secret-xyz-123';
    const leakingError = new Error(`send to alice@example.com failed with ${secret}`);

    logNotificationFailure(logger, {
      type: 'PASSWORD_RESET_SUCCEEDED',
      userId: 'u_bob',
      error: leakingError,
    });

    const serialized = JSON.stringify(logger.error.mock.calls[0]);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('send to');
    expect(serialized).not.toContain('lockedUntil');
  });

  it('classifies non-Error throws without leaking them', () => {
    const logger = { error: vi.fn() };

    logNotificationFailure(logger, {
      type: 'ACCOUNT_LOCKED',
      userId: 'u_alice',
      error: 'string-with-alice@example.com-inside',
    });

    const [fields] = logger.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.errorName).toBe('unknown');
    expect(JSON.stringify(fields)).not.toContain('alice@example.com');
  });
});

describe('securityNotificationService contract', () => {
  it('exposes the documented service surface', () => {
    expect(securityNotificationService.buildAccountLockedEmail).toBe(buildAccountLockedEmail);
    expect(securityNotificationService.buildPasswordResetSucceededEmail).toBe(
      buildPasswordResetSucceededEmail,
    );
    expect(securityNotificationService.logNotificationFailure).toBe(logNotificationFailure);
    expect(securityNotificationService.lockoutDurationText).toBe(lockoutDurationText);
    expect(securityNotificationService.noopSecurityNotificationMailer).toBe(
      noopSecurityNotificationMailer,
    );
    expect(securityNotificationService.noopSecurityNotificationLogger).toBe(
      noopSecurityNotificationLogger,
    );
  });
});
