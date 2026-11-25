import { createHash, randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { prisma } from '../../../platform/database/prisma.js';
import { config } from '../../../config/index.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';
import { usersService } from '../../users/users.service.js';
import {
  AuthSecurityEventName,
  emitAuthSecurityEvent,
  noopSecurityEventLog,
  type AuthSecurityEventOptions,
} from './auth-security-events.js';
import { refreshTokenRepository } from '../repositories/refresh-token.repository.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { createAccessToken } from './token.service.js';

/**
 * Refresh-token lifecycle service (M3.6 rotation).
 *
 * Refresh tokens are opaque 256-bit credentials: 32 cryptographically random
 * bytes, base64url-encoded for transport. Only the SHA-256 hex digest is
 * persisted; the raw credential exists in memory only, from generation until
 * cookie delivery (issuance/rotation) or hashing for lookup (refresh).
 *
 * Token state machine: ACTIVE (consumedAt and revokedAt null, unexpired,
 * family live) --atomic consume--> CONSUMED (+ successor linked). A consumed
 * credential presented again is replay: the family is invalidated. A revoked
 * instance or family fails refresh without further action. General logout
 * and revoke-all revocation live in the session service (M3.7).
 */

/**
 * Computes the persisted representation of a raw refresh credential.
 * Deterministic SHA-256 hex digest — the same raw token always yields the
 * same hash, which is what makes indexed lookup possible. The lookup itself
 * (unique-index equality) is the comparison; no application-side secret
 * comparison is required.
 */
export function hashRefreshToken(rawRefreshToken: string): string {
  return createHash('sha256').update(rawRefreshToken, 'utf8').digest('hex');
}

/**
 * Result of issuing a refresh session. The raw token is memory-only: the
 * caller delivers it to the client (HttpOnly cookie) and must never persist,
 * log, or return it in a response body.
 */
export type IssuedRefreshSession = {
  refreshToken: string;
  sessionId: string;
  expiresAt: Date;
};

/**
 * Creates a Session and its initial RefreshToken instance in one
 * service-owned transaction. Generation and hashing happen before the
 * transaction opens (no external I/O inside); the caller sets the cookie
 * only after this function resolves, so a rolled-back transaction can never
 * leave a client holding an unrecorded credential.
 */
export async function issueRefreshSession(userId: string): Promise<IssuedRefreshSession> {
  const rawRefreshToken = randomBytes(32).toString('base64url');
  const tokenHash = hashRefreshToken(rawRefreshToken);
  const expiresAt = new Date(Date.now() + config.auth.refreshTokenTtlSeconds * 1000);

  const session = await prisma.$transaction(async (tx) => {
    const createdSession = await sessionRepository.create(
      {
        id: randomUUID(),
        userId,
        expiresAt,
      },
      tx,
    );

    await refreshTokenRepository.create(
      {
        id: randomUUID(),
        sessionId: createdSession.id,
        tokenHash,
        expiresAt,
      },
      tx,
    );

    return createdSession;
  });

  return {
    refreshToken: rawRefreshToken,
    sessionId: session.id,
    expiresAt,
  };
}

/**
 * Revokes a single refresh-token instance without touching its family.
 *
 * Domain primitive for future callers (session management, security flows).
 * Idempotent: already-revoked instances and unknown IDs report false without
 * error; unexpected database errors propagate. The refresh validity chain
 * treats a revoked instance as invalid for normal refresh.
 */
export async function revokeRefreshToken(tokenId: string): Promise<boolean> {
  return refreshTokenRepository.revokeOne(tokenId);
}

/**
 * Single generic failure for every refresh-credential problem (missing,
 * malformed, unknown, expired, revoked, orphaned session, inactive or
 * deleted user). One code and one message for all causes: distinguishing
 * them would leak whether a presented credential exists in the database.
 */
function invalidRefreshCredential(): AppError {
  return new AppError(
    ErrorCodes.AUTH_INVALID_TOKEN,
    401,
    'The refresh credential is invalid or has expired.',
  );
}

/**
 * Result of a successful rotation: a new access token plus the raw successor
 * refresh credential and its server-side expiry. The raw successor is
 * memory-only: the caller delivers it in the replacement cookie after the
 * rotation transaction commits, and must never persist, log, or return it
 * in a response body.
 */
export type RefreshResult = {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
};

/**
 * Validates a presented raw refresh credential, atomically rotates it, and
 * issues a new access JWT.
 *
 * Steps:
 * 1. Narrow the input (unknown at the boundary — never trust the caller).
 * 2. Hash and look the instance up by its unique indexed hash (fail fast for
 *    unknown credentials without opening a transaction).
 * 3. Reject expired instances, revoked instances, dead families, and
 *    inactive users pre-tx — none of these can ever be replay, and none
 *    opens a transaction.
 * 4. In one service-owned transaction: re-validate liveness, atomically
 *    consume the instance (conditional predicate — exactly one concurrent
 *    winner), create the successor in the same family with the session's
 *    absolute expiry, and link the lineage. A lost race classifies as replay
 *    (family invalidation, committed in the same transaction) or as invalid
 *    when the instance was never consumed.
 * 5. Re-validate session liveness and user status in-tx to narrow the
 *    deactivation race, then sign the access token AFTER commit from the
 *    captured identity.
 *
 * Rollback restores ACTIVE: any failure before commit leaves the presented
 * credential usable, so a client can safely retry. Unexpected database errors
 * propagate so the global handler returns the sanitized 5xx contract instead
 * of masquerading an outage as an authentication failure.
 */
export async function refreshAccessToken(
  app: FastifyInstance,
  rawRefreshToken: unknown,
  options?: AuthSecurityEventOptions,
): Promise<RefreshResult> {
  const eventLog = options?.securityEventLogger ?? noopSecurityEventLog;
  if (typeof rawRefreshToken !== 'string' || rawRefreshToken.length === 0) {
    throw invalidRefreshCredential();
  }

  const tokenHash = hashRefreshToken(rawRefreshToken);
  const instance = await refreshTokenRepository.findByTokenHash(tokenHash);
  if (!instance) {
    throw invalidRefreshCredential();
  }

  // Expired, revoked, or family-dead presentations change nothing and are
  // never replay: replay is defined as a previously CONSUMED credential
  // presented again.
  if (instance.expiresAt.getTime() <= Date.now() || instance.revokedAt !== null) {
    throw invalidRefreshCredential();
  }
  const session = await sessionRepository.findById(instance.sessionId);
  if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
    throw invalidRefreshCredential();
  }

  // Fail fast for doomed requests without opening a transaction. The
  // transaction below re-reads user state to narrow the deactivation race.
  const preUser = await usersService.findById(session.userId);
  if (!preUser || preUser.status !== 'active') {
    throw invalidRefreshCredential();
  }

  const successorRaw = randomBytes(32).toString('base64url');
  const successorHash = hashRefreshToken(successorRaw);

  const rotated = await prisma.$transaction(async (tx) => {
    // Re-validate liveness inside the transaction first, so that every
    // invalid path below commits a no-op: a credential is only ever consumed
    // on the success path, and rollback-or-noop preserves ACTIVE otherwise.
    const liveSession = await sessionRepository.findById(instance.sessionId, tx);
    if (!liveSession || liveSession.revokedAt !== null) {
      return { kind: 'invalid' as const };
    }
    const user = await usersService.findById(liveSession.userId);
    if (!user || user.status !== 'active') {
      return { kind: 'invalid' as const };
    }

    const won = await refreshTokenRepository.consumeIfActive(instance.id, tx);
    if (!won) {
      const current = await refreshTokenRepository.findById(instance.id, tx);
      if (current && current.consumedAt !== null) {
        // Replay: a consumed credential presented again. Invalidate the whole
        // family in this same transaction (ADR-008), then fail closed.
        await sessionRepository.revokeFamily(instance.sessionId, tx);
        return { kind: 'replay' as const, userId: liveSession.userId };
      }
      // Lost without consumption (raced expiry, raced revocation, vanished
      // row): invalid, and committing here writes nothing. Revocation is not
      // consumption, so it never triggers the replay path.
      return { kind: 'invalid' as const };
    }

    // Winner: rotate within the same transaction. The successor inherits the
    // session's absolute expiry: rotation must never extend the credential
    // lifetime into a sliding session.
    const successor = await refreshTokenRepository.create(
      {
        id: randomUUID(),
        sessionId: liveSession.id,
        tokenHash: successorHash,
        expiresAt: liveSession.expiresAt,
      },
      tx,
    );
    await refreshTokenRepository.markSuperseded(instance.id, successor.id, tx);

    return { kind: 'rotated' as const, userId: user.id, expiresAt: liveSession.expiresAt };
  });

  if (rotated.kind === 'replay') {
    // Observational only: replay invalidates the family above and fails
    // closed below. Only replay is event-worthy — expired, revoked, and
    // unknown presentations are routine client state, not attack signal.
    emitAuthSecurityEvent(eventLog, {
      event: AuthSecurityEventName.REFRESH_REPLAY,
      outcome: 'replay_detected',
      subjectId: rotated.userId,
    });
  }
  if (rotated.kind !== 'rotated') {
    throw invalidRefreshCredential();
  }

  const accessToken = createAccessToken(app, { sub: rotated.userId });

  return {
    accessToken,
    refreshToken: successorRaw,
    refreshExpiresAt: rotated.expiresAt,
  };
}

/**
 * Revokes the family identified by a presented raw refresh credential.
 *
 * Used by logout: the credential may be live, consumed, expired, or already
 * revoked — every case resolves to the same outcome (family revoked or
 * nothing to revoke) with no existence oracle. Returns true when a family
 * was revoked by this call. Unknown credentials report false. Unexpected
 * database errors propagate so the caller never reports success it did not
 * achieve.
 */
export async function revokeSessionForRefreshToken(rawRefreshToken: unknown): Promise<boolean> {
  if (typeof rawRefreshToken !== 'string' || rawRefreshToken.length === 0) {
    return false;
  }

  const instance = await refreshTokenRepository.findByTokenHash(hashRefreshToken(rawRefreshToken));
  if (!instance) {
    return false;
  }

  return sessionRepository.revokeFamily(instance.sessionId);
}

export const refreshService = {
  hashRefreshToken,
  issueRefreshSession,
  refreshAccessToken,
  revokeRefreshToken,
  revokeSessionForRefreshToken,
};
