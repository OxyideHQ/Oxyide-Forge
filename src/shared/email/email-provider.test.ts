import { describe, expect, it, vi } from 'vitest';

import type { EmailMessage } from './email-message.js';
import { EmailDeliveryError, noopEmailProvider, type EmailProvider } from './email-provider.js';

const MESSAGE: EmailMessage = {
  from: 'no-reply@example.com',
  to: ['user@example.com'],
  subject: 'Security alert',
  textBody: 'Something happened.',
};

/**
 * Minimal deterministic fake: records what it received, plays back a
 * programmed outcome. Test-only. Production fakes live with their tests;
 * this one exists so the boundary contract (not any provider) can be proven.
 */
function fakeEmailProvider(outcome: 'sent' | Error = 'sent'): EmailProvider & {
  sent: EmailMessage[];
} {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message: EmailMessage): Promise<void> {
      sent.push(message);
      if (outcome !== 'sent') {
        throw outcome;
      }
    },
  };
}

describe('EmailProvider contract', () => {
  it('NoOp accepts a valid message and delivers nothing', async () => {
    await expect(noopEmailProvider.send(MESSAGE)).resolves.toBeUndefined();
  });

  it('NoOp rejects a malformed message instead of silently dropping it', async () => {
    await expect(
      noopEmailProvider.send({ ...MESSAGE, to: [] }),
    ).rejects.toThrow(Error);
  });

  it('fake records the sent message for assertions', async () => {
    const fake = fakeEmailProvider();

    await fake.send(MESSAGE);

    expect(fake.sent).toEqual([MESSAGE]);
  });

  it('fake replays provider failure through the neutral error', async () => {
    const fake = fakeEmailProvider(new EmailDeliveryError());

    await expect(fake.send(MESSAGE)).rejects.toBeInstanceOf(EmailDeliveryError);
    // The message was still captured: failure is observable, not silent.
    expect(fake.sent).toEqual([MESSAGE]);
  });

  it('send does not mutate the caller message (readonly holds at runtime)', async () => {
    const snapshot = JSON.parse(JSON.stringify(MESSAGE)) as EmailMessage;
    const fake = fakeEmailProvider();

    await fake.send(MESSAGE);
    await noopEmailProvider.send(MESSAGE);

    expect(MESSAGE).toEqual(snapshot);
  });

  it('EmailDeliveryError carries a safe static default', () => {
    const error = new EmailDeliveryError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EmailDeliveryError');
    expect(error.message).toBe('Email delivery failed.');
  });

  it('EmailDeliveryError carries no cause chain for raw errors to hide in', () => {
    const error = new EmailDeliveryError('SMTP refused.');

    expect('cause' in error).toBe(false);
    expect(JSON.stringify(error.message)).not.toContain('smtp.example.com');
  });

  it('EmailDeliveryError is not an AppError: no HTTP status crosses the boundary', async () => {
    const { AppError } = await import('../errors/app-error.js');
    const error = new EmailDeliveryError();

    expect(error).not.toBeInstanceOf(AppError);
    expect('statusCode' in error).toBe(false);
    expect('code' in error).toBe(false);
  });
});

describe('EmailProvider boundary (no vendor leakage)', () => {
  it('exactly one SMTP transport dependency exists; no vendor SDK does', async () => {
    // Presence-guarded in both directions (M11.2): nodemailer must be present
    // (it is the single approved transport), and no second transport or
    // vendor SDK may arrive unnoticed. If either side changes, this test
    // names it instead of silently passing.
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const vendorPackages = [
      '@sendgrid/mail',
      'resend',
      '@aws-sdk/client-ses',
      'mailgun.js',
      'postmark',
    ];

    expect(manifest.dependencies?.['nodemailer'], 'nodemailer transport').toBeDefined();
    for (const name of vendorPackages) {
      expect(manifest.dependencies?.[name], `vendor dep ${name}`).toBeUndefined();
    }
  });

  it('transport libraries are imported only inside src/platform/email (the designated isolation zone)', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join, sep } = await import('node:path');
    const root = new URL('../../../src', import.meta.url);

    // Import specifiers only — never bare substrings. A substring scan would
    // flag `resendVerificationEmail` (M78-F04 class: the detector, not the
    // code, would be wrong).
    const TRANSPORT_IMPORT =
      /(?:import\s[^'"]*from\s*|require\(\s*|import\(\s*)['"](nodemailer|@sendgrid\/mail|resend|@aws-sdk\/client-ses|mailgun\.js|postmark)['"]/;

    const offenders: string[] = [];
    const outsideIsolation: string[] = [];
    const walk = (dir: URL): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir.pathname, entry);
        const url = new URL(`file://${path}`);
        if (statSync(path).isDirectory()) {
          walk(url);
        } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
          const source = readFileSync(path, 'utf8');
          if (TRANSPORT_IMPORT.test(source)) {
            offenders.push(path);
            // M11.2: src/platform/email is the single zone where transport
            // imports may live. Anything else is a boundary violation.
            const relative = path.split(`${sep}src${sep}`)[1] ?? '';
            if (!relative.startsWith(`platform${sep}email${sep}`)) {
              outsideIsolation.push(path);
            }
          }
        }
      }
    };
    walk(root);

    expect(outsideIsolation).toEqual([]);
    // Presence assertion on the rule itself: if the isolation zone ever stops
    // importing its transport, this suite must say so rather than assert a
    // vacuous universal.
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('translating a toxic raw error yields a clean neutral error', async () => {
    // This is the exact discipline M11.2+ implementations must follow: catch
    // the raw provider error, discard it, and throw a static message. The
    // toxic values below mirror real SMTP/driver failures (recipient echo,
    // host, credential) and must not survive translation.
    const sentinelSmtpPassword = 'smtp-sentinel-secret-k7x2';
    const sentinelToken = 'reset-token-sentinel-q8w4';
    const rawProviderError = new Error(
      `550 Refused for <user@example.com> with ${sentinelToken} at smtp.internal (auth ${sentinelSmtpPassword})`,
    );

    let translated: unknown;
    try {
      try {
        throw rawProviderError;
      } catch {
        // Boundary translation: discard the original, keep static text.
        throw new EmailDeliveryError();
      }
    } catch (error: unknown) {
      translated = error;
    }

    expect(translated).toBeInstanceOf(EmailDeliveryError);
    const serialized = `${(translated as Error).name}: ${(translated as Error).message}`;
    expect(serialized).not.toContain(sentinelSmtpPassword);
    expect(serialized).not.toContain(sentinelToken);
    expect(serialized).not.toContain('smtp.internal');
    expect(serialized).not.toContain('user@example.com');
  });

  it('provider spy observes exactly one send per call (no hidden retry loop)', async () => {
    const send = vi.fn(async (_message: EmailMessage): Promise<void> => undefined);
    const provider: EmailProvider = { send };

    await provider.send(MESSAGE);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(MESSAGE);
  });
});
