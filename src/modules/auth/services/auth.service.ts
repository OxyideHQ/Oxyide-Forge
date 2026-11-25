import { randomBytes, randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { config } from '../../../config/index.js';
import { prisma } from '../../../platform/database/prisma.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';
import { usersService } from '../../users/users.service.js';
import { toPublicUser, type PublicUser } from '../../users/user-response.js';
import { credentialRepository } from '../repositories/credential.repository.js';
import { emailVerificationRepository } from '../repositories/email-verification.repository.js';
import {
  buildVerificationUrl,
  emailVerificationService,
  hashVerificationToken,
  noopEmailVerificationMailer,
  type EmailVerificationMailer,
} from './email-verification.service.js';
import { hashPassword, validatePasswordForSetting, verifyPassword } from './password.service.js';
import { passwordResetService, type PasswordResetMailer } from './password-reset.service.js';
import {
  buildAccountLockedEmail,
  buildPasswordResetSucceededEmail,
  logNotificationFailure,
  noopSecurityNotificationLogger,
  noopSecurityNotificationMailer,
  type SecurityNotificationLogger,
  type SecurityNotificationMailer,
} from './security-notification.service.js';
import { loginThrottleService } from './login-throttle.service.js';
import {
  AuthSecurityEventName,
  emitAuthSecurityEvent,
  noopSecurityEventLog,
  type AuthSecurityEventOptions,
} from './auth-security-events.js';
import { recoveryThrottleService } from './recovery-throttle.service.js';
import { refreshService, type RefreshResult } from './refresh.service.js';
import { sessionService } from './session.service.js';
import { createAccessToken } from './token.service.js';

/**
 * Input for the registration operation.
 * The service normalizes the email internally (trim + lowercase).
 */
export type RegisterInput = {
  email: string;
  password: string;
  displayName?: string;
};

/**
 * Registers a new user with the given email, password, and optional displayName.
 *
 * Steps:
 * 1. Normalize the email (trim whitespace, lowercase).
 * 2. Check for an existing user with the normalized email.
 * 3. If the email already exists, throw USERS_EMAIL_TAKEN.
 * 4. Hash the password using the password service.
 * 5. Create User, Credential, and the initial EmailVerificationToken inside
 *    one database transaction.
 * 6. Deliver the verification message after commit, then return the public
 *    User representation.
 *
 * Registration does NOT authenticate the user. No access token is issued.
 * The verification email is sent strictly after commit — the transaction is
 * never held open for network I/O. If delivery fails, the error propagates
 * while the account and its usable credential persist; resend recovers.
 */
export async function register(
  input: RegisterInput,
  mailer: EmailVerificationMailer = noopEmailVerificationMailer,
): Promise<PublicUser> {
  // Step 0: Enforce the canonical password policy FIRST (M5.5) — before
  // the email-existence check — so a policy rejection (400) cannot be
  // distinguished by account existence from the taken-email rejection
  // (409). The validator also guarantees no over-limit input reaches
  // bcrypt, where it would silently truncate.
  validatePasswordForSetting(input.password);

  // Step 1: Normalize the email
  const normalizedEmail = input.email.trim().toLowerCase();

  // Step 2: Check for existing user with normalized email
  const existingUser = await usersService.findByEmail(normalizedEmail);
  if (existingUser) {
    throw new AppError(ErrorCodes.USERS_EMAIL_TAKEN, 409, 'A user with this email already exists.');
  }

  // Step 3: Hash the password
  const passwordHash = await hashPassword(input.password);

  // Step 4: Generate IDs and the verification credential (before the
  // transaction — no external I/O inside)
  const userId = randomUUID();
  const credentialId = randomUUID();
  const verificationRaw = randomBytes(32).toString('base64url');
  const verificationExpiresAt = new Date(
    Date.now() + config.auth.emailVerificationTtlSeconds * 1000,
  );

  // Step 5: Create User, Credential, and verification token inside one transaction
  try {
    const created = await prisma.$transaction(async (tx) => {
      const user = await usersService.create(
        {
          id: userId,
          email: normalizedEmail,
          displayName: input.displayName ?? null,
          status: 'active',
        },
        tx,
      );

      await credentialRepository.create(
        {
          id: credentialId,
          userId: user.id,
          passwordHash,
        },
        tx,
      );

      await emailVerificationRepository.create(
        {
          id: randomUUID(),
          userId: user.id,
          tokenHash: hashVerificationToken(verificationRaw),
          expiresAt: verificationExpiresAt,
        },
        tx,
      );

      return user;
    });

    // Step 6: Deliver after commit, then return the public User representation
    await mailer.sendVerificationEmail({
      to: normalizedEmail,
      verificationUrl: buildVerificationUrl(verificationRaw),
    });
    return toPublicUser(created);
  } catch (error: unknown) {
    // Handle concurrent duplicate email: Prisma unique constraint violation on email
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'P2002' &&
      'meta' in error &&
      typeof error.meta === 'object' &&
      error.meta !== null &&
      'target' in error.meta &&
      Array.isArray(error.meta.target) &&
      error.meta.target.includes('email')
    ) {
      throw new AppError(ErrorCodes.USERS_EMAIL_TAKEN, 409, 'A user with this email already exists.');
    }

    // Re-throw unexpected errors without exposing internals
    throw error;
  }
}

