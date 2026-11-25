import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

import type { SmtpConfig } from '../../config/types.js';
import type { EmailMessage } from '../../shared/email/email-message.js';
import {
  EmailDeliveryError,
  noopEmailProvider,
} from '../../shared/email/email-provider.js';

/**
 * M11.2 — SMTP provider tests.
 *
 * Nodemailer is mocked at the module boundary, so no SMTP server, socket, or
 * credential ever exists in this suite. The mock reproduces exactly the
 * surface the provider uses (`createTransport` → `{ sendMail, close }`) and
 * records every call, which is what lets these tests prove mapping,
 * single-attempt, close discipline, and error translation without a network.
 *
 * No real emails are sent here or anywhere in automated validation (§25).
 */

type SentMail = Record<string, unknown>;

const sentMails: SentMail[] = [];
let sendBehavior: 'ok' | Error = 'ok';
let closeCalls = 0;
let createTransportCalls: unknown[] = [];

vi.mock('nodemailer', () => ({
  createTransport: vi.fn((options: unknown) => {
    createTransportCalls.push(options);
    return {
      sendMail: vi.fn(async (mail: SentMail) => {
        sentMails.push({ ...mail });
        if (sendBehavior instanceof Error) {
          throw sendBehavior;
        }
        return { messageId: '<mocked@localhost>', envelope: {}, accepted: [], rejected: [] };
      }),
      close: vi.fn(() => {
        closeCalls += 1;
      }),
    };
  }),
}));

const { createSmtpEmailProvider, createEmailProvider } = await import('./smtp-email-provider.js');

const SMTP: SmtpConfig = {
  host: 'smtp.example.com',
  port: 587,
  user: 'forge',
  password: 'smtp-sentinel-secret-k7x2',
  security: 'starttls',
};

const MESSAGE: EmailMessage = {
  from: 'no-reply@example.com',
  to: ['user@example.com'],
  subject: 'Security alert',
  textBody: 'Something happened.',
};

beforeEach(() => {
  sentMails.length = 0;
  createTransportCalls = [];
  closeCalls = 0;
  sendBehavior = 'ok';
  vi.clearAllMocks();
});

describe('SMTP provider mapping', () => {
  it('sends a text email with mapped sender, recipients, subject, and body', async () => {
    const provider = createSmtpEmailProvider(SMTP);

    await provider.send(MESSAGE);

    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]).toMatchObject({
      from: 'no-reply@example.com',
      to: ['user@example.com'],
      subject: 'Security alert',
      text: 'Something happened.',
    });
    expect(sentMails[0]).not.toHaveProperty('html');
  });

  it('preserves text as the plain alternative when HTML is present', async () => {
    const provider = createSmtpEmailProvider(SMTP);

    await provider.send({ ...MESSAGE, htmlBody: '<p>Something happened.</p>' });

    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]).toMatchObject({
      text: 'Something happened.',
      html: '<p>Something happened.</p>',
    });
  });

  it('maps multiple recipients as a list', async () => {
    const provider = createSmtpEmailProvider(SMTP);

    await provider.send({ ...MESSAGE, to: ['a@example.com', 'b@example.com'] });

    expect(sentMails[0]).toMatchObject({ to: ['a@example.com', 'b@example.com'] });
  });

  it('rejects a malformed message with a plain error, never EmailDeliveryError', async () => {
    const provider = createSmtpEmailProvider(SMTP);

    try {
      await provider.send({ ...MESSAGE, to: [] });
      expect.unreachable('must throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(EmailDeliveryError);
    }
    expect(sentMails).toHaveLength(0);
  });
});

describe('SMTP transport options', () => {
  it('uses implicit TLS for smtps without STARTTLS flags', async () => {
    const provider = createSmtpEmailProvider({ ...SMTP, security: 'smtps', port: 465 });

    await provider.send(MESSAGE);

    expect(createTransportCalls).toHaveLength(1);
    const options = createTransportCalls[0] as Record<string, unknown>;
    expect(options).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true });
    expect(options).not.toHaveProperty('requireTLS');
    expect(options).not.toHaveProperty('ignoreTLS');
  });

  it('requires STARTTLS for starttls and never accepts opportunistic upgrade', async () => {
    const provider = createSmtpEmailProvider(SMTP);

    await provider.send(MESSAGE);

    const options = createTransportCalls[0] as Record<string, unknown>;
    expect(options).toMatchObject({ secure: false, requireTLS: true });
    expect(options).not.toHaveProperty('ignoreTLS');
  });

  it('states plaintext openly for development relays', async () => {
    const provider = createSmtpEmailProvider({
      host: 'localhost',
      port: 1025,
      security: 'plaintext',
    });

    await provider.send(MESSAGE);

    const options = createTransportCalls[0] as Record<string, unknown>;
    expect(options).toMatchObject({ secure: false, ignoreTLS: true });
    expect(options).not.toHaveProperty('auth');
  });

  it('passes credentials only when both are configured', async () => {
    const provider = createSmtpEmailProvider(SMTP);

    await provider.send(MESSAGE);

    const options = createTransportCalls[0] as Record<string, unknown>;
    expect(options).toMatchObject({ auth: { user: 'forge', pass: 'smtp-sentinel-secret-k7x2' } });
  });

  it('never disables certificate verification and never enables traffic debug', async () => {
    const provider = createSmtpEmailProvider(SMTP);

    await provider.send(MESSAGE);

    const serialized = JSON.stringify(createTransportCalls[0]);
    expect(serialized).not.toContain('rejectUnauthorized');
    expect(createTransportCalls[0]).not.toHaveProperty('logger');
    expect(createTransportCalls[0]).not.toHaveProperty('debug');
  });

  it('bounds every timeout below nodemailer defaults', async () => {
    const provider = createSmtpEmailProvider(SMTP);

    await provider.send(MESSAGE);

    const options = createTransportCalls[0] as Record<string, unknown>;
    // Nodemailer defaults (2min connect / 30s greeting / 10min socket) would
    // park a request handler on a secondary concern; these fail fast.
    expect(options['connectionTimeout']).toBeLessThanOrEqual(10_000);
    expect(options['greetingTimeout']).toBeLessThanOrEqual(10_000);
    expect(options['socketTimeout']).toBeLessThanOrEqual(30_000);
    for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
      expect(typeof options[key]).toBe('number');
    }
  });
});

