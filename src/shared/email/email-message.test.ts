import { describe, expect, it } from 'vitest';

import { assertEmailMessage, type EmailMessage } from './email-message.js';

const VALID: EmailMessage = {
  from: 'no-reply@example.com',
  to: ['user@example.com'],
  subject: 'Security alert',
  textBody: 'Something happened.',
};

function message(overrides: Partial<EmailMessage> & { to?: unknown }): EmailMessage {
  return { ...VALID, ...overrides } as EmailMessage;
}

describe('email message contract', () => {
  it('accepts a minimal valid message', () => {
    expect(() => assertEmailMessage(message({}))).not.toThrow();
  });

  it('accepts an optional HTML body', () => {
    expect(() => assertEmailMessage(message({ htmlBody: '<p>Hi</p>' }))).not.toThrow();
  });

  it('accepts multiple recipients', () => {
    expect(() =>
      assertEmailMessage(message({ to: ['a@example.com', 'b@example.com'] })),
    ).not.toThrow();
  });

  it.each([
    ['missing from', { from: undefined }],
    ['blank from', { from: '   ' }],
    ['missing recipients', { to: undefined }],
    ['empty recipient list', { to: [] }],
    ['blank recipient', { to: ['  '] }],
    ['non-string recipient', { to: [42] }],
    ['missing subject', { subject: undefined }],
    ['blank subject', { subject: '' }],
    ['missing text body', { textBody: undefined }],
    ['empty text body', { textBody: '' }],
    ['non-string HTML body', { htmlBody: 42 }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => assertEmailMessage({ ...VALID, ...overrides })).toThrow(Error);
  });

  it.each([['non-object', null], ['array instead of object', []]])(
    'rejects %s without spreading it into a valid shape',
    (_label, value) => {
      expect(() => assertEmailMessage(value)).toThrow(Error);
    },
  );

  it.each([
    ['CRLF in subject', { subject: 'Hi\r\nBcc: evil@example.com' }],
    ['LF in subject', { subject: 'Hi\nBcc: evil@example.com' }],
    ['CR in from', { from: 'a@b.com\rc@d.com' }],
    ['NUL in recipient', { to: ['a@b.com\0'] }],
    ['CRLF in recipient', { to: ['a@b.com\r\nX: y'] }],
  ])('rejects header injection: %s', (_label, overrides) => {
    expect(() => assertEmailMessage(message(overrides))).toThrow(/control characters/);
  });

  it('never echoes values in validation messages (sentinel probe)', () => {
    const sentinelAddress = 'sentinel-leak-probe-9f3k@example.com';
    const sentinelBody = 'sentinel-body-7q2m-token-like-secret';

    // Each input is invalid for one reason while carrying sentinel values
    // elsewhere; a throw whose message echoes either value is a leak.
    const badInputs: unknown[] = [
      { ...message({}), from: '', to: [sentinelAddress] },
      { ...message({}), to: [sentinelAddress, '   '] },
      { ...message({}), subject: '', textBody: sentinelBody },
    ];

    const failures: string[] = [];
    for (const bad of badInputs) {
      try {
        assertEmailMessage(bad);
        failures.push('did not throw');
      } catch (error: unknown) {
        const text = error instanceof Error ? error.message : String(error);
        if (text.includes(sentinelAddress) || text.includes(sentinelBody)) {
          failures.push(`leaked value: ${text}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('rejects with plain Error, never EmailDeliveryError (bug vs delivery split)', async () => {
    const { EmailDeliveryError } = await import('./email-provider.js');

    try {
      assertEmailMessage({ ...VALID, to: [] });
      expect.unreachable('must throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(EmailDeliveryError);
    }
  });
});
