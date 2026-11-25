import { config } from '../../../config/index.js';

/**
 * Authentication security notifications (M3.17).
 *
 * Notifies users about meaningful authentication/security events by email:
 * account lockout and successful password reset. This is a narrow,
 * provider-neutral delivery port — not a generic notification platform.
 *
 * Design constraints (load-bearing):
 *
 * - Post-commit only: the owning service (auth.service) sends strictly after
 *   its security transaction commits. The transaction is never held open for
 *   email I/O (engineering standards §16.2).
 * - Best-effort at-most-once: delivery failure is caught at the call site,
 *   logged safely, and never rolls back or alters the primary security
 *   operation. There is no outbox, queue, worker, or retry — a process crash
 *   between commit and send loses the notification. Security state is
 *   authoritative; delivery is secondary.
 * - Transition-based: lockout notifies only when the atomic lock transition
 *   reports `transitionedToLocked`; already-locked retries never re-notify.
 *   Reset notifies only after a fully validated successful completion.
 * - Narrow DTOs: the mailer receives only `{ to }` plus, for a lockout, the
 *   policy-derived `{ lockoutDurationText }`.
 *   Never a User row, Prisma model, token, password, JWT, timestamp, counter,
 *   or rendered content — so future fields cannot leak through this boundary.
 * - Template-owned presentation (M11.4): this port carries the recipient and
 *   the facts a notice prints; subject, text, and HTML are rendered by
 *   `src/shared/email/templates/`. Duration stays human-friendly ("30 minutes"
 *   derived from policy) rather than a raw timestamp, avoiding timezone
 *   complexity and state leakage.
 * - Recipient is always the canonical `User.email` snapshot owned by the
 *   calling service — never request input, never a header.
 *
 * There is no production email provider in this milestone (same posture as
 * the M3.11/M3.12 mailer ports): the default transport delivers nothing.
 * Tests inject a capturing fake. A future provider implements
 * `SecurityNotificationMailer` without touching the auth domain.
 */

/** Closed set of security notification types. No arbitrary event names. */
export type SecurityNotificationType = 'ACCOUNT_LOCKED' | 'PASSWORD_RESET_SUCCEEDED';

/**
 * Delivery address + the one fact a lockout notice prints for an account-lockout
 * notice.
 *
 * M11.4 moved subject and body ownership to the email template system
 * (`src/shared/email/templates/`): presentation had been split between this
 * service (M3.17 static text) and the adapter, and a template may not own only
 * half a message. The DTO is now narrower than before — it carries the
 * canonical recipient and a policy-derived fact, and never rendered content.
 */
export type AccountLockedEmail = {
  to: string;
  lockoutDurationText: string;
};

/** Delivery address for a password-change notice. */
export type PasswordResetSucceededEmail = {
  to: string;
};

/**
 * Minimal delivery port for authentication security notices.
 *
 * Explicit typed methods (not a generic `send(event)`) so an unsupported
 * event cannot silently result in an email. Each method carries its own
 * narrow DTO.
 */
export type SecurityNotificationMailer = {
  sendAccountLocked(email: AccountLockedEmail): Promise<void>;
  sendPasswordResetSucceeded(email: PasswordResetSucceededEmail): Promise<void>;
};

export const noopSecurityNotificationMailer: SecurityNotificationMailer = {
  sendAccountLocked(): Promise<void> {
    return Promise.resolve();
  },
  sendPasswordResetSucceeded(): Promise<void> {
    return Promise.resolve();
  },
};

/**
 * Minimal structured logger for notification delivery failures.
 *
 * Deliberately narrower than the full Fastify logger: only `error` with
 * structured fields is needed. Compatible with `request.log`/`app.log`
 * (structural typing) and with capturing test fakes.
 */
export type SecurityNotificationLogger = {
  error(fields: Record<string, unknown>, message: string): void;
};

export const noopSecurityNotificationLogger: SecurityNotificationLogger = {
  error(): void {
    // No-op default: delivery failures are unobservable without a logger.
    // Routes pass request.log; services pass test fakes.
  },
};

/**
 * Human-friendly lockout duration derived from policy ("30 minutes").
 * Duration — not an absolute timestamp — avoids timezone complexity and
 * keeps the raw `lockedUntil` marker out of the message.
 */
export function lockoutDurationText(): string {
  const minutes = Math.round(config.auth.accountLockout.lockoutDurationSeconds / 60);
  return `${minutes} minutes`;
}

/**
 * Builds the account-lockout request for a canonical recipient address.
 *
 * Factual and minimal by construction: the only variable content is the
 * lockout duration, derived from policy by `lockoutDurationText()` (never a
 * timestamp, never the raw `lockedUntil` marker, never a failure count). The
 * notice wording — that a lockout proves unsuccessful sign-in attempts and not
 * compromise — is template-owned (M11.4) and deliberately unreachable from
 * here, so a future domain change cannot rewrite what a reader is told.
 */
export function buildAccountLockedEmail(to: string): AccountLockedEmail {
  return { to, lockoutDurationText: lockoutDurationText() };
}

/**
 * Builds the password-change request for a canonical recipient address.
 *
 * States only what M3.11 guarantees, and states it by event rather than by
 * content: the template owns the wording that says the password changed and
 * existing sessions were revoked. No password, token, URL, session ID, or JWT
 * is derivable from this request — the reset credential has served its purpose
 * by send time.
 */
export function buildPasswordResetSucceededEmail(to: string): PasswordResetSucceededEmail {
  return { to };
}

/**
 * Logs a notification delivery failure with safe fields only.
 *
 * Only the internal user ID (never the email address), the closed event
 * type, and the provider error's class name are recorded. The error message,
 * stack, and payload are deliberately excluded: provider errors can echo the
 * recipient, request body, or credentials.
 */
export function logNotificationFailure(
  logger: SecurityNotificationLogger,
  input: { type: SecurityNotificationType; userId: string; error: unknown },
): void {
  const errorName = input.error instanceof Error ? input.error.name : 'unknown';
  logger.error(
    {
      event: 'security.notification.delivery_failed',
      type: input.type,
      userId: input.userId,
      errorName,
    },
    'security notification delivery failed',
  );
}

export const securityNotificationService = {
  lockoutDurationText,
  buildAccountLockedEmail,
  buildPasswordResetSucceededEmail,
  logNotificationFailure,
  noopSecurityNotificationMailer,
  noopSecurityNotificationLogger,
};
