import { describe, expect, it } from 'vitest';

import {
  EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_KEYS,
  renderEmailTemplate,
  type EmailTemplateKey,
} from './email-template-registry.js';

/**
 * M11.4 — template registry tests.
 *
 * The registry is the closed vocabulary of everything Forge can email. Its
 * tests therefore pin the exact key set (a template cannot appear or vanish
 * unnoticed), prove every key resolves to a real renderer, and prove that an
 * unrecognised key fails loudly instead of silently sending nothing.
 */

const EXPECTED_KEYS = ['EMAIL_VERIFICATION', 'PASSWORD_RESET', 'SECURITY_NOTIFICATION'];

describe('registry vocabulary', () => {
  it('exposes exactly the three required authentication templates', () => {
    expect([...EMAIL_TEMPLATE_KEYS].sort()).toEqual(EXPECTED_KEYS);
  });

  it('has no duplicate keys', () => {
    expect(new Set(EMAIL_TEMPLATE_KEYS).size).toBe(EMAIL_TEMPLATE_KEYS.length);
    expect(new Set(Object.keys(EMAIL_TEMPLATES)).size).toBe(Object.keys(EMAIL_TEMPLATES).length);
  });

  it('resolves every declared key to a renderer function', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      expect(typeof EMAIL_TEMPLATES[key], `${key} has no renderer`).toBe('function');
    }
  });

  it('has no renderer without a declared key', () => {
    // Own-property enumeration: a prototype member (or a stray export) must not
    // masquerade as a registered template.
    expect(Object.getOwnPropertyNames(EMAIL_TEMPLATES).sort()).toEqual(EXPECTED_KEYS);
  });

  it('renders every key through the registry', () => {
    const rendered = {
      EMAIL_VERIFICATION: renderEmailTemplate('EMAIL_VERIFICATION', {
        verificationUrl: 'https://app.example.com/verify-email?token=sentinel-a1',
      }),
      PASSWORD_RESET: renderEmailTemplate('PASSWORD_RESET', {
        resetUrl: 'https://app.example.com/reset-password?token=sentinel-b2',
      }),
      SECURITY_NOTIFICATION: renderEmailTemplate('SECURITY_NOTIFICATION', {
        type: 'PASSWORD_RESET_SUCCEEDED',
      }),
    };

    for (const key of EMAIL_TEMPLATE_KEYS) {
      expect(rendered[key].subject.length, `${key} subject`).toBeGreaterThan(0);
      expect(rendered[key].text.length, `${key} text`).toBeGreaterThan(0);
      expect(rendered[key].html.length, `${key} html`).toBeGreaterThan(0);
    }
  });

  it('rejects an unknown key loudly instead of sending nothing', () => {
    // The type system already forbids this; the runtime guard is what protects
    // JavaScript callers and a future refactor that widens the signature.
    expect(() =>
      renderEmailTemplate('MARKETING_WELCOME' as EmailTemplateKey, {
        resetUrl: 'https://app.example.com/reset-password?token=sentinel-c3',
      }),
    ).toThrow(/Unknown email template/);
  });

  it('refuses a prototype-inherited key', () => {
    expect(() =>
      renderEmailTemplate('constructor' as EmailTemplateKey, {
        resetUrl: 'https://app.example.com/reset-password?token=sentinel-d4',
      }),
    ).toThrow(/Unknown email template/);
  });

  it('is deterministic per key', () => {
    const data = { resetUrl: 'https://app.example.com/reset-password?token=sentinel-e5' };

    expect(renderEmailTemplate('PASSWORD_RESET', data)).toEqual(
      renderEmailTemplate('PASSWORD_RESET', data),
    );
  });
});

describe('registry data contracts', () => {
  it('accepts each template’s own data and no cross-template field', () => {
    // Type-level proof, exercised at runtime for the positive path: a reset
    // template needs a reset URL and a verification template needs a
    // verification URL. The compiler rejects a mismatch; these assertions
    // pin the runtime contract that backs it.
    expect(() =>
      renderEmailTemplate('PASSWORD_RESET', {
        resetUrl: 'https://app.example.com/reset-password?token=sentinel-f6',
      }),
    ).not.toThrow();
    expect(() =>
      renderEmailTemplate('EMAIL_VERIFICATION', {
        verificationUrl: 'https://app.example.com/verify-email?token=sentinel-f7',
      }),
    ).not.toThrow();
  });

  it('renders a security notice only for the two supported event kinds', () => {
    expect(() =>
      renderEmailTemplate('SECURITY_NOTIFICATION', {
        type: 'ACCOUNT_LOCKED',
        lockoutDurationText: '30 minutes',
      }),
    ).not.toThrow();
    expect(() =>
      renderEmailTemplate('SECURITY_NOTIFICATION', { type: 'PASSWORD_RESET_SUCCEEDED' }),
    ).not.toThrow();
    // An unsupported event kind must fail loudly. Falling through to the
    // password-change notice would tell a customer the wrong thing about their
    // account, which is worse than a loud failure.
    expect(() =>
      renderEmailTemplate('SECURITY_NOTIFICATION', {
        type: 'SUSPICIOUS_LOGIN',
      } as unknown as { type: 'ACCOUNT_LOCKED'; lockoutDurationText: string }),
    ).toThrow(/Unknown security notification/);
  });
});