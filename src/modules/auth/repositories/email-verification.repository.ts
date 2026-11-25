import type { Prisma } from '@prisma/client';

import { prisma } from '../../../platform/database/prisma.js';

import type {
  CreateEmailVerificationTokenInput,
  EmailVerificationToken,
} from '../email-verification.types.js';

/**
 * Prisma select clause for the EmailVerificationToken domain type.
 * Only the one-way hash is ever read — raw credentials never reach this layer.
 */
const emailVerificationTokenSelect = {
  id: true,
  userId: true,
  tokenHash: true,
  expiresAt: true,
  consumedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDomain(row: {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): EmailVerificationToken {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Finds an EmailVerificationToken instance by its SHA-256 hash.
 * The caller hashes the presented raw credential before calling this
 * function; the raw credential never reaches the repository layer.
 * Returns null if no instance exists for the given hash.
 */
export async function findByTokenHash(
  tokenHash: string,
  tx?: Prisma.TransactionClient,
): Promise<EmailVerificationToken | null> {
  const client = tx ?? prisma;
  const row = await client.emailVerificationToken.findUnique({
    where: { tokenHash },
    select: emailVerificationTokenSelect,
  });

  return row ? toDomain(row) : null;
}

/**
 * Creates a new EmailVerificationToken record.
 * The tokenHash must already be the SHA-256 hex digest of the raw credential.
 * Throws on unique constraint violation (duplicate tokenHash) — the caller
 * (service layer) is responsible for mapping Prisma error codes to domain
 * error codes.
 */
export async function create(
  input: CreateEmailVerificationTokenInput,
  tx?: Prisma.TransactionClient,
): Promise<EmailVerificationToken> {
  const client = tx ?? prisma;
  const row = await client.emailVerificationToken.create({
    data: {
      id: input.id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    },
    select: emailVerificationTokenSelect,
  });

  return toDomain(row);
}

/**
 * Atomically transitions an ACTIVE instance to CONSUMED.
 *
 * Conditional predicate (unconsumed, unexpired) evaluated by PostgreSQL;
 * concurrent transactions serialize on the row lock. Returns true when THIS
 * caller won — exactly one successful consumption per credential.
 */
export async function consumeIfActive(
  id: string,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const client = tx ?? prisma;
  const now = new Date();
  const result = await client.emailVerificationToken.updateMany({
    where: { id, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });

  return result.count === 1;
}

/**
 * Marks every unconsumed verification token of a user consumed.
 *
 * Newest-only issuance policy: each new token supersedes previous active
 * credentials so at most one usable token exists per user. Returns the
 * number of rows transitioned. Unexpected database errors propagate.
 */
export async function invalidateActiveForUser(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const client = tx ?? prisma;
  const result = await client.emailVerificationToken.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  return result.count;
}

/**
 * Deletes every EmailVerificationToken owned by a user.
 *
 * Used by user deletion to satisfy ON DELETE RESTRICT ordering. Returns the
 * number of rows deleted. Any database error propagates so that an enclosing
 * service-owned transaction rolls back instead of committing a partial result.
 */
export async function removeByUserId(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const client = tx ?? prisma;
  const result = await client.emailVerificationToken.deleteMany({ where: { userId } });

  return result.count;
}

export const emailVerificationRepository = {
  findByTokenHash,
  create,
  consumeIfActive,
  invalidateActiveForUser,
  removeByUserId,
};
