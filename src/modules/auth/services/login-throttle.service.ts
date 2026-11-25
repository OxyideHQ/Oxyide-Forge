import { createHash } from 'node:crypto';

import { config } from '../../../config/index.js';
import { prisma } from '../../../platform/database/prisma.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';
import { usersService } from '../../users/users.service.js';
import { loginThrottleRepository } from '../repositories/login-throttle.repository.js';

/**
 * Login-throttling, brute-force protection, and account-lockout service
 * (M3.14, M3.15, M3.16).
 *
 * Fixed-window frequency control over two independent dimensions:
 *
 * - account: normalized-email scoped, so guessing against one address is
 *   bounded even when the source rotates;
 * - source: client-IP scoped, so spraying across many addresses from one
 *   client is bounded even when the target rotates.
 *
 * M3.15 adds bounded exponential backoff derived from the account
 * dimension's failureCount: repeated failures become progressively more
 * expensive (baseDelayMs doubling per level, capped at maxDelayMs) without
 * ever becoming permanent. The delay is computed from pre-user-lookup
 * throttle state and applied asynchronously before authentication work.
 *
 * M3.16 adds temporary account lockout on `User.lockedUntil`: when account
 * failures reach the lockout threshold within a live window, the account
 * rejects password authentication for a fixed, non-extending duration.
 * Locked attempts record nothing and skip backoff and bcrypt; recovery is
 * expiry-driven (conditional clear) or via password reset. The public
 * rejection reuses the M3.14 429 contract so lock state never becomes an
 * account-existence oracle.
 *
 * This is throttling plus backoff plus temporary lockout — never permanent
 * blocking and no unlock flow. The lock transition result is returned
 * (M3.17 observes it for exactly-one post-commit notification per lock);
 * no audit rows are written (M3.18), and refresh, password reset,
 * and email verification never consult this state (reset clears it on
 * success as the authenticated recovery path).
 *
 * Enumeration resistance is structural: enforcement reads throttle rows
 * before any user lookup, and failure recording is identical for unknown
 * emails and wrong passwords, so observable behavior cannot distinguish
 * the two. Cross-module access goes through the users service contract
 * only — never another module's repository — which keeps the dependency
 * graph acyclic (no importer of usersService references this service).
 */

const ACCOUNT_NAMESPACE = 'auth:login:v1:account';
const IP_NAMESPACE = 'auth:login:v1:ip';

/** Client identity used when the transport supplies no usable source address. */
const UNRESOLVED_IP = 'unresolved';

/**
 * Builds the persistence key for an account dimension.
 * The email MUST already be normalized (trim + lowercase) by the caller —
 * the login flow normalizes once and passes the result down, so no second
 * normalization implementation exists. Raw emails never become storage keys.
 */
export function buildAccountKey(normalizedEmail: string): string {
  const digest = createHash('sha256').update(`account:${normalizedEmail}`, 'utf8').digest('hex');
  return `${ACCOUNT_NAMESPACE}:${digest}`;
}

/**
 * Builds the persistence key for a source dimension.
 * Empty inputs collapse to a single `unresolved` bucket rather than
 * scattering unbounded keys or silently disabling the control.
 */
export function buildIpKey(clientIp: string): string {
  const identity = clientIp.length > 0 ? clientIp : UNRESOLVED_IP;
  const digest = createHash('sha256').update(`ip:${identity}`, 'utf8').digest('hex');
  return `${IP_NAMESPACE}:${digest}`;
}

export type ThrottleIdentity = {
  normalizedEmail: string;
  clientIp: string;
};

function accountWindowMs(): number {
  return config.auth.loginThrottle.accountWindowSeconds * 1000;
}

function ipWindowMs(): number {
  return config.auth.loginThrottle.ipWindowSeconds * 1000;
}

function throttledError(): AppError {
  return new AppError(
    ErrorCodes.AUTH_TOO_MANY_ATTEMPTS,
    429,
    'Too many login attempts. Please try again later.',
  );
}

/**
 * Pure account-lockout predicate (M3.16).
 *
 * A NULL marker means never locked; a marker at or before `now` means the
 * lock has expired (consistent with the refresh convention that
 * `expiresAt <= now` is expired). Only a future marker is a live lock.
 * Deterministic and unit-testable: boundary, ordering, and invalid inputs
 * are pinned by tests.
 */
export function isAccountLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

/**
 * The public rejection for a locked account: the existing M3.14 `429
 * AUTH_TOO_MANY_ATTEMPTS` contract, byte-identical to throttle enforcement.
 * No new error code exists deliberately — at equal treatment a locked known
 * account is indistinguishable from an unknown or throttled one, so lock
 * state never becomes an account-existence oracle. No Retry-After (M3.14
 * precedent): the response reveals neither which control triggered nor any
 * timestamp.
 */
