import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { prisma } from '../../../platform/database/prisma.js';
import { config } from '../../../config/index.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';
import { credentialRepository } from '../repositories/credential.repository.js';
import { passwordResetRepository } from '../repositories/password-reset.repository.js';
import { sessionService } from './session.service.js';

/**
 * Password-reset lifecycle service.
 *
 * Recovery credentials are opaque 256-bit tokens: 32 cryptographically
 * random bytes, base64url-encoded. Only the SHA-256 hex digest is persisted;
 * the raw credential exists in memory only, from generation until email
 * delivery (issuance) or hashing for lookup (completion).
 *
 * Token state machine: ACTIVE (consumedAt null, unexpired) --atomic
 * consume--> CONSUMED. There is no rotation, no family, and no replay
 * response: a consumed credential presented again is simply invalid.
 *
 * DEPENDENCY DIRECTION (load-bearing): this module must never import
 * `users.service` — `users.service.remove` calls `removeByUserId` here for
 * ordered user-deletion cleanup, so that import would close an
 * Auth <-> Users cycle (ARCH-ENF-007). User lookups and status gates live in
 * `auth.service`, which already owns the Users boundary.
 */

/**
 * Computes the persisted representation of a raw reset credential.
 * Deterministic SHA-256 hex digest — required for indexed hash lookup.
 * Implemented locally (not shared with refresh tokens) so the two
 * credential domains stay decoupled.
 */
export function hashResetToken(rawResetToken: string): string {
  return createHash('sha256').update(rawResetToken, 'utf8').digest('hex');
}

/**
 * Delivery address + link for a recovery message. The URL carries the raw
 * bearer credential; it must never be logged, persisted, or echoed.
 */
export type PasswordResetEmail = {
  to: string;
  resetUrl: string;
};

/**
 * Minimal delivery port for recovery messages.
 *
 * There is no production email provider in this milestone (email delivery
 * infrastructure is a future milestone): the default transport delivers
 * nothing. Tests inject a capturing fake. A future provider implements this
 * interface without touching the reset domain.
 */
export type PasswordResetMailer = {
  sendPasswordResetEmail(email: PasswordResetEmail): Promise<void>;
};

export const noopPasswordResetMailer: PasswordResetMailer = {
  sendPasswordResetEmail(): Promise<void> {
    return Promise.resolve();
  },
};

/**
 * Builds the recovery link from the configured application base URL.
 * The base URL comes from validated centralized config — never from the
 * request Host/Origin/Referer, which are attacker-controlled.
 */
export function buildResetUrl(rawResetToken: string): string {
  return `${config.appBaseUrl}/reset-password?token=${rawResetToken}`;
}

/**
 * Issues a recovery credential for an already-resolved user.
 *
 * Newest-only policy: any still-active previous credential is superseded in
 * the same transaction that creates the new one, so at most one usable token
 * exists per user. The email is delivered AFTER commit — the transaction is
 * never held open for network I/O. If delivery fails, the error propagates
 * (sanitized 5xx) while the persisted token stays usable for a retry.
 */
export async function issueToken(
  userId: string,
  email: string,
  mailer: PasswordResetMailer = noopPasswordResetMailer,
): Promise<void> {
  const rawResetToken = randomBytes(32).toString('base64url');
  const tokenHash = hashResetToken(rawResetToken);
  const expiresAt = new Date(Date.now() + config.auth.passwordResetTtlSeconds * 1000);

  await prisma.$transaction(async (tx) => {
    await passwordResetRepository.invalidateActiveForUser(userId, tx);
    await passwordResetRepository.create(
      {
        id: randomUUID(),
        userId,
        tokenHash,
        expiresAt,
      },
      tx,
    );
  });

  await mailer.sendPasswordResetEmail({ to: email, resetUrl: buildResetUrl(rawResetToken) });
}

/**
 * Single generic failure for every reset-credential problem (malformed,
 * unknown, expired, consumed, orphaned user, inactive user). One code and
 * one message for all causes: distinguishing them would leak whether a
 * presented credential exists in the database.
 */
function invalidResetToken(): AppError {
  return new AppError(
    ErrorCodes.AUTH_INVALID_TOKEN,
    401,
    'The reset token is invalid or has expired.',
  );
}

/**
 * Resolves a presented raw credential to its owning user ID, or null when
 * the credential cannot complete a reset (unknown, consumed, or expired).
 * Read-only lookup for the pre-transaction gate in `auth.service`.
 */
export async function findActiveToken(rawResetToken: unknown): Promise<string | null> {
  if (typeof rawResetToken !== 'string' || rawResetToken.length === 0) {
    return null;
  }

  const row = await passwordResetRepository.findByTokenHash(hashResetToken(rawResetToken));
  if (!row || row.consumedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return row.userId;
}

/**
 * Completes a password reset as ONE atomic security transition:
 * consume the credential AND update the password hash AND revoke all
 * sessions. Any failure rolls everything back — there is no state where the
 * token is consumed but the password unchanged, the password changed but
 * sessions survive, or a partial row remains.
 *
 * The caller (`auth.service`) has already validated the token and the user;
 * this function re-validates inside the transaction so a concurrent
 * completion or expiry cannot slip through. Exactly one concurrent caller
 * can win the conditional consume; losers fail safely.
 */
export async function completeReset(
  rawResetToken: string,
  userId: string,
  passwordHash: string,
): Promise<void> {
  const tokenHash = hashResetToken(rawResetToken);

  await prisma.$transaction(async (tx) => {
    const row = await passwordResetRepository.findByTokenHash(tokenHash, tx);
    if (
      !row ||
      row.userId !== userId ||
      row.consumedAt !== null ||
      row.expiresAt.getTime() <= Date.now()
    ) {
      throw invalidResetToken();
    }

    const consumed = await passwordResetRepository.consumeIfActive(row.id, tx);
    if (!consumed) {
      throw invalidResetToken();
    }

    const updated = await credentialRepository.updatePasswordHash(userId, passwordHash, tx);
    if (!updated) {
      throw invalidResetToken();
    }

    await sessionService.revokeAllSessionsForUser(userId, tx);
  });
}

/**
 * Deletes every PasswordResetToken owned by a user.
 * Used by user deletion to satisfy ON DELETE RESTRICT ordering.
 */
export async function removeByUserId(userId: string, tx?: Prisma.TransactionClient): Promise<number> {
  return passwordResetRepository.removeByUserId(userId, tx);
}

export const passwordResetService = {
  hashResetToken,
  buildResetUrl,
  issueToken,
  findActiveToken,
  completeReset,
  removeByUserId,
  noopPasswordResetMailer,
};
