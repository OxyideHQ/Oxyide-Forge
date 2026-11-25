import type { Prisma } from '@prisma/client';

import { prisma } from '../../../platform/database/prisma.js';

import type { CreateSessionInput, Session } from '../session.types.js';

/**
 * Prisma select clause for the Session domain type.
 * Sessions carry lifecycle metadata only — no token material.
 */
const sessionSelect = {
  id: true,
  userId: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDomain(row: {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): Session {
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Finds a Session by its ID.
 * Returns null if no session exists with the given ID.
 */
export async function findById(
  id: string,
  tx?: Prisma.TransactionClient,
): Promise<Session | null> {
  const client = tx ?? prisma;
  const row = await client.session.findUnique({
    where: { id },
    select: sessionSelect,
  });

  return row ? toDomain(row) : null;
}

/**
 * Creates a new Session record.
 * Throws on unique constraint violation (duplicate id) — the caller (service
 * layer) is responsible for mapping Prisma error codes to domain error codes.
 */
export async function create(
  input: CreateSessionInput,
  tx?: Prisma.TransactionClient,
): Promise<Session> {
  const client = tx ?? prisma;
  const row = await client.session.create({
    data: {
      id: input.id,
      userId: input.userId,
      expiresAt: input.expiresAt,
    },
    select: sessionSelect,
  });

  return toDomain(row);
}

/**
 * Deletes every Session (and its RefreshToken instances) owned by a user.
 *
 * Because RefreshToken.sessionId references Session.id with ON DELETE
 * RESTRICT, each session's instances are deleted before the sessions. All
 * deletions use the provided transaction client when one is given so an
 * enclosing service-owned transaction stays atomic.
 *
 * Returns the number of sessions deleted. Any database error propagates to
 * the caller so that an enclosing service-owned transaction rolls back
 * instead of committing a partial result.
 */
export async function removeByUserId(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const client = tx ?? prisma;

  const sessions = await client.session.findMany({
    where: { userId },
    select: { id: true },
  });

  if (sessions.length > 0) {
    await client.refreshToken.deleteMany({
      where: { sessionId: { in: sessions.map((session) => session.id) } },
    });
  }

  const result = await client.session.deleteMany({ where: { userId } });
  return result.count;
}

/**
 * Invalidates a token family by marking its session revoked.
 *
 * This is the M3.6 replay response (ADR-008): presenting a consumed token
 * revokes the whole family so every remaining live instance fails refresh.
 * Idempotent — re-presenting after revocation changes nothing. Returns true
 * when this call performed the revocation. Committed by the caller's
 * service-owned transaction; never called outside one.
 */
export async function revokeFamily(
  sessionId: string,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const client = tx ?? prisma;
  const result = await client.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return result.count === 1;
}

/**
 * Revokes every live session owned by a user in one set-based update.
 *
 * No rows are loaded into application memory and no per-row loop runs: a
 * single UPDATE covers the whole boundary. Already-revoked sessions are
 * untouched; users with zero sessions report zero. Returns the number of
 * sessions transitioned. Unexpected database errors propagate.
 */
export async function revokeAllByUserId(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const client = tx ?? prisma;
  const result = await client.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return result.count;
}

export const sessionRepository = {
  findById,
  create,
  removeByUserId,
  revokeFamily,
  revokeAllByUserId,
};
