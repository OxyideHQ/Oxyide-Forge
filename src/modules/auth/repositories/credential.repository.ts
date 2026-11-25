import type { Prisma } from '@prisma/client';

import { prisma } from '../../../platform/database/prisma.js';

import type { CreateCredentialInput, Credential } from '../credential.types.js';

/**
 * Prisma select clause for the Credential domain type.
 * All Credential fields are within the auth boundary; the User relation is excluded.
 */
const credentialSelect = {
  id: true,
  userId: true,
  passwordHash: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDomain(row: { id: string; userId: string; passwordHash: string; createdAt: Date; updatedAt: Date }): Credential {
  return {
    id: row.id,
    userId: row.userId,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Finds a Credential by the owning User's ID.
 * Returns null if no credential exists for the given user ID.
 */
export async function findByUserId(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<Credential | null> {
  const client = tx ?? prisma;
  const row = await client.credential.findUnique({
    where: { userId },
    select: credentialSelect,
  });

  return row ? toDomain(row) : null;
}

/**
 * Creates a new Credential record.
 * The passwordHash must already be hashed by the password service before calling this function.
 * Throws on unique constraint violation (duplicate userId) — the caller (service layer)
 * is responsible for mapping Prisma error codes to domain error codes.
 */
export async function create(
  input: CreateCredentialInput,
  tx?: Prisma.TransactionClient,
): Promise<Credential> {
  const client = tx ?? prisma;
  const row = await client.credential.create({
    data: {
      id: input.id,
      userId: input.userId,
      passwordHash: input.passwordHash,
    },
    select: credentialSelect,
  });

  return toDomain(row);
}

/**
 * Deletes a Credential record by the owning User's ID.
 * Returns true if the credential was deleted, false if no credential exists (Prisma P2025).
 * Any other database error propagates to the caller so that an enclosing
 * service-owned transaction rolls back instead of committing a partial result.
 */
export async function removeByUserId(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const client = tx ?? prisma;

  try {
    await client.credential.delete({ where: { userId } });
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'P2025') {
      return false;
    }
    throw error;
  }
}

/**
 * Updates the stored password hash for the owning User's ID.
 * The passwordHash must already be hashed by the password service before
 * calling this function. Returns true when a row was updated, false when no
 * credential exists (no upsert — a missing credential for an existing user
 * is a data-integrity signal the service layer must handle explicitly).
 * Any other database error propagates to the caller.
 */
export async function updatePasswordHash(
  userId: string,
  passwordHash: string,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const client = tx ?? prisma;
  const result = await client.credential.updateMany({
    where: { userId },
    data: { passwordHash },
  });

  return result.count === 1;
}

export const credentialRepository = {
  findByUserId,
  create,
  updatePasswordHash,
  removeByUserId,
};