describe('SMTP error translation', () => {
  const toxic = (kind: string): Error =>
    new Error(
      `${kind} for <user@example.com> against smtp.internal:587 as forge (auth smtp-sentinel-secret-k7x2)`,
    );

  it.each([
    ['connection failure', 'connect ECONNREFUSED smtp.internal:587'],
    ['authentication failure', '535 Authentication failed for forge'],
    ['send rejection', '550 mailbox unavailable for <user@example.com>'],
    ['timeout', 'Greeting never received from smtp.internal:587'],
  ])('translates %s into EmailDeliveryError', async (_label, detail) => {
    sendBehavior = toxic(detail);
    const provider = createSmtpEmailProvider(SMTP);

    try {
      await provider.send(MESSAGE);
      expect.unreachable('must throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect((error as Error).message).toBe('Email delivery failed.');
    }
  });

  it('never lets the raw provider error escape', async () => {
    const raw = toxic('connect ECONNREFUSED');
    sendBehavior = raw;
    const provider = createSmtpEmailProvider(SMTP);

    const caught = await provider.send(MESSAGE).then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).not.toBe(raw);
    expect(caught).toBeInstanceOf(EmailDeliveryError);
  });

  it('translated error carries no recipient, host, credential, or body', async () => {
    sendBehavior = toxic('535 Authentication failed');
    const provider = createSmtpEmailProvider(SMTP);

    const caught = await provider.send(MESSAGE).then(
      () => null,
      (error: unknown) => error,
    );

    const serialized = `${(caught as Error).name}: ${(caught as Error).message}`;
    for (const secret of [
      'smtp-sentinel-secret-k7x2',
      'smtp.internal',
      'user@example.com',
      'Something happened',
    ]) {
      expect(serialized, `translated error leaked ${secret}`).not.toContain(secret);
    }
  });

  it('still closes the transport when sending fails', async () => {
    sendBehavior = toxic('connect ECONNREFUSED');
    const provider = createSmtpEmailProvider(SMTP);

    await expect(provider.send(MESSAGE)).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(closeCalls).toBe(1);
  });
});

describe('SMTP single attempt (no retry loop)', () => {
  it('performs exactly one sendMail and one close per send call', async () => {
    const provider = createSmtpEmailProvider(SMTP);

    await provider.send(MESSAGE);

    expect(sentMails).toHaveLength(1);
    expect(closeCalls).toBe(1);
  });

  it('creates a fresh transport per send (no shared connection state)', async () => {
    const provider = createSmtpEmailProvider(SMTP);

    await provider.send(MESSAGE);
    await provider.send(MESSAGE);

    expect(createTransportCalls).toHaveLength(2);
    expect(sentMails).toHaveLength(2);
    expect(closeCalls).toBe(2);
  });
});

describe('provider selection', () => {
  it('returns the NoOp provider when SMTP is absent', async () => {
    const provider = createEmailProvider({});

    expect(provider).toBe(noopEmailProvider);
    await expect(provider.send(MESSAGE)).resolves.toBeUndefined();
  });

  it('returns an SMTP provider when SMTP is configured', async () => {
    const provider = createEmailProvider({ smtp: SMTP });

    expect(provider).not.toBe(noopEmailProvider);
    await provider.send(MESSAGE);
    expect(sentMails).toHaveLength(1);
  });

  it('SMTP provider satisfies the same contract as NoOp', async () => {
    const provider = createEmailProvider({ smtp: SMTP });

    await expect(provider.send(MESSAGE)).resolves.toBeUndefined();
    await expect(provider.send({ ...MESSAGE, to: [] })).rejects.not.toBeInstanceOf(
      EmailDeliveryError,
    );
  });
});
