import { config } from '../../../config/index.js';
import { createEmailProvider } from '../../../platform/email/smtp-email-provider.js';
import { noopEmailVerificationMailer } from '../services/email-verification.service.js';
import { noopPasswordResetMailer } from '../services/password-reset.service.js';
import { noopSecurityNotificationMailer } from '../services/security-notification.service.js';
import { createAuthEmailMailers, type AuthEmailMailers } from './auth-email-mailers.js';

/**
 * Authentication email composition (M11.3) — the single wiring point.
 *
 * This is the ONLY place in the tree that decides which transport exists and
 * which sender identity is used. Everything downstream receives a domain
 * mailer port and never learns whether mail leaves the process.
 *
 * Two composition outcomes, both explicit:
 *
 * 1. **SMTP configured** — `createEmailProvider` (the frozen M11.2 selection)
 *    returns the SMTP transport and the three M3 domain ports are adapted onto
 *    it. Authentication code is untouched by this decision.
 * 2. **No SMTP configured** — the frozen M11.1 NoOp `EmailProvider` is used.
 *    No connection is attempted, no credential is read, nothing is persisted,
 *    and no message is even constructed: the frozen M3 NoOp ports are returned
 *    verbatim, which keeps the pre-M11.3 default behaviour bit-for-bit.
 *
 * There is no third state. Centralized configuration guarantees
 * `config.smtp` and `config.email.from` are present together or absent
 * together (partial email configuration is rejected at startup), so this
 * module never has to invent a sender or fall back to a default transport.
 */

/**
 * Derives the sender identity from validated centralized configuration.
 *
 * `APP_BASE_URL` is the application's own public origin — operator-supplied,
 * validated, and `https`-enforced in production — so its host is already the
 * customer's own domain. Deriving `no-reply@<host>` from it keeps the sender
 * deterministic and customer-owned without inventing a second configuration
 * mechanism (no `SMTP_FROM`, no per-message default, no hidden identity).
 *
 * Deliberate limitation: the sender host is the application host. A customer
 * whose mail domain differs from their application host must align them; a
 * separate sender override is future work, not something to smuggle in here.
 */
export function defaultSenderAddress(appBaseUrl: string): string {
  return `no-reply@${new URL(appBaseUrl).hostname}`;
}

/** Frozen M3 NoOp ports, reused verbatim when no transport is configured. */
const noopAuthEmailMailers: AuthEmailMailers = {
  passwordReset: noopPasswordResetMailer,
  emailVerification: noopEmailVerificationMailer,
  securityNotification: noopSecurityNotificationMailer,
};

/**
 * The composed authentication mailers.
 *
 * Built once at module load. Construction is pure object assembly — the SMTP
 * transport opens no connection until the first send — so importing this
 * module can never make application startup depend on a live mail server.
 */
export const authEmailMailers: AuthEmailMailers =
  config.smtp === undefined
    ? noopAuthEmailMailers
    : createAuthEmailMailers({
        provider: createEmailProvider({ smtp: config.smtp }),
        from: defaultSenderAddress(config.appBaseUrl),
      });