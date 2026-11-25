import type { Prisma } from '@prisma/client';

import { prisma } from '../../platform/database/prisma.js';

import type { CreateUserInput, UpdateUserInput, User } from './user.types.js';

/**
 * Prisma select clause for the User domain type.
 * Ensures only User fields are returned; the Credential relation is excluded.
 */
const userSelect = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  role: true,
  emailVerifiedAt: true,
  lockedUntil: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDomain(row: { id: string; email: string; displayName: string | null; status: string; role: string; emailVerifiedAt: Date | null; lockedUntil: Date | null; createdAt: Date; updatedAt: Date }): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    role: row.role,
    emailVerifiedAt: row.emailVerifiedAt,
    lockedUntil: row.lockedUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Finds a User by their normalized email address.
 * Returns null if no user exists with the given email.
 */
export async function findByEmail(
  email: string,
  tx?: Prisma.TransactionClient,
): Promise<User | null> {
  const client = tx ?? prisma;
  const row = await client.user.findUnique({
    where: { email },
    select: userSelect,
  });

  return row ? toDomain(row) : null;
}

/**
 * Finds a User by their ID.
 * Returns null if no user exists with the given ID.
 */
export async function findById(
  id: string,
  tx?: Prisma.TransactionClient,
): Promise<User | null> {
  const client = tx ?? prisma;
  const row = await client.user.findUnique({
    where: { id },
    select: userSelect,
  });

  return row ? toDomain(row) : null;
}

/**
 * Creates a new User record.
 * The email must be normalized (trimmed, lowercased) before calling this function.
 * Throws on unique constraint violation (duplicate email) — the caller (service layer)
 * is responsible for mapping Prisma error codes to domain error codes.
 */
export async function create(
  input: CreateUserInput,
  tx?: Prisma.TransactionClient,
): Promise<User> {
  const client = tx ?? prisma;
  const row = await client.user.create({
    data: {
      id: input.id,
      email: input.email,
      displayName: input.displayName ?? null,
      status: input.status ?? 'active',
      role: input.role ?? 'user',
    },
    select: userSelect,
  });

  return toDomain(row);
}

/**
 * Updates an existing User record.
 * Only the fields provided in input are updated.
 * Returns null if no user exists with the given ID (Prisma P2025).
 * Any other database error propagates to the caller so that an enclosing
 * service-owned transaction rolls back instead of committing a partial result.
 */
export async function update(
  id: string,
  input: UpdateUserInput,
  tx?: Prisma.TransactionClient,
): Promise<User | null> {
  const client = tx ?? prisma;

  // Build the data object with only provided fields
  const data: Prisma.UserUpdateInput = {};
  if ('displayName' in input) {
    data.displayName = input.displayName ?? null;
  }
  if ('status' in input) {
    data.status = input.status;
  }
  if ('emailVerifiedAt' in input) {
    data.emailVerifiedAt = input.emailVerifiedAt ?? null;
  }
  if ('lockedUntil' in input) {
    data.lockedUntil = input.lockedUntil ?? null;
  }

  try {
    const row = await client.user.update({
      where: { id },
      data,
      select: userSelect,
    });

    return toDomain(row);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'P2025') {
      return null;
    }
    throw error;
  }
}

/**
 * Sets the account lockout marker only when no live lock exists.
 *
 * Conditional predicate (`lockedUntil IS NULL OR lockedUntil <= now`)
 * evaluated by PostgreSQL: concurrent threshold-crossers converge on one
 * coherent state instead of racing, and a live lock from an earlier window
 * keeps its original expiry instead of being extended by new failures.
 * Returns true when THIS caller performed the transition. Unknown IDs
 * report false. Unexpected database errors propagate.
 */
export async function setLockedUntilIfUnlocked(
  id: string,
  lockedUntil: Date,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const client = tx ?? prisma;
  const result = await client.user.updateMany({
    where: { id, OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }] },
    data: { lockedUntil },
  });

  return result.count === 1;
}

/**
 * Clears an expired lockout marker, leaving a live lock untouched.
 *
 * Request-driven recovery needs no background worker: the conditional
 * predicate (`lockedUntil <= now`) makes concurrent expiries idempotent,
 * while a fresh lock committed between the caller's read and this clear
 * matches zero rows and survives. Returns true when THIS caller cleared
 * the marker. Unexpected database errors propagate.
 */
export async function clearExpiredLockout(
  id: string,
  now: Date,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const client = tx ?? prisma;
  const result = await client.user.updateMany({
    where: { id, lockedUntil: { lte: now } },
    data: { lockedUntil: null },
  });

  return result.count === 1;
}

/**
 * Deletes a User record by ID.
 * Returns true if the user was deleted, false if no user exists (Prisma P2025).
 * Any other database error propagates to the caller so that an enclosing
 * service-owned transaction rolls back instead of committing a partial result.
 */
export async function remove(
  id: string,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const client = tx ?? prisma;

  try {
    await client.user.delete({ where: { id } });
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'P2025') {
      return false;
    }
    throw error;
  }
}

export const usersRepository = {
  findByEmail,
  findById,
  create,
  update,
  setLockedUntilIfUnlocked,
  clearExpiredLockout,
  remove,
};