/**
 * Cost-12 bcrypt hash of a fixed dummy secret, used only to equalize the
 * 401-path timing (M3.18 F-1). Unknown emails and missing credentials verify
 * against this so every evaluated login costs exactly one bcrypt, whether or
 * not an account exists — closing the ~250ms bcrypt-skipped oracle between
 * unknown-email and wrong-password failures. It can never authenticate: the
 * login result additionally requires a real user row and credential, so even
 * the dummy preimage yields 401 without an account.
 */
export const DUMMY_PASSWORD_HASH =
  '$2b$12$kYUTOi/zqF0FHiFZUC8GNenAyXPlQwAKE4XeZ.pNxO1A.HD.bnmVm';

/**
 * Input for the login operation.
 * The service normalizes the email internally (trim + lowercase).
 * `clientIp` is the canonical source address supplied by the route layer
 * (Fastify's socket-derived request IP, never a forwarded header) and feeds
 * the source dimension of login throttling. It is required so the route
 * cannot silently unwire the control by omitting it.
 */
export type LoginInput = {
  email: string;
  password: string;
  clientIp: string;
};

/**
 * Result returned by a successful login.
 * Contains the signed access token, the public User representation, and the
 * raw refresh credential for cookie delivery. The HTTP layer decides how to
 * deliver these to the client (cookies for browser clients, JSON body for
 * non-browser clients). The raw refresh token is memory-only: it must be
 * placed in the HttpOnly cookie and never serialized into a response body.
 */
export type LoginResult = {
  accessToken: string;
  user: PublicUser;
  refreshToken: string;
};

/**
 * Optional security-notification dependencies (M3.17).
 *
 * The mailer port defaults to the NoOp transport (same posture as the
 * M3.11/M3.12 mailer ports): transitions are attempted against it and
 * deliver nothing until a provider implements the interface. The logger
 * defaults to NoOp; routes pass `request.log` for operator observability.
 * Both are optional so existing callers keep working unchanged.
 */
export type SecurityNotificationOptions = {
  securityNotificationMailer?: SecurityNotificationMailer;
  securityNotificationLogger?: SecurityNotificationLogger;
};

