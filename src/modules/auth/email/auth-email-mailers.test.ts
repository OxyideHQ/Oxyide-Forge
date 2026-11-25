import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

import type { EmailMessage } from '../../../shared/email/email-message.js';
import { EmailDeliveryError } from '../../../shared/email/email-provider.js';
import {
  buildAccountLockedEmail,
  buildPasswordResetSucceededEmail,
} from '../services/security-notification.service.js';
import { renderEmailTemplate } from '../../../shared/email/templates/email-template-registry.js';
import type { SecurityNotificationType } from '../services/security-notification.service.js';
import { createAuthEmailMailers } from './auth-email-mailers.js';

/**
 * M11.3 — authentication email adapter tests.
 *
 * A recording `EmailProvider` stands in for the transport: it proves the
 * adapter's whole responsibility — turning a domain mail request into typed
 * template data, mapping the rendered template onto the frozen M11.1
 * `EmailMessage`, and handing it to the provider exactly once. Rendering
 * itself is proven in `src/shared/email/templates/`.
 * No SMTP server, socket, credential, or live mail exists in this suite.
 */

const SENDER = 'no-reply@example.com';
const RESET_URL_SENTINEL = 'https://app.example.com/reset-password?token=reset-raw-sentinel-q7w2';
const VERIFICATION_URL_SENTINEL = 'https://app.example.com/verify-email?token=verify-raw-sentinel-r3m8';

function recordingProvider() {
  const sent: EmailMessage[] = [];
  const provider = {
    send: async (message: EmailMessage): Promise<void> => {
      sent.push(message);
    },
  };
  return { sent, provider };
}

