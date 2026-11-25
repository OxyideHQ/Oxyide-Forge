import type { Prisma } from '@prisma/client';

import { prisma } from '../../../platform/database/prisma.js';

import type { CreatePasswordResetTokenInput, PasswordResetToken } from '../password-reset.types.js';

/**
 * Prisma select clause for the PasswordResetToken domain type.
 * Only the one-way hash is ever read — raw credentials never reach this layer.
 */
const passwordResetTokenSelect = {
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
}): PasswordResetToken {
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
 * Finds a PasswordResetToken instance by its SHA-256 hash.
 * The caller hashes the presented raw credential before calling this
 * function; the raw credential never reaches the repository layer.
 * Returns null if no instance exists for the given hash.
 */
export async function findByTokenHash(
  tokenHash: string,
  tx?: Prisma.TransactionClient,
): Promise<PasswordResetToken | null> {
  const client = tx ?? prisma;
  const row = await client.passwordResetToken.findUnique({
    where: { tokenHash },
    select: passwordResetTokenSelect,
  });

  return row ? toDomain(row) : null;
}

/**
 * Creates a new PasswordResetToken record.
 * The tokenHash must already be the SHA-256 hex digest of the raw credential.
 * Throws on unique constraint violation (duplicate tokenHash) — the caller
 * (service layer) is responsible for mapping Prisma error codes to domain
 * error codes.
 */
export async function create(
  input: CreatePasswordResetTokenInput,
  tx?: Prisma.TransactionClient,
): Promise<PasswordResetToken> {
  const client = tx ?? prisma;
  const row = await client.passwordResetToken.create({
    data: {
      id: input.id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    },
    select: passwordResetTokenSelect,
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
  const result = await client.passwordResetToken.updateMany({
    where: { id, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });

  return result.count === 1;
}

/**
 * Marks every unconsumed reset token of a user consumed.
 *
 * Newest-only issuance policy: each new request supersedes previous active
 * credentials so at most one usable token exists per user. Returns the
 * number of rows transitioned. Unexpected database errors propagate.
 */
export async function invalidateActiveForUser(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const client = tx ?? prisma;
  const result = await client.passwordResetToken.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  return result.count;
}

/**
 * Deletes every PasswordResetToken owned by a user.
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
  const result = await client.passwordResetToken.deleteMany({ where: { userId } });

  return result.count;
}

export const passwordResetRepository = {
  findByTokenHash,
  create,
  consumeIfActive,
  invalidateActiveForUser,
  removeByUserId,
};