/**
 * Authenticates a user with the given email and password.
 *
 * Steps:
 * 1. Normalize the email (trim whitespace, lowercase).
 * 2. Find the User by normalized email.
 * 3. Evaluate account lockout (M3.16). A live lock fails with 429 before
 *    throttle enforcement, backoff delay, credential lookup, or password
 *    verification — no bcrypt work, no state change, nothing recorded.
 *    An expired lock is recovered atomically; unknown emails have no lock
 *    state and proceed identically.
 * 4. Enforce login throttling for the (normalized email, source IP) pair.
 *    A throttled attempt fails with 429, revealing nothing about account
 *    existence. The check also returns the M3.15 progressive backoff delay
 *    (bounded exponential, derived from pre-lookup account failure state),
 *    which is applied asynchronously before any authentication work.
 * 5. Find the Credential by User ID.
 * 6. Verify the plaintext password against the stored hash — always exactly
 *    one bcrypt-12, using the dummy hash when no credential exists so the
 *    401 timing reveals nothing about account existence (M3.18 F-1).
 * 7. If any lookup or verification fails — or the account is not `active`
 *    (suspended/inactive accounts authenticate identically to wrong
 *    passwords, M3.19 FIND-05) — record the failure against both
 *    throttle dimensions and throw AUTH_INVALID_CREDENTIALS. For a known
 *    account the increment and the lockout transition commit atomically;
 *    reaching the lockout threshold locks the account for the fixed,
 *    non-extending duration. When THIS failure performed the transition,
 *    one post-commit account-locked notice is attempted best-effort
 *    (M3.17): delivery failure is logged safely and the 401 stands.
 * 8. On success, revalidate the account is still unlocked (a lock committed
 *    during password verification blocks issuance), reset account-scoped
 *    throttle and expired-lock state, sign a JWT access token, and persist
 *    a Session with its initial RefreshToken instance in one service-owned
 *    transaction via the refresh service.
 * 9. Return the access token, the public User representation, and the raw
 *    refresh credential for cookie delivery.
 *
 * The error is identical for unknown email, missing credential,
 * wrong password — and, by deliberate reuse of the 429 contract, for
 * locked and throttled accounts: no user-enumeration behavior. The
 * M3.17 notification never changes the response: same status, code, body,
 * and headers whether delivery succeeds or fails.
 *
 * Throttle/lock-store failures propagate (fail closed): login never
 * bypasses the controls and never masks an outage as an authentication
 * outcome.
 *
 * If session persistence fails, the whole login fails: no partial
 * authentication state remains and no credential is delivered.
 */
