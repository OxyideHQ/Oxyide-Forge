import { createTransport } from 'nodemailer';

import type { SmtpConfig } from '../../config/types.js';
import { assertEmailMessage, type EmailMessage } from '../../shared/email/email-message.js';
import {
  EmailDeliveryError,
  noopEmailProvider,
  type EmailProvider,
} from '../../shared/email/email-provider.js';

/**
 * SMTP email transport (M11.2): the single real `EmailProvider`
 * implementation, owned by the platform layer.
 *
 * Dependency direction (frozen): this module depends on `shared/email`
 * (contract), centralized config *types*, and nodemailer. It never touches
 * Prisma, repositories, auth modules, routes, policies, or request objects,
 * so any Forge module can use it without creating a cycle.
 *
 * Connection lifecycle — disposable transport per send, decided explicitly:
 *
 * - `createTransport` performs no I/O; the connection opens lazily on the
 *   first `sendMail` and is closed in `finally` after every attempt.
 * - Per-send handshakes cost a TCP+TLS round trip each, which is acceptable
 *   because auth/security emails are human-triggered and low-frequency.
 *   What this buys is absence of lingering state: no pool subsystem, no
 *   idle sockets keeping the event loop alive, no shutdown coupling, no
 *   cross-request contamination. A reusable transport would need lifecycle
 *   integration for exactly zero benefit at this volume.
 * - Application startup never touches SMTP: construction is pure object
 *   assembly, and the first connection happens on the first send. A dead
 *   mail server cannot prevent boot (M9.1 no-startup-gating principle,
 *   applied to an optional capability).
 *
 * Timeouts — fixed constants, not configuration (M5.3 fixed-policy
 * precedent: a typo must never silently weaken transport behavior).
 * Nodemailer's own defaults (2min connect / 30s greeting / 10min socket)
 * would park a request handler for minutes on a secondary concern; these
 * values fail fast on blackholes while clearing healthy networks many
 * times over:
 */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 30_000;

/**
 * Maps validated SMTP configuration to nodemailer transport options.
 *
 * Security posture is explicit per mode — never negotiated downward:
 *
 * - `smtps`: implicit TLS from connection start (`secure: true`).
 * - `starttls`: `requireTLS: true` refuses to send when the server does not
 *   offer STARTTLS. Opportunistic upgrade is never accepted silently.
 * - `plaintext`: `ignoreTLS: true` states plaintext openly. Reachable only
 *   without credentials: configuration validation rejects credentials with
 *   this mode, so secrets can never cross an unencrypted connection.
 *
 * Deliberately never passed: `tls.rejectUnauthorized: false` (certificate
 * verification stays at the Node default, always on), `logger`/`debug`
 * (would emit SMTP traffic, including authentication), `pool` (no pool
 * subsystem — one connection per send, closed deterministically).
 */
function transportOptions(smtp: SmtpConfig) {
  const base = {
    host: smtp.host,
    port: smtp.port,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    ...(smtp.user !== undefined && smtp.password !== undefined
      ? { auth: { user: smtp.user, pass: smtp.password } }
      : {}),
  };
  switch (smtp.security) {
    case 'smtps':
      return { ...base, secure: true };
    case 'starttls':
      return { ...base, secure: false, requireTLS: true };
    case 'plaintext':
      return { ...base, secure: false, ignoreTLS: true };
  }
}

/**
 * Builds an `EmailProvider` that delivers through the configured SMTP server.
 *
 * One call performs exactly one SMTP delivery attempt (frozen M11.1 retry
 * boundary): `sendMail` runs once, and the provider never loops, queues, or
 * retries. The nodemailer result (message id, envelope, server response) is
 * deliberately discarded — the frozen contract returns `void`, and server
 * responses can echo recipients.
 *
 * Failure handling (§14/§15): `assertEmailMessage` runs BEFORE the
 * try-boundary, so malformed messages propagate as plain programming errors
 * and are never disguised as delivery failures. Everything the transport
 * raises (connection/auth/send/timeout failures) becomes a static-safe
 * `EmailDeliveryError`; the raw error is discarded, never attached, never
 * logged here. The transporter's `close()` runs in `finally`: a close
 * failure after a completed send cannot change the delivery fact and has no
 * safe channel (this layer owns no logger), so it is resource hygiene only.
 */
export function createSmtpEmailProvider(smtp: SmtpConfig): EmailProvider {
  return {
    async send(message: EmailMessage): Promise<void> {
      assertEmailMessage(message);
      const transporter = createTransport(transportOptions(smtp));
      try {
        await transporter.sendMail({
          from: message.from,
          to: [...message.to],
          subject: message.subject,
          text: message.textBody,
          ...(message.htmlBody === undefined ? {} : { html: message.htmlBody }),
        });
      } catch {
        throw new EmailDeliveryError();
      } finally {
        try {
          transporter.close();
        } catch {
          // Resource hygiene only — see contract note above. Deliberately
          // silent: no logger exists at this layer, and inventing one would
          // violate the M8 single-pipeline boundary.
        }
      }
    },
  };
}

/**
 * Centralized provider selection (M11.2): the single mechanism that chooses
 * between NoOp and SMTP.
 *
 * SMTP configured → real transport. Anything else (absent) → the frozen M11.1
 * NoOp, which validates and delivers nothing. Callers receive an
 * `EmailProvider` and never inspect configuration themselves, so no
 * `if SMTP then ... else ...` logic can spread into services or routes.
 * M11.3 calls this once at wiring time; until then nothing calls it at all
 * and every domain mailer keeps its existing NoOp default.
 */
export function createEmailProvider(options: { smtp?: SmtpConfig }): EmailProvider {
  if (options.smtp === undefined) {
    return noopEmailProvider;
  }
  return createSmtpEmailProvider(options.smtp);
}
