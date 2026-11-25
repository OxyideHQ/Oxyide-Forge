import type { Prisma } from '@prisma/client';

import { sessionRepository } from '../repositories/session.repository.js';

/**
 * Session service — the auth module's cross-module contract for session lifecycle.
 *
 * Sessions are owned by the auth module (see docs/architecture.md §8 and
 * ADR-008). Other modules must not import `session.repository` directly; they
 * call this service instead (engineering standards §6.1). The optional
 * transaction client is threaded through so a caller that owns a transaction
 * boundary (engineering standards §16) stays atomic.
 */
export async function removeByUserId(userId: string, tx?: Prisma.TransactionClient): Promise<number> {
  return sessionRepository.removeByUserId(userId, tx);
}

/**
 * Revokes one session/family so none of its refresh credentials can refresh.
 * Idempotent: already-revoked sessions report false without error.
 * A revoked session stays revoked — nothing in M3.7 clears revokedAt.
 */
export async function revokeSession(sessionId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
  return sessionRepository.revokeFamily(sessionId, tx);
}

/**
 * Revokes every live session owned by a user in one set-based update.
 * Idempotent and safe for users with zero sessions. Returns the number of
 * sessions transitioned. Called by password reset (M3.11) in-transaction;
 * password change would call it too once M3.10 exists.
 */
export async function revokeAllSessionsForUser(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  return sessionRepository.revokeAllByUserId(userId, tx);
}

export const sessionService = {
  removeByUserId,
  revokeSession,
  revokeAllSessionsForUser,
};