export async function login(
  app: FastifyInstance,
  input: LoginInput,
  options?: SecurityNotificationOptions & AuthSecurityEventOptions,
): Promise<LoginResult> {
  const eventLog = options?.securityEventLogger ?? noopSecurityEventLog;
  // Step 1: Normalize the email
  const normalizedEmail = input.email.trim().toLowerCase();
  const throttleIdentity = { normalizedEmail, clientIp: input.clientIp };

  // Step 2: Find User by normalized email. The lookup itself reveals
  // nothing: found and missing accounts follow the same code path below,
  // and every rejection uses an existence-independent response.
  const user = await usersService.findByEmail(normalizedEmail);

  // Step 3: Evaluate account lockout before any other authentication work.
  if (user) {
    try {
      await loginThrottleService.checkAccountLockout(user.id, user.lockedUntil);
    } catch (error) {
      // Observational only: the rejection below is unchanged.
      emitAuthSecurityEvent(eventLog, {
        event: AuthSecurityEventName.ACCOUNT_LOCKED,
        outcome: 'locked',
        subjectId: user.id,
      });
      throw error;
    }
  }

  // Step 4: Enforce login throttling and compute progressive delay before
  // any authentication work. The delay is derived from pre-user-lookup
  // throttle state, so it is enumeration-resistant.
  let delayMs = 0;
  try {
    ({ delayMs } = await loginThrottleService.checkLoginAllowed(throttleIdentity));
  } catch (error) {
    // Observational only: throttled attempts are rejected identically.
    // The subject is attached only when the account is already known —
    // unknown addresses stay identifier-free (no oracle, no PII).
    emitAuthSecurityEvent(eventLog, {
      event: AuthSecurityEventName.LOGIN_FAILURE,
      outcome: 'failure',
      reason: 'throttled',
      ...(user === null || user === undefined ? {} : { subjectId: user.id }),
    });
    throw error;
  }
  if (delayMs > 0) {
    await loginThrottleService.delay(delayMs);
  }

  // Step 5: Find Credential by User ID
  let passwordHash: string | null = null;
  if (user) {
    const credential = await credentialRepository.findByUserId(user.id);
    if (credential) {
      passwordHash = credential.passwordHash;
    }
  }

  // Step 6: Verify password
  // Every evaluated outcome costs exactly one bcrypt-12: unknown emails and
  // missing credentials verify against the dummy hash so the 401 timing
  // cannot distinguish them from wrong passwords (M3.18 F-1). A true compare
  // alone never suffices — a real user row and credential are also required.
  const passwordMatches = await verifyPassword(
    input.password,
    passwordHash ?? DUMMY_PASSWORD_HASH,
  );
  // Non-active accounts authenticate identically to wrong passwords (M3.19
  // FIND-05): suspension must disable login like every other auth path, and
  // placing the gate after bcrypt keeps the 401 timing and failure recording
  // uniform, so status never becomes an oracle.
  const isValid = passwordMatches && passwordHash !== null && user?.status === 'active';

  if (!isValid || !user) {
    // Step 7: Record the failure identically for unknown emails and wrong
    // passwords, then report the generic credential failure. A store failure
    // propagates here (fail closed) with no notification attempted.
    const recordResult = await loginThrottleService.recordLoginFailure(
      throttleIdentity,
      user?.id ?? null,
    );
    // Optional chaining keeps backward compatibility with callers/tests that
    // stub recordLoginFailure with undefined; the real implementation always
    // returns a result object.
    if (recordResult?.transitionedToLocked === true && user) {
      // M8.3: the lock transition is a security event in its own right,
      // recorded alongside (not instead of) the M3.17 mailer notice.
      emitAuthSecurityEvent(eventLog, {
        event: AuthSecurityEventName.ACCOUNT_LOCKED,
        outcome: 'locked',
        subjectId: user.id,
      });
      // M3.17: exactly one post-commit notice per lock. The transition
      // already committed above; delivery is best-effort and never alters
      // the 401 below. The recipient is the canonical User email, and the
      // content carries no secret or internal state.
      const mailer = options?.securityNotificationMailer ?? noopSecurityNotificationMailer;
      const logger = options?.securityNotificationLogger ?? noopSecurityNotificationLogger;
      try {
        await mailer.sendAccountLocked(buildAccountLockedEmail(user.email));
      } catch (error: unknown) {
        logNotificationFailure(logger, { type: 'ACCOUNT_LOCKED', userId: user.id, error });
      }
    }
    // Observational only: generic credential failure, unchanged below.
    emitAuthSecurityEvent(eventLog, {
      event: AuthSecurityEventName.LOGIN_FAILURE,
      outcome: 'failure',
      reason: 'invalid_credentials',
      ...(user === null || user === undefined ? {} : { subjectId: user.id }),
    });
    throw new AppError(
      ErrorCodes.AUTH_INVALID_CREDENTIALS,
      401,
      'The email or password is incorrect.',
    );
  }

  // Step 8a: Revalidate the account is still unlocked before issuing
  // anything: a lock committed by concurrent failures during password
  // verification must block issuance (fail closed). This also recovers an
  // expired lock that outlived the early gate.
  try {
    await loginThrottleService.revalidateUnlockedForIssuance(user.id);
  } catch (error) {
    // Observational only: concurrent-crossing lock, same event as Step 3.
    emitAuthSecurityEvent(eventLog, {
      event: AuthSecurityEventName.ACCOUNT_LOCKED,
      outcome: 'locked',
      subjectId: user.id,
    });
    throw error;
  }

  // Step 8b: A successful authentication resets account-scoped failure
  // state so a legitimate user recovers immediately. Source-scoped state
  // is left to expire naturally. Clearing first means a later issuance
  // failure still leaves the account unthrottled for a clean retry.
  await loginThrottleService.clearAccountThrottle(normalizedEmail);

  // Step 8c: Sign access token
  const accessToken = createAccessToken(app, { sub: user.id });

  // Step 8d: Persist the refresh session (single service-owned transaction).
  // On failure this throws: login fails with no partial state and no
  // credential delivered.
  const issuedRefresh = await refreshService.issueRefreshSession(user.id);

  // Observational only: successful authentication. Emitted after the
  // session commits, so the event never precedes the state it reports.
  emitAuthSecurityEvent(eventLog, {
    event: AuthSecurityEventName.LOGIN_SUCCESS,
    outcome: 'success',
    subjectId: user.id,
  });

  // Step 9: Return result
  return {
    accessToken,
    user: toPublicUser(user),
    refreshToken: issuedRefresh.refreshToken,
  };
}