export function lockedError(): AppError {
  return throttledError();
}

/**
 * Computes the progressive brute-force delay for a given account failure
 * count. Pure, deterministic, bounded — no DB access, no request access.
 *
 * The delay is derived from the account dimension's failureCount, which is
 * read before any user lookup. This makes it enumeration-resistant: unknown
 * emails and known emails with wrong passwords receive the same delay for
 * the same failureCount, because failure recording is identical.
 *
 * Formula: delay = min(baseDelayMs × 2^(level-1), maxDelayMs)
 * where level = failureCount - escalationStart + 1 (for failureCount >= escalationStart)
 *
 * The delay is 0 for failureCount below escalationStart (the first ever
 * attempt is never delayed). The delay is capped at maxDelayMs — no
 * attacker-controlled input can produce an unbounded sleep.
 */
export function calculateBruteForceDelay(failureCount: number): number {
  const { baseDelayMs, maxDelayMs, escalationStart } = config.auth.bruteForce;

  // Guard non-finite and negative input before any arithmetic so a corrupted
  // or hostile state can never produce NaN, Infinity, or a negative timeout.
  if (!Number.isFinite(failureCount) || failureCount < escalationStart) {
    return 0;
  }

  const level = Math.floor(failureCount) - escalationStart + 1;

  // Integer bit-shift, not Math.pow: exact integer arithmetic with no
  // floating-point rounding. Level 1 must yield exactly baseDelayMs, so the
  // shift is level-1. The shift is clamped to at most 30 so `1 << n` stays
  // within int32 range and can never wrap or overflow.
  const shift = Math.min(level, 31) - 1;
  const delay = baseDelayMs * (1 << shift);

  // Hard upper bound: no attacker-controlled state can produce an unbounded
  // or multi-minute delay. This is the M3.15 safety invariant.
  return Math.min(delay, maxDelayMs);
}

/**
 * Asynchronous delay that does not block the Node.js event loop.
 * Uses setTimeout — the smallest possible async delay mechanism.
 * No worker threads, no child processes, no synchronous sleep.
 */
export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Enforces the throttle before authentication is attempted.
 *
 * Reads both dimensions and rejects with 429 when either live window has
 * reached its threshold. Runs before any user lookup or password check, so
 * throttled attempts skip bcrypt work and reveal nothing about account
 * existence. Expired rows count as absent; they are recycled on the next
 * failure. Throttle-store failures propagate — login fails closed with the
 * sanitized 5xx contract rather than bypassing the control or masking an
 * outage as an authentication failure.
 *
 * Returns the progressive brute-force delay (milliseconds) computed from the
 * account dimension's failureCount. The caller applies this delay before
 * user lookup, making it enumeration-resistant: the delay is a function of
 * pre-authentication state only.
 */
export async function checkLoginAllowed(identity: ThrottleIdentity): Promise<{
  delayMs: number;
}> {
  const now = new Date();
  const [accountRow, ipRow] = await Promise.all([
    loginThrottleRepository.findByKey(buildAccountKey(identity.normalizedEmail)),
    loginThrottleRepository.findByKey(buildIpKey(identity.clientIp)),
  ]);

  const accountLive = accountRow !== null && accountRow.expiresAt.getTime() > now.getTime();
  const ipLive = ipRow !== null && ipRow.expiresAt.getTime() > now.getTime();

  if (
    (accountLive && accountRow.failureCount >= config.auth.loginThrottle.accountThreshold) ||
    (ipLive && ipRow.failureCount >= config.auth.loginThrottle.ipThreshold)
  ) {
    throw throttledError();
  }

  const delayMs = accountLive ? calculateBruteForceDelay(accountRow.failureCount) : 0;
  return { delayMs };
}

/**
 * Early account-lockout gate for the login flow (M3.16).
 *
 * Runs after user lookup and before throttle enforcement: a live lock
 * rejects immediately with the generic 429, skipping backoff delay, bcrypt,
 * session creation, and JWT signing. Attempts made while locked record
 * nothing and change nothing — attacker traffic can never extend the lock.
 * An expired lock is recovered atomically via conditional clear; if the
 * clear loses a race to a freshly committed lock, the re-read observes it
 * and rejects, so a newer lock is never erased by stale recovery.
 * Unknown accounts have no lock state and always proceed.
 */
export async function checkAccountLockout(
  userId: string,
  lockedUntil: Date | null,
): Promise<void> {
  if (lockedUntil === null) {
    return;
  }
  const now = new Date();
  if (isAccountLocked(lockedUntil, now)) {
    throw lockedError();
  }
  const cleared = await usersService.clearExpiredAccountLock(userId, now);
  if (cleared) {
    return;
  }
  const reread = await usersService.findById(userId);
  if (!reread || isAccountLocked(reread.lockedUntil, new Date())) {
    throw lockedError();
  }
}

