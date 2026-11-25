/**
 * Authentication security events (M8.3).
 *
 * The vocabulary follows the established dotted convention of
 * `authorization-logger.ts` (`authorization.decision`,
 * `authentication.subject_invalid`) but lives in the auth module because
 * only auth flows can emit these events — vocabulary is owned by the
 * domain that produces it, so no cross-module edge is introduced.
 *
 * Design (observational only):
 * - Policies and services decide what happened; this boundary only records
 *   it. Emitting never throws of its own (payload is built from
 *   allowlisted fields; unknown fields are impossible by construction).
 * - The sink is a structural `{ info, warn }` pair satisfied directly by
 *   `request.log`, whose Fastify child binding already carries the request
 *   ID — no request-ID plumbing here, no second correlation ID.
 * - Level follows the authorization precedent: success → `info`,
 *   anything else → `warn`. Expected client failures are never `error`
 *   (frozen M6.7 policy).
 * - Privacy follows the M8.2 contract verbatim: no passwords, hashes,
 *   tokens, headers, cookies, bodies, or emails — ever. The attempted
 *   account is identified by subject UUID only when the account is known;
 *   unknown-account failures carry no identifier at all (an email would
 *   be PII and an existence oracle). Enumeration-sensitive request flows
 *   (`password_reset.requested`, `email_verification.requested`) carry no
 *   account identifier by construction.
 */

/** Minimal structural logger. Satisfied directly by `request.log`. */
export type SecurityEventLog = {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
};

/** Closed event vocabulary. Every event below exists in a real auth flow. */
export const AuthSecurityEventName = {
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILURE: 'auth.login.failure',
  ACCOUNT_LOCKED: 'auth.account.locked',
  REFRESH_REPLAY: 'auth.refresh.replay',
  SESSION_REVOKED: 'auth.session.revoked',
  SESSIONS_REVOKED_ALL: 'auth.sessions.revoked_all',
  PASSWORD_RESET_REQUESTED: 'auth.password_reset.requested',
  PASSWORD_RESET_COMPLETED: 'auth.password_reset.completed',
  EMAIL_VERIFICATION_REQUESTED: 'auth.email_verification.requested',
  EMAIL_VERIFICATION_COMPLETED: 'auth.email_verification.completed',
} as const;

export type AuthSecurityEvent = (typeof AuthSecurityEventName)[keyof typeof AuthSecurityEventName];

/** Controlled outcome vocabulary. Never user-provided. */
export type AuthSecurityOutcome =
  | 'success'
  | 'failure'
  | 'locked'
  | 'replay_detected'
  | 'revoked'
  | 'no_session'
  | 'requested';

/**
 * Stable reason codes, mapped from existing error classifications —
 * never raw messages, never database internals.
 */
export type AuthSecurityReason =
  | 'invalid_credentials'
  | 'account_locked'
  | 'throttled'
  | 'invalid_token';

/**
 * Explicit allowlisted payload. `subjectId` is the account UUID and is
 * present only when the account is known without creating an oracle;
 * `revokedCount` is a plain number. Nothing else can be attached.
 */
export type AuthSecurityEventInput = {
  event: AuthSecurityEvent;
  outcome: AuthSecurityOutcome;
  subjectId?: string;
  reason?: AuthSecurityReason;
  revokedCount?: number;
};

/**
 * Emits one structured auth security event with the exact allowlisted
 * fields. Success is `info`; every other outcome is `warn`.
 */
export function emitAuthSecurityEvent(
  log: SecurityEventLog,
  input: AuthSecurityEventInput,
): void {
  const fields: Record<string, unknown> = {
    event: input.event,
    outcome: input.outcome,
  };
  if (input.subjectId !== undefined) {
    fields.subjectId = input.subjectId;
  }
  if (input.reason !== undefined) {
    fields.reason = input.reason;
  }
  if (input.revokedCount !== undefined) {
    fields.revokedCount = input.revokedCount;
  }
  if (input.outcome === 'success') {
    log.info(fields, 'auth security event');
  } else {
    log.warn(fields, 'auth security event');
  }
}

/** Silent sink for services running without a request logger (unit tests, jobs). */
export const noopSecurityEventLog: SecurityEventLog = {
  info: () => {},
  warn: () => {},
};

/** Optional logger sink, merged into service options (default: silent). */
export type AuthSecurityEventOptions = {
  securityEventLogger?: SecurityEventLog;
};
