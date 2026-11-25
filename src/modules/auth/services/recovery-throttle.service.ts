import { createHash } from 'node:crypto';

import { config } from '../../../config/index.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';
import { loginThrottleRepository } from '../repositories/login-throttle.repository.js';

/**
 * Recovery-issuance frequency control (M5.4).
 *
 * Fixed-window frequency control over the two unauthenticated
 * email-issuing endpoints: password-reset request and email-verification
 * resend. Both endpoints silently succeed (204) for unknown emails, so the
 * control MUST NOT depend on account existence: buckets are keyed by the
 * *attempted* normalized email (identical for known and unknown addresses)
 * and every request records — before any user lookup runs. Over-limit
 * known and unknown addresses therefore behave byte-identically (429),
 * and throttling never becomes an account-existence oracle.
 *
 * Increment-first discipline: the attempt is recorded BEFORE the
 * threshold is evaluated, so a concurrent burst cannot slip past the
 * check — exactly `threshold` requests per window proceed and the rest
 * reject, no matter how they interleave. Rejected attempts still consume
 * bucket capacity (probing is not free).
 *
 * This is pure frequency control: no lockout, no backoff, no success
 * reset, no permanent state — windows expire naturally. Persistence
 * reuses the `LoginThrottle` table under recovery namespaces (no
 * migration) and the atomic `recordFailure` increment primitive (no
 * repository change). Store failures propagate — issuance fails closed
 * with the sanitized 5xx contract rather than bypassing the control.
 */

const NAMESPACE_BASE = 'auth:recovery:v1';

/** Issuing endpoint scopes. Separate namespaces so heavy use of one endpoint never blocks the other. */
export type RecoveryScope = 'password-reset' | 'email-verification';

/** Client identity used when the transport supplies no usable source address. */
const UNRESOLVED_IP = 'unresolved';

function scopeSegment(scope: RecoveryScope): string {
  return scope === 'password-reset' ? 'password-reset' : 'email-verification';
}

/**
 * Builds the persistence key for an account dimension.
 * The email MUST already be normalized (trim + lowercase) by the caller —
 * the auth flow normalizes once and passes the result down. Raw emails
 * never become storage keys; the key is a one-way hash.
 */
export function buildAccountKey(scope: RecoveryScope, normalizedEmail: string): string {
  const digest = createHash('sha256')
    .update(`account:${normalizedEmail}`, 'utf8')
    .digest('hex');
  return `${NAMESPACE_BASE}:${scopeSegment(scope)}:account:${digest}`;
}

/**
 * Builds the persistence key for a source dimension.
 * Empty inputs collapse to a single `unresolved` bucket rather than
 * scattering unbounded keys or silently disabling the control.
 */
export function buildIpKey(scope: RecoveryScope, clientIp: string): string {
  const identity = clientIp.length > 0 ? clientIp : UNRESOLVED_IP;
  const digest = createHash('sha256').update(`ip:${identity}`, 'utf8').digest('hex');
  return `${NAMESPACE_BASE}:${scopeSegment(scope)}:ip:${digest}`;
}

export type RecoveryIdentity = {
  scope: RecoveryScope;
  normalizedEmail: string;
  clientIp: string;
};

function accountWindowMs(): number {
  return config.auth.recoveryThrottle.accountWindowSeconds * 1000;
}

function ipWindowMs(): number {
  return config.auth.recoveryThrottle.ipWindowSeconds * 1000;
}

function throttledError(): AppError {
  return new AppError(
    ErrorCodes.AUTH_TOO_MANY_ATTEMPTS,
    429,
    'Too many recovery attempts. Please try again later.',
  );
}

/**
 * Records one issuance attempt against both dimensions and rejects when
 * either live window has exceeded its threshold.
 *
 * MUST run before any user lookup: the caller passes only the attempted
 * (normalized) email and the source address, never a lookup result, so
 * unknown addresses consume buckets exactly like known ones.
 */
export async function checkAndRecordRecoveryAttempt(identity: RecoveryIdentity): Promise<void> {
  const now = new Date();

  const [accountRow, ipRow] = await Promise.all([
    loginThrottleRepository.recordFailure({
      key: buildAccountKey(identity.scope, identity.normalizedEmail),
      failureCount: 1,
      windowStartedAt: now,
      expiresAt: new Date(now.getTime() + accountWindowMs()),
    }),
    loginThrottleRepository.recordFailure({
      key: buildIpKey(identity.scope, identity.clientIp),
      failureCount: 1,
      windowStartedAt: now,
      expiresAt: new Date(now.getTime() + ipWindowMs()),
    }),
    loginThrottleRepository.deleteExpired(),
  ]);

  if (
    accountRow.failureCount > config.auth.recoveryThrottle.accountThreshold ||
    ipRow.failureCount > config.auth.recoveryThrottle.ipThreshold
  ) {
    throw throttledError();
  }
}

export const recoveryThrottleService = {
  buildAccountKey,
  buildIpKey,
  checkAndRecordRecoveryAttempt,
};