/**
 * Returns the current persisted user for an authenticated subject.
 *
 * The JWT subject identifies the user; PostgreSQL remains authoritative for
 * current user state (role/status/profile changes and account deletion are
 * reflected here, never in token claims). A valid token whose subject no
 * longer exists is treated as failed authentication — never a fabricated
 * user, a refresh, or a revocation (stateless milestone: no revocation
 * infrastructure exists).
 */
export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await usersService.findById(userId);

  if (!user) {
    throw new AppError(
      ErrorCodes.AUTH_INVALID_TOKEN,
      401,
      'Authenticated user does not exist.',
    );
  }

  return toPublicUser(user);
}

/**
 * Validates a presented raw refresh credential, atomically rotates it, and
 * issues a new access JWT plus the raw successor credential.
 *
 * Delegates to the refresh service, which owns the refresh-token lifecycle.
 * A consumed credential presented again is replay: the family is invalidated
 * and the request fails closed (ADR-008).
 */
export async function refreshAccessToken(
  app: FastifyInstance,
  rawRefreshToken: unknown,
  options?: AuthSecurityEventOptions,
): Promise<RefreshResult> {
  return refreshService.refreshAccessToken(app, rawRefreshToken, options);
}

/**
 * Ends the session identified by a presented raw refresh credential.
 *
 * Delegates to the session service: any credential state (live, consumed,
 * expired, revoked) resolves to the same outcome — family revoked or nothing
 * to revoke — with no existence oracle. Returns true when a family was
 * revoked by this call. Unknown or absent credentials report false.
 * Unexpected database errors propagate: the route must not report logout
 * success when persistence failed.
 */
export async function logout(rawRefreshToken: unknown): Promise<{ revoked: boolean }> {
  return { revoked: await refreshService.revokeSessionForRefreshToken(rawRefreshToken) };
}

/**
 * Revokes every live session owned by the authenticated user.
 *
 * Thin delegate over the session domain primitive: one set-based conditional
 * update, idempotent, zero-session safe. Returns the transitioned count for
 * future callers; the public route deliberately never exposes it.
 * Unexpected database errors propagate: callers must not report success
 * when persistence failed.
 */
export async function revokeAllSessions(userId: string): Promise<{ revoked: number }> {
  return { revoked: await sessionService.revokeAllSessionsForUser(userId) };
}

/**
 * Starts password recovery for an email address without revealing anything.
 *
 * The email is normalized exactly like registration/login. Frequency is
 * bounded BEFORE the user lookup (M5.4): the recovery throttle consumes
 * the attempted address and source buckets identically for unknown and
 * known addresses, so over-limit behavior (429) reveals nothing about
 * account existence. Unknown, missing, or non-active accounts resolve to
 * the same silent success as a real issuance: no token is created, no
 * email is addressed, and the caller cannot distinguish the cases. Only
 * `active` users receive credentials, so recovery can never reactivate a
 * suspended account.
 *
 * `clientIp` is the canonical source address supplied by the route layer
 * (Fastify's socket-derived request IP, never a forwarded header) and is
 * required so the route cannot silently unwire the control.
 */
export async function requestPasswordReset(
  email: string,
  clientIp: string,
  mailer?: PasswordResetMailer,
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();

  await recoveryThrottleService.checkAndRecordRecoveryAttempt({
    scope: 'password-reset',
    normalizedEmail,
    clientIp,
  });

  const user = await usersService.findByEmail(normalizedEmail);
  if (!user || user.status !== 'active') {
    return;
  }

  await passwordResetService.issueToken(user.id, normalizedEmail, mailer);
}

