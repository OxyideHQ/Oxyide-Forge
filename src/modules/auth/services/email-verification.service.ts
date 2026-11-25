import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { prisma } from '../../../platform/database/prisma.js';
import { config } from '../../../config/index.js';
import { emailVerificationRepository } from '../repositories/email-verification.repository.js';

/**
 * Email-verification lifecycle service.
 *
 * Verification credentials are opaque 256-bit tokens: 32 cryptographically
 * random bytes, base64url-encoded. Only the SHA-256 hex digest is persisted;
 * the raw credential exists in memory only, from generation until email
 * delivery (issuance) or hashing for lookup (confirmation).
 *
 * Token state machine: ACTIVE (consumedAt null, unexpired) --atomic
 * consume--> CONSUMED. There is no rotation, no family, and no replay
 * response: a consumed credential presented again is simply invalid.
 *
 * Verification proves control of an email address. It creates no session,
 * issues no JWT, revokes nothing, and changes no password. In particular,
 * confirming verification never touches Session/RefreshToken rows.
 *
 * DEPENDENCY DIRECTION (load-bearing): this module must never import
 * `users.service` — `users.service.remove` calls `removeByUserId` here for
 * ordered user-deletion cleanup, so that import would close an
 * Auth <-> Users cycle (ARCH-ENF-007). User lookups, status gates, and the
 * confirmation transaction live in `auth.service`, which already owns the
 * Users boundary.
 */

/**
 * Computes the persisted representation of a raw verification credential.
 * Deterministic SHA-256 hex digest — required for indexed hash lookup.
 * Implemented locally (not shared across credential domains) so the
 * verification lifecycle stays decoupled.
 */
export function hashVerificationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Delivery address + link for a verification message. The URL carries the raw
 * bearer credential; it must never be logged, persisted, or echoed.
 */
export type VerificationEmail = {
  to: string;
  verificationUrl: string;
};

/**
 * Minimal delivery port for verification messages.
 *
 * There is no production email provider in this milestone (email delivery
 * infrastructure is a future milestone): the default transport delivers
 * nothing. Tests inject a capturing fake. A future provider implements this
 * interface without touching the verification domain.
 */
export type EmailVerificationMailer = {
  sendVerificationEmail(email: VerificationEmail): Promise<void>;
};

export const noopEmailVerificationMailer: EmailVerificationMailer = {
  sendVerificationEmail(): Promise<void> {
    return Promise.resolve();
  },
};

/**
 * Builds the verification link from the configured application base URL.
 * The base URL comes from validated centralized config — never from the
 * request Host/Origin/Referer, which are attacker-controlled.
 */
export function buildVerificationUrl(rawToken: string): string {
  return `${config.appBaseUrl}/verify-email?token=${rawToken}`;
}

/**
 * Issues a verification credential for an already-resolved user.
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
  mailer: EmailVerificationMailer = noopEmailVerificationMailer,
): Promise<void> {
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = hashVerificationToken(rawToken);
  const expiresAt = new Date(Date.now() + config.auth.emailVerificationTtlSeconds * 1000);

  await prisma.$transaction(async (tx) => {
    await emailVerificationRepository.invalidateActiveForUser(userId, tx);
    await emailVerificationRepository.create(
      {
        id: randomUUID(),
        userId,
        tokenHash,
        expiresAt,
      },
      tx,
    );
  });

  await mailer.sendVerificationEmail({ to: email, verificationUrl: buildVerificationUrl(rawToken) });
}

/**
 * Resolves a presented raw credential to its token row identity, or null
 * when the credential cannot complete a verification (unknown, consumed, or
 * expired). Read-only lookup for the pre-transaction gate in `auth.service`.
 */
export async function findActiveToken(
  rawToken: unknown,
): Promise<{ id: string; userId: string } | null> {
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    return null;
  }

  const row = await emailVerificationRepository.findByTokenHash(hashVerificationToken(rawToken));
  if (!row || row.consumedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return { id: row.id, userId: row.userId };
}

/**
 * Deletes every EmailVerificationToken owned by a user.
 * Used by user deletion to satisfy ON DELETE RESTRICT ordering.
 */
export async function removeByUserId(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  return emailVerificationRepository.removeByUserId(userId, tx);
}

export const emailVerificationService = {
  hashVerificationToken,
  buildVerificationUrl,
  issueToken,
  findActiveToken,
  removeByUserId,
  noopEmailVerificationMailer,
};
