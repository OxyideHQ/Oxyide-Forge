import type { Prisma } from '@prisma/client';

import { credentialRepository } from '../repositories/credential.repository.js';

/**
 * Credential service — the auth module's cross-module contract for credential lifecycle.
 *
 * Credentials are owned by the auth module (see docs/architecture.md §8). Other modules
 * must not import `credential.repository` directly; they call this service instead
 * (engineering standards §6.1). The optional transaction client is threaded through so
 * a caller that owns a transaction boundary (engineering standards §16) stays atomic.
 */
async function removeByUserId(userId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
  return credentialRepository.removeByUserId(userId, tx);
}

export const credentialService = {
  removeByUserId,
};