/**
 * Completes password recovery from a reset credential.
 *
 * The token's database row is authoritative for the target user: no
 * request-supplied identity is accepted or needed. The user must still be
 * `active`; the password is hashed before the transaction opens; the
 * transaction then atomically consumes the credential, updates the password
 * hash, and revokes all sessions. Every credential failure — malformed,
 * unknown, expired, consumed, orphaned, or inactive user — produces the same
 * generic authentication failure.
 *
 * A successful reset also clears the M3.16 account lockout marker and the
 * M3.14 account throttle row: the reset proves control of the recovery
 * channel, making it the authenticated recovery path for a locked-out
 * victim (there is deliberately no unlock endpoint). Source-scoped throttle
 * state is left to expire per M3.14. These clears run after the reset
 * transaction commits; a concurrent failure racing in afterwards starts
 * from a clean baseline with no lock.
 *
 * M3.17: after the clears, one post-commit password-change notice is
 * attempted best-effort to the canonical User email. Delivery failure is
 * logged safely and the 204-equivalent success (void return) stands — a
 * committed password change is never rolled back for email.
 */
export async function resetPassword(
  rawResetToken: unknown,
  password: string,
  options?: SecurityNotificationOptions & AuthSecurityEventOptions,
): Promise<void> {
  const eventLog = options?.securityEventLogger ?? noopSecurityEventLog;
  const userId = await passwordResetService.findActiveToken(rawResetToken);
  if (!userId) {
    emitAuthSecurityEvent(eventLog, {
      event: AuthSecurityEventName.PASSWORD_RESET_COMPLETED,
      outcome: 'failure',
      reason: 'invalid_token',
    });
    throw new AppError(
      ErrorCodes.AUTH_INVALID_TOKEN,
      401,
      'The reset token is invalid or has expired.',
    );
  }

  const user = await usersService.findById(userId);
  if (!user || user.status !== 'active') {
    emitAuthSecurityEvent(eventLog, {
      event: AuthSecurityEventName.PASSWORD_RESET_COMPLETED,
      outcome: 'failure',
      reason: 'invalid_token',
    });
    throw new AppError(
      ErrorCodes.AUTH_INVALID_TOKEN,
      401,
      'The reset token is invalid or has expired.',
    );
  }

  // Canonical password policy (M5.5): enforced after the token/user gates
  // (their precedence is unchanged) and before hashing, so no over-limit
  // input reaches bcrypt. Same validator as registration — one policy.
  validatePasswordForSetting(password);

  const passwordHash = await hashPassword(password);
  // Safe structural narrowing: findActiveToken returns non-null only for
  // non-empty string inputs, so rawResetToken is a string here.
  await passwordResetService.completeReset(
    rawResetToken as string,
    user.id,
    passwordHash,
  );

  // Authenticated recovery: the presenter proved control of the recovery
  // channel, so the account leaves lockout and account-throttle state
  // behind. Invalid or expired tokens never reach here and change nothing.
  await usersService.update(user.id, { lockedUntil: null });
  await loginThrottleService.clearAccountThrottle(user.email);

  // M3.17: post-commit notice. The password change, session revocation, and
  // recovery clears above already committed; this send is outside every
  // transaction and its failure cannot roll anything back.
  const mailer = options?.securityNotificationMailer ?? noopSecurityNotificationMailer;
  const logger = options?.securityNotificationLogger ?? noopSecurityNotificationLogger;
  try {
    await mailer.sendPasswordResetSucceeded(buildPasswordResetSucceededEmail(user.email));
  } catch (error: unknown) {
    logNotificationFailure(logger, { type: 'PASSWORD_RESET_SUCCEEDED', userId: user.id, error });
  }

  // Observational only: the committed password change above stands
  // regardless of the best-effort notice.
  emitAuthSecurityEvent(eventLog, {
    event: AuthSecurityEventName.PASSWORD_RESET_COMPLETED,
    outcome: 'success',
    subjectId: user.id,
  });
}

/**
 * Sends (or re-sends) a verification message without revealing anything.
 *
 * The email is normalized exactly like registration/login. Frequency is
 * bounded BEFORE the user lookup (M5.4): same enumeration-safe discipline
 * as password-reset request — over-limit behavior (429) is identical for
 * unknown, non-active, and already-verified addresses. Unknown, missing,
 * non-active, or already-verified accounts resolve to the same silent
 * success as a real issuance: no token is created, no email is addressed,
 * and the caller cannot distinguish the cases. Newest-only issuance keeps at
 * most one usable credential per user.
 *
 * `clientIp` is required (same contract as `requestPasswordReset`).
 */