/**
 * Post-authentication lockout revalidation (M3.16).
 *
 * Closes the stale-success race: a lock committed between the early gate
 * and password verification (e.g. concurrent failures crossing the
 * threshold during bcrypt) must block session issuance. Called after a
 * successful password check and before any credential is created. An
 * expired lock is recovered with the same conditional-clear discipline as
 * the early gate. Throws the generic 429 when locked; returns otherwise.
 */
export async function revalidateUnlockedForIssuance(userId: string): Promise<void> {
  const current = await usersService.findById(userId);
  if (!current || isAccountLocked(current.lockedUntil, new Date())) {
    throw lockedError();
  }
  if (current.lockedUntil !== null) {
    const cleared = await usersService.clearExpiredAccountLock(userId, new Date());
    if (!cleared) {
      const reread = await usersService.findById(userId);
      if (!reread || isAccountLocked(reread.lockedUntil, new Date())) {
        throw lockedError();
      }
    }
  }
}

/**
 * Result of recording one invalid-credential outcome (M3.17).
 *
 * `transitionedToLocked` is true only when THIS call performed the atomic
 * unlocked → locked transition. Concurrent threshold-crossers converge: at
 * most one caller observes true, so at most one post-commit security
 * notification is attempted per lock. Already-locked retries, pre-threshold
 * failures, and unknown emails all report false.
 */
export type RecordLoginFailureResult = {
  transitionedToLocked: boolean;
};

/**
 * Records one invalid-credential outcome against both dimensions, applying
 * the account lockout transition when the threshold is crossed (M3.16).
 *
 * Called for unknown emails and wrong passwords identically — the caller
 * passes only the normalized attempted email, the source address, and the
 * resolved user ID (null when no account exists), never a lookup result.
 * Schema-invalid requests never reach this function (Fastify rejects them
 * at the boundary) and infrastructure failures are never recorded (only
 * evaluated outcomes are).
 *
 * For known accounts the account-dimension increment and the lockout
 * transition commit in ONE service-owned transaction: there is no state
 * where the count reached the threshold but the lock is missing because a
 * concurrent request raced in between. The lock marker is set conditionally
 * (only when no live lock exists), so concurrent crossers converge and a
 * live lock keeps its original expiry. The transaction returns whether THIS
 * caller performed the transition — the M3.17 notification trigger, known
 * atomically rather than inferred from a racy pre-check. Unknown emails
 * take the identical throttle-only path M3.14 established. The IP dimension
 * and expired-row cleanup stay outside the transaction: they are independent
 * of the lock transition, keeping the transaction short with no I/O inside.
 */
export async function recordLoginFailure(
  identity: ThrottleIdentity,
  userId: string | null,
): Promise<RecordLoginFailureResult> {
  const now = new Date();
  const accountInput = {
    key: buildAccountKey(identity.normalizedEmail),
    failureCount: 1,
    windowStartedAt: now,
    expiresAt: new Date(now.getTime() + accountWindowMs()),
  };

  const accountWork: Promise<boolean> =
    userId === null
      ? loginThrottleRepository.recordFailure(accountInput).then(() => false)
      : prisma.$transaction(async (tx) => {
          const row = await loginThrottleRepository.recordFailure(accountInput, tx);
          if (row.failureCount >= config.auth.accountLockout.failureThreshold) {
            return usersService.setAccountLockIfUnlocked(
              userId,
              new Date(now.getTime() + config.auth.accountLockout.lockoutDurationSeconds * 1000),
              tx,
            );
          }
          return false;
        });

  const [transitionedToLocked] = await Promise.all([
    accountWork,
    loginThrottleRepository.recordFailure({
      key: buildIpKey(identity.clientIp),
      failureCount: 1,
      windowStartedAt: now,
      expiresAt: new Date(now.getTime() + ipWindowMs()),
    }),
    loginThrottleRepository.deleteExpired(),
  ]);
  return { transitionedToLocked };
}

/**
 * Resets account-scoped failure state after a successful authentication.
 *
 * A legitimate user who mistypes and then succeeds recovers immediately
 * instead of waiting out the window. Source-scoped state is deliberately
 * left to expire: one correct guess must not erase abuse protection for
 * the originating client.
 */
export async function clearAccountThrottle(normalizedEmail: string): Promise<void> {
  await loginThrottleRepository.clearByKey(buildAccountKey(normalizedEmail));
}

export const loginThrottleService = {
  buildAccountKey,
  buildIpKey,
  calculateBruteForceDelay,
  delay,
  isAccountLocked,
  lockedError,
  checkAccountLockout,
  revalidateUnlockedForIssuance,
  checkLoginAllowed,
  recordLoginFailure,
  clearAccountThrottle,
};