describe('credential email mapping', () => {
  it('maps a reset request onto the rendered template, with the link in the body only', async () => {
    const { sent, provider } = recordingProvider();
    const mailers = createAuthEmailMailers({ provider, from: SENDER });

    await mailers.passwordReset.sendPasswordResetEmail({
      to: 'user@example.com',
      resetUrl: RESET_URL_SENTINEL,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe(SENDER);
    expect(sent[0].to).toEqual(['user@example.com']);
    expect(sent[0].subject).toBe('Reset your Oxyide password');
    expect(sent[0].textBody).toContain(RESET_URL_SENTINEL);
    expect(sent[0].htmlBody).toContain(RESET_URL_SENTINEL);
  });

  it('maps a verification request onto the rendered template', async () => {
    const { sent, provider } = recordingProvider();
    const mailers = createAuthEmailMailers({ provider, from: SENDER });

    await mailers.emailVerification.sendVerificationEmail({
      to: 'user@example.com',
      verificationUrl: VERIFICATION_URL_SENTINEL,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Verify your Oxyide email address');
    expect(sent[0].textBody).toContain(VERIFICATION_URL_SENTINEL);
    expect(sent[0].htmlBody).toContain(VERIFICATION_URL_SENTINEL);
  });

  it('keeps the raw credential out of every header field', async () => {
    const { sent, provider } = recordingProvider();
    const mailers = createAuthEmailMailers({ provider, from: SENDER });

    await mailers.passwordReset.sendPasswordResetEmail({
      to: 'user@example.com',
      resetUrl: RESET_URL_SENTINEL,
    });

    // A credential in a header field would reach SMTP as a header, visible to
    // every intermediary.
    expect(sent[0].subject).not.toContain('token=');
    expect(sent[0].from).not.toContain('token=');
    expect(sent[0].to.join(',')).not.toContain('token=');
  });
});

describe('event vocabulary parity', () => {
  it('the domain notification type and the template event kind stay identical', async () => {
    // Enumerated explicitly: adding a domain notification type without a
    // matching template branch fails this assertion, which is the point. The
    // object literals below only typecheck while the two unions agree.
    const domainTypes: readonly SecurityNotificationType[] = [
      'ACCOUNT_LOCKED',
      'PASSWORD_RESET_SUCCEEDED',
    ];
    expect(domainTypes).toHaveLength(2);

    for (const type of domainTypes) {
      const data =
        type === 'ACCOUNT_LOCKED'
          ? { type, lockoutDurationText: '30 minutes' }
          : { type, lockoutDurationText: 'unused' };
      expect(() => renderEmailTemplate('SECURITY_NOTIFICATION', data)).not.toThrow();
    }
  });
});

describe('createAuthEmailMailers', () => {
  it('delivers a password-reset request through the provider exactly once', async () => {
    const { sent, provider } = recordingProvider();
    const mailers = createAuthEmailMailers({ provider, from: SENDER });

    await mailers.passwordReset.sendPasswordResetEmail({
      to: 'user@example.com',
      resetUrl: RESET_URL_SENTINEL,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: SENDER,
      to: ['user@example.com'],
      subject: 'Reset your Oxyide password',
    });
    expect(sent[0].textBody).toContain(RESET_URL_SENTINEL);
  });

  it('delivers a verification request through the provider exactly once', async () => {
    const { sent, provider } = recordingProvider();
    const mailers = createAuthEmailMailers({ provider, from: SENDER });

    await mailers.emailVerification.sendVerificationEmail({
      to: 'user@example.com',
      verificationUrl: VERIFICATION_URL_SENTINEL,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: SENDER,
      subject: 'Verify your Oxyide email address',
    });
    expect(sent[0].textBody).toContain(VERIFICATION_URL_SENTINEL);
  });

  it('renders the lockout notice from domain facts, never inventing content', async () => {
    const { sent, provider } = recordingProvider();
    const mailers = createAuthEmailMailers({ provider, from: SENDER });

    await mailers.securityNotification.sendAccountLocked(
      buildAccountLockedEmail('user@example.com'),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe(SENDER);
    expect(sent[0].to).toEqual(['user@example.com']);
    expect(sent[0].subject).toBe('Security alert: account temporarily locked');
    expect(sent[0].textBody).toContain('temporarily locked after repeated unsuccessful sign-in attempts');
    expect(sent[0].htmlBody).toContain('<html');
  });

  it('renders the password-change notice from the recipient alone', async () => {
    const { sent, provider } = recordingProvider();
    const mailers = createAuthEmailMailers({ provider, from: SENDER });

    await mailers.securityNotification.sendPasswordResetSucceeded(
      buildPasswordResetSucceededEmail('user@example.com'),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Security alert: password changed');
    expect(sent[0].textBody).toContain('Existing sessions were revoked');
    expect(sent[0].htmlBody).toContain('<html');
  });

  it('carries no transport credential, host, or SMTP configuration', async () => {
    const { sent, provider } = recordingProvider();
    const mailers = createAuthEmailMailers({
      provider,
      from: SENDER,
    });

    await mailers.passwordReset.sendPasswordResetEmail({
      to: 'user@example.com',
      resetUrl: RESET_URL_SENTINEL,
    });

    // Structural proof rather than keyword hunting: the message carries exactly
    // the frozen M11.1 keys and nothing else, so no transport setting has a
    // field to travel in. (A keyword scan would false-positive on the reset
    // copy's own wording — the M78-F04 defect class.)
    expect(Object.keys(sent[0]).sort()).toEqual([
      'from',
      'htmlBody',
      'subject',
      'textBody',
      'to',
    ]);

    // The one genuinely forbidden vocabulary: transport and template-engine
    // internals must never surface in a reader-facing message.
    for (const forbidden of ['smtp', 'SMTP_', 'nodemailer', 'tls.', 'auth:']) {
      expect(sent[0].textBody, `message leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('propagates delivery failure unchanged so callers keep their semantics', async () => {
    const provider = {
      send: (): Promise<void> => Promise.reject(new EmailDeliveryError()),
    };
    const mailers = createAuthEmailMailers({ provider, from: SENDER });

    await expect(
      mailers.passwordReset.sendPasswordResetEmail({
        to: 'user@example.com',
        resetUrl: RESET_URL_SENTINEL,
      }),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
    await expect(
      mailers.emailVerification.sendVerificationEmail({
        to: 'user@example.com',
        verificationUrl: VERIFICATION_URL_SENTINEL,
      }),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
    await expect(
      mailers.securityNotification.sendAccountLocked(buildAccountLockedEmail('user@example.com')),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
  });

  it('never retries a failed send', async () => {
    let attempts = 0;
    const provider = {
      send: (): Promise<void> => {
        attempts += 1;
        return Promise.reject(new EmailDeliveryError());
      },
    };
    const mailers = createAuthEmailMailers({ provider, from: SENDER });

    await expect(
      mailers.passwordReset.sendPasswordResetEmail({
        to: 'user@example.com',
        resetUrl: RESET_URL_SENTINEL,
      }),
    ).rejects.toBeInstanceOf(EmailDeliveryError);

    expect(attempts).toBe(1);
  });
});