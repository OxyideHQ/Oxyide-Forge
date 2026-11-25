import type { Prisma } from '@prisma/client';

import { prisma } from '../../../platform/database/prisma.js';

import type { CreateRefreshTokenInput, RefreshToken } from '../session.types.js';

/**
 * Prisma select clause for the RefreshToken domain type.
 * Only the one-way hash is ever read — raw credentials never reach this layer.
 */
const refreshTokenSelect = {
  id: true,
  sessionId: true,
  tokenHash: true,
  expiresAt: true,
  consumedAt: true,
  supersededBy: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDomain(row: {
  id: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  supersededBy: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): RefreshToken {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    supersededBy: row.supersededBy,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Finds a RefreshToken instance by its database ID.
 * Returns null if no instance exists with the given ID.
 */
export async function findById(
  id: string,
  tx?: Prisma.TransactionClient,
): Promise<RefreshToken | null> {
  const client = tx ?? prisma;
  const row = await client.refreshToken.findUnique({
    where: { id },
    select: refreshTokenSelect,
  });

  return row ? toDomain(row) : null;
}

/**
 * Finds a RefreshToken instance by its SHA-256 hash.
 * The caller hashes the presented raw credential before calling this
 * function; the raw credential never reaches the repository layer.
 * Returns null if no instance exists for the given hash.
 */
export async function findByTokenHash(
  tokenHash: string,
  tx?: Prisma.TransactionClient,
): Promise<RefreshToken | null> {
  const client = tx ?? prisma;
  const row = await client.refreshToken.findUnique({
    where: { tokenHash },
    select: refreshTokenSelect,
  });

  return row ? toDomain(row) : null;
}

/**
 * Creates a new RefreshToken record.
 * The tokenHash must already be the SHA-256 hex digest of the raw credential.
 * Throws on unique constraint violation (duplicate tokenHash) — the caller
 * (service layer) is responsible for mapping Prisma error codes to domain
 * error codes.
 */
export async function create(
  input: CreateRefreshTokenInput,
  tx?: Prisma.TransactionClient,
): Promise<RefreshToken> {
  const client = tx ?? prisma;
  const row = await client.refreshToken.create({
    data: {
      id: input.id,
      sessionId: input.sessionId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    },
    select: refreshTokenSelect,
  });

  return toDomain(row);
}

/**
 * Atomically transitions an ACTIVE instance to CONSUMED.
 *
 * This is the single-winner primitive behind rotation: the conditional
 * predicate (`consumedAt IS NULL`, unexpired) is evaluated by PostgreSQL
 * against the row lock, and concurrent transactions serialize on that lock
 * (READ COMMITTED re-evaluation). The returned boolean reports whether THIS
 * caller won — `true` means exactly one successful consumption.
 *
 * Prisma's conditional updateMany is sufficient here; raw SQL is not
 * required. Returns false (never throws) when the instance is missing,
 * already consumed, or expired.
 */
export async function consumeIfActive(
  id: string,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const client = tx ?? prisma;
  const now = new Date();
  const result = await client.refreshToken.updateMany({
    where: { id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });

  return result.count === 1;
}

/**
 * Links a consumed instance to its successor for audit lineage.
 * The successor must already exist (created earlier in the same transaction).
 * Throws on missing instance (Prisma P2025) — the caller owns a transaction
 * that must roll back instead of committing a half-linked rotation.
 */
export async function markSuperseded(
  id: string,
  successorId: string,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? prisma;
  await client.refreshToken.update({
    where: { id },
    data: { supersededBy: successorId },
  });
}

/**
 * Revokes a single refresh-token instance without touching its family.
 *
 * Idempotent: already-revoked instances report no transition. Consumed or
 * expired instances are safe to revoke (harmless marker on a dead row).
 * Returns true when this call performed the revocation, false when the
 * instance was already revoked. Unknown IDs report false (safe domain
 * result); unexpected database errors propagate.
 */
export async function revokeOne(
  id: string,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const client = tx ?? prisma;
  const result = await client.refreshToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return result.count === 1;
}

export const refreshTokenRepository = {
  findById,
  findByTokenHash,
  create,
  consumeIfActive,
  markSuperseded,
  revokeOne,
};
