import type { EmailProvider } from '../../../shared/email/email-provider.js';
import { renderEmailTemplate } from '../../../shared/email/templates/email-template-registry.js';
import type {
  PasswordResetEmail,
  PasswordResetMailer,
} from '../services/password-reset.service.js';
import type {
  EmailVerificationMailer,
  VerificationEmail,
} from '../services/email-verification.service.js';
import type {
  SecurityNotificationMailer,
} from '../services/security-notification.service.js';

/**
 * Authentication email adapters (M11.3).
 *
 * This module is the INFRASTRUCTURE ADAPTER for the three domain mailer ports
 * that M3 established. The dependency direction is the point of the file:
 *
 * ```
 * auth.service ──▶ PasswordResetMailer (port, domain-owned, M3)
 *                     │
 *                     ▼  this adapter — translation only
 *              EmailMessage (frozen M11.1 contract)
 *                     │
 *                     ▼
 *              EmailProvider ──▶ NoOp | SMTP (frozen M11.2)
 * ```
 *
 * It translates an already-defined domain mail request into the neutral M11.1
 * message contract and hands it to the transport. It deliberately owns
 * NOTHING else:
 *
 * - No tokens: the raw reset/verification credential arrives inside
 *   `resetUrl`/`verificationUrl` and is only ever placed in a message body.
 *   This module never generates, hashes, stores, logs, or inspects it.
 * - No database, no Prisma, no session or credential work.
 * - No SMTP knowledge: it never sees host, port, credentials, TLS mode, or
 *   nodemailer. Swapping the transport cannot change a single line here.
 * - No Fastify: no request, no `request.log`, no request id. Usable from HTTP,
 *   a future job runner, a CLI, or a test.
 * - No markup, no retry, no queue, no background work.
 *
 * Message construction is delegated entirely to the M11.4 template system
 * (`src/shared/email/templates/`): this module passes typed template data and
 * receives `{ subject, text, html }`, then maps that onto the frozen M11.1
 * `EmailMessage`. It holds no copy of its own, so presentation ownership lives
 * in exactly one place and this adapter cannot drift from it.
 */

/** Maps rendered template content onto the frozen M11.1 message contract. */
function toMessage(
  from: string,
  to: string,
  rendered: { subject: string; text: string; html: string },
): { from: string; to: string[]; subject: string; textBody: string; htmlBody: string } {
  return {
    from,
    to: [to],
    subject: rendered.subject,
    textBody: rendered.text,
    htmlBody: rendered.html,
  };
}

/** The three domain mailer ports, backed by one transport. */
export type AuthEmailMailers = {
  passwordReset: PasswordResetMailer;
  emailVerification: EmailVerificationMailer;
  securityNotification: SecurityNotificationMailer;
};

/**
 * Binds the three domain ports to one `EmailProvider`.
 *
 * `from` is supplied by the composition layer, never defaulted here: a hidden
 * sender default would hide which identity actually sent mail, and the frozen
 * M11.1 contract makes `from` mandatory precisely so that decision stays
 * visible and customer-owned.
 *
 * Template data is the only thing this adapter derives from a domain request,
 * and it is the minimum each template needs: the finished one-time URL for the
 * two credential emails, and the event kind plus the policy-derived duration
 * for a security notice. Subjects, wording, HTML, and text all come from the
 * template system (M11.4), so this layer holds no copy and cannot disagree
 * with it.
 *
 * Delivery failures are NOT caught here. Each port's existing caller already
 * owns its failure semantics (post-commit propagation for credentials,
 * best-effort catch-and-log for security notices), and swallowing a failure
 * here would silently redefine those frozen contracts.
 */
export function createAuthEmailMailers(options: {
  provider: EmailProvider;
  from: string;
}): AuthEmailMailers {
  const { provider, from } = options;

  return {
    passwordReset: {
      sendPasswordResetEmail: (email: PasswordResetEmail): Promise<void> =>
        provider.send(
          toMessage(
            from,
            email.to,
            renderEmailTemplate('PASSWORD_RESET', { resetUrl: email.resetUrl }),
          ),
        ),
    },
    emailVerification: {
      sendVerificationEmail: (email: VerificationEmail): Promise<void> =>
        provider.send(
          toMessage(
            from,
            email.to,
            renderEmailTemplate('EMAIL_VERIFICATION', { verificationUrl: email.verificationUrl }),
          ),
        ),
    },
    securityNotification: {
      sendAccountLocked: (email): Promise<void> =>
        provider.send(
          toMessage(
            from,
            email.to,
            renderEmailTemplate('SECURITY_NOTIFICATION', {
              type: 'ACCOUNT_LOCKED',
              lockoutDurationText: email.lockoutDurationText,
            }),
          ),
        ),
      sendPasswordResetSucceeded: (email): Promise<void> =>
        provider.send(
          toMessage(
            from,
            email.to,
            renderEmailTemplate('SECURITY_NOTIFICATION', { type: 'PASSWORD_RESET_SUCCEEDED' }),
          ),
        ),
    },
  };
}