export async function resendVerificationEmail(
  email: string,
  clientIp: string,
  mailer?: EmailVerificationMailer,
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();

  await recoveryThrottleService.checkAndRecordRecoveryAttempt({
    scope: 'email-verification',
    normalizedEmail,
    clientIp,
  });

  const user = await usersService.findByEmail(normalizedEmail);
  if (!user || user.status !== 'active' || user.emailVerifiedAt !== null) {
    return;
  }

  await emailVerificationService.issueToken(user.id, normalizedEmail, mailer);
}

function invalidVerificationToken(): AppError {
  return new AppError(
    ErrorCodes.AUTH_INVALID_TOKEN,
    401,
    'The verification token is invalid or has expired.',
  );
}

/**
 * Completes email verification from a verification credential.
 *
 * The token's database row is authoritative for the target user: no
 * request-supplied identity is accepted or needed. The user must still be
 * `active`. The transaction atomically consumes the credential and stamps
 * `emailVerifiedAt` (only when unset, preserving the original verification
 * time); an already-verified account still consumes the presented credential
 * and succeeds idempotently. Verification creates no session, issues no JWT,
 * and revokes nothing. Every credential failure produces the same generic
 * authentication failure.
 */
export async function confirmEmailVerification(
  rawToken: unknown,
  options?: AuthSecurityEventOptions,
): Promise<void> {
  const eventLog = options?.securityEventLogger ?? noopSecurityEventLog;
  const active = await emailVerificationService.findActiveToken(rawToken);
  if (!active) {
    emitAuthSecurityEvent(eventLog, {
      event: AuthSecurityEventName.EMAIL_VERIFICATION_COMPLETED,
      outcome: 'failure',
      reason: 'invalid_token',
    });
    throw invalidVerificationToken();
  }

  const user = await usersService.findById(active.userId);
  if (!user || user.status !== 'active') {
    emitAuthSecurityEvent(eventLog, {
      event: AuthSecurityEventName.EMAIL_VERIFICATION_COMPLETED,
      outcome: 'failure',
      reason: 'invalid_token',
    });
    throw invalidVerificationToken();
  }

  // Safe structural narrowing: findActiveToken returns non-null only for
  // non-empty string inputs, so rawToken is a string here.
  const tokenHash = hashVerificationToken(rawToken as string);
  try {
    await prisma.$transaction(async (tx) => {
      const row = await emailVerificationRepository.findByTokenHash(tokenHash, tx);
      if (
        !row ||
        row.userId !== user.id ||
        row.consumedAt !== null ||
        row.expiresAt.getTime() <= Date.now()
      ) {
        throw invalidVerificationToken();
      }

      const consumed = await emailVerificationRepository.consumeIfActive(row.id, tx);
      if (!consumed) {
        throw invalidVerificationToken();
      }

      if (!user.emailVerifiedAt) {
        const updated = await usersService.update(user.id, { emailVerifiedAt: new Date() }, tx);
        if (!updated) {
          throw invalidVerificationToken();
        }
      }
    });
  } catch (error) {
    // Observational only: consumed/expired/raced credentials fail
    // identically; unexpected database errors propagate untouched.
    if (error instanceof AppError) {
      emitAuthSecurityEvent(eventLog, {
        event: AuthSecurityEventName.EMAIL_VERIFICATION_COMPLETED,
        outcome: 'failure',
        reason: 'invalid_token',
      });
    }
    throw error;
  }

  // Observational only: verification commits before this line runs.
  emitAuthSecurityEvent(eventLog, {
    event: AuthSecurityEventName.EMAIL_VERIFICATION_COMPLETED,
    outcome: 'success',
    subjectId: user.id,
  });
}

export const authService = {
  register,
  login,
  getCurrentUser,
  refreshAccessToken,
  logout,
  requestPasswordReset,
  resetPassword,
  resendVerificationEmail,
  confirmEmailVerification,
  revokeAllSessions,
};
