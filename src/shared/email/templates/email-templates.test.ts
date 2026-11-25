import { describe, expect, it } from 'vitest';

import {
  renderEmailVerificationTemplate,
  renderPasswordResetTemplate,
  renderSecurityNotificationTemplate,
} from './email-templates.js';

/**
 * M11.4 — authentication template content tests.
 *
 * Two jobs. First, the externally visible wording established by M11.3/M3.17
 * is preserved exactly — these are commercial-product messages a reader acts
 * on, and a silent copy change is a product change. Second, no template can be
 * talked into emitting markup, credentials, or internal identifiers.
 */

const RESET_URL = 'https://app.example.com/reset-password?token=reset-raw-sentinel-q7w2';
const VERIFICATION_URL =
  'https://app.example.com/verify-email?token=verify-raw-sentinel-r3m8';

/** Sentinels that must never appear in any rendered output. */
const FORBIDDEN_IN_OUTPUT = [
  'passwordHash',
  'tokenHash',
  'refreshToken',
  'accessToken',
  'jwtSecret',
  'Bearer',
  'cookie',
  'smtp',
  'SMTP',
  'nodemailer',
  'u_01HX', // user-id shaped internal identifier
  'lockedUntil',
  'failureCount',
];

describe('password reset template', () => {
  const rendered = renderPasswordResetTemplate({ resetUrl: RESET_URL });

  it('uses the M11.3 subject verbatim', () => {
    expect(rendered.subject).toBe('Reset your Oxyide password');
  });

  it('preserves the M11.3 recovery wording', () => {
    expect(rendered.text).toContain('Use the link below to choose a new Oxyide password.');
    expect(rendered.text).toContain('The link can be used once and expires on its own.');
    expect(rendered.text).toContain(
      'If you did not request a password reset, no account change was made and you can ignore this message.',
    );
  });

  it('carries the supplied URL in text and HTML without rebuilding it', () => {
    expect(rendered.text).toContain(RESET_URL);
    expect(rendered.html).toContain(RESET_URL);
    expect(rendered.html).toContain(`href="${RESET_URL}"`);
  });

  it('never places the one-time credential in the subject', () => {
    expect(rendered.subject).not.toContain('token=');
    expect(rendered.subject).not.toContain('sentinel');
  });

  it('contains no credential, internal identifier, or transport detail', () => {
    for (const output of [rendered.subject, rendered.text, rendered.html]) {
      for (const forbidden of FORBIDDEN_IN_OUTPUT) {
        expect(output, `reset output leaked ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('escapes a hostile URL in HTML and preserves it in text', () => {
    const hostile = 'https://app.example.com/reset?token=x&y="><script>alert(1)</script>';
    const hostileRendered = renderPasswordResetTemplate({ resetUrl: hostile });

    expect(hostileRendered.html).not.toContain('<script>');
    expect(hostileRendered.html).toContain('&quot;&gt;&lt;script&gt;');
    // Plain text reproduces the value it was given: the URL is caller-owned
    // application data, and silently rewriting it would corrupt the link.
    expect(hostileRendered.text).toContain(hostile);
  });
});

describe('email verification template', () => {
  const rendered = renderEmailVerificationTemplate({ verificationUrl: VERIFICATION_URL });

  it('uses the M11.3 subject verbatim', () => {
    expect(rendered.subject).toBe('Verify your Oxyide email address');
  });

  it('preserves the M11.3 verification wording', () => {
    expect(rendered.text).toContain(
      'Confirm this address to finish setting up your Oxyide account.',
    );
    expect(rendered.text).toContain(
      'If you did not create an account, no action is needed and you can ignore this message.',
    );
  });

  it('states the exact, limited effect of verification', () => {
    // Verification proves control of an address: no session, no password
    // change, no access. Saying so prevents a reader from expecting to be
    // signed in after clicking.
    expect(rendered.text).toContain('It does not sign you in');
    expect(rendered.text).toContain('does not change your password');
    expect(rendered.text).toContain('does not grant access to your account');
  });

  it('carries the supplied URL in text and HTML without rebuilding it', () => {
    expect(rendered.text).toContain(VERIFICATION_URL);
    expect(rendered.html).toContain(`href="${VERIFICATION_URL}"`);
    expect(rendered.subject).not.toContain('token=');
  });

  it('contains no credential, internal identifier, or transport detail', () => {
    for (const output of [rendered.subject, rendered.text, rendered.html]) {
      for (const forbidden of FORBIDDEN_IN_OUTPUT) {
        expect(output, `verification output leaked ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('security notification templates', () => {
  const locked = renderSecurityNotificationTemplate({
    type: 'ACCOUNT_LOCKED',
    lockoutDurationText: '30 minutes',
  });
  const changed = renderSecurityNotificationTemplate({ type: 'PASSWORD_RESET_SUCCEEDED' });

  it('uses the M3.17 subjects verbatim', () => {
    expect(locked.subject).toBe('Security alert: account temporarily locked');
    expect(changed.subject).toBe('Security alert: password changed');
  });

  it('preserves the M3.17 lockout wording and the supplied duration', () => {
    expect(locked.text).toContain(
      'Your Oxyide account was temporarily locked after repeated unsuccessful sign-in attempts.',
    );
    expect(locked.text).toContain(
      'The lockout lasts 30 minutes. You can try signing in again after it expires.',
    );
    expect(locked.text).toContain(
      'If you did not make these attempts, reset your password using the existing password recovery flow once the account becomes available.',
    );
  });

  it('preserves the M3.17 password-change wording', () => {
    expect(changed.text).toContain('Your Oxyide password was successfully changed.');
    expect(changed.text).toContain(
      'Existing sessions were revoked as part of password recovery. You will need to sign in again on your devices.',
    );
    expect(changed.text).toContain(
      'If you did not make this change, use the account recovery process (password reset) to regain control of your account.',
    );
  });

  it('never claims the account was accessed or names an attacker', () => {
    for (const notice of [locked, changed]) {
      const lower = notice.text.toLowerCase();
      expect(lower).not.toContain('hacked');
      expect(lower).not.toContain('breach');
      expect(lower).not.toContain('attacker');
      expect(lower).not.toContain('compromised');
    }
  });

  it('contains no link at all — a security alert is not a credential channel', () => {
    for (const notice of [locked, changed]) {
      expect(notice.html).not.toContain('<a ');
      expect(notice.text).not.toContain('http://');
      expect(notice.text).not.toContain('https://');
    }
  });

  it('contains no credential, counter, timestamp, or transport detail', () => {
    for (const notice of [locked, changed]) {
      for (const output of [notice.subject, notice.text, notice.html]) {
        for (const forbidden of FORBIDDEN_IN_OUTPUT) {
          expect(output, `notice output leaked ${forbidden}`).not.toContain(forbidden);
        }
      }
      expect(notice.text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(notice.text).not.toMatch(/\d+ failed attempts/);
    }
  });

  it('subjects carry no digits, so no count or id can leak into a subject line', () => {
    expect(locked.subject).not.toMatch(/\d/);
    expect(changed.subject).not.toMatch(/\d/);
  });

  it('escapes a hostile duration string', () => {
    const hostile = renderSecurityNotificationTemplate({
      type: 'ACCOUNT_LOCKED',
      lockoutDurationText: '30 minutes <script>alert(1)</script>',
    });

    expect(hostile.html).not.toContain('<script>');
    expect(hostile.html).toContain('&lt;script&gt;');
    expect(hostile.text).toContain('<script>alert(1)</script>');
  });
});

describe('template invariants', () => {
  const rendered = [
    renderPasswordResetTemplate({ resetUrl: RESET_URL }),
    renderEmailVerificationTemplate({ verificationUrl: VERIFICATION_URL }),
    renderSecurityNotificationTemplate({
      type: 'ACCOUNT_LOCKED',
      lockoutDurationText: '30 minutes',
    }),
    renderSecurityNotificationTemplate({ type: 'PASSWORD_RESET_SUCCEEDED' }),
  ];

  it('every template yields a non-empty subject, text, and html', () => {
    for (const content of rendered) {
      expect(content.subject.length).toBeGreaterThan(0);
      expect(content.text.length).toBeGreaterThan(0);
      expect(content.html.length).toBeGreaterThan(0);
    }
  });

  it('every template renders both a plain-text and an HTML form', () => {
    for (const content of rendered) {
      expect(content.text).not.toContain('<html');
      expect(content.html).toContain('<html');
      // The two renderings are two views of one content model, so both carry
      // the same closing guidance ("If you did not …") — all four templates do.
      expect(content.text).toContain('If you did not');
      expect(content.html).toContain('If you did not');
    }
  });

  it('is deterministic: identical data renders byte-identical output', () => {
    const first = renderPasswordResetTemplate({ resetUrl: RESET_URL });
    const second = renderPasswordResetTemplate({ resetUrl: RESET_URL });

    expect(second).toEqual(first);
    expect(renderSecurityNotificationTemplate({ type: 'PASSWORD_RESET_SUCCEEDED' })).toEqual(
      renderSecurityNotificationTemplate({ type: 'PASSWORD_RESET_SUCCEEDED' }),
    );
  });

  it('never emits our own markup into the plain-text form', () => {
    for (const content of rendered) {
      for (const forbidden of ['<!DOCTYPE', '<html', '<p ', '<table', '<a href', 'style=']) {
        expect(content.text, `text output contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('emits no executable, remote, or tracking content in any template', () => {
    for (const content of rendered) {
      for (const forbidden of [
        '<script',
        '<iframe',
        '<form',
        '<img',
        '<style',
        'onclick',
        'onerror',
        'onload',
        'javascript:',
        'data:',
      ]) {
        expect(content.html, `html contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});