import type { Prisma } from '@prisma/client';

import { prisma } from '../../../platform/database/prisma.js';

import type { CreateLoginThrottleInput, LoginThrottle } from '../login-throttle.types.js';

/**
 * Prisma select clause for the LoginThrottle domain type.
 * Rows carry counters and timestamps only — no emails, IPs, passwords, or
 * token material. The key itself is a one-way namespaced hash.
 */
const loginThrottleSelect = {
  key: true,
  failureCount: true,
  windowStartedAt: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDomain(row: {
  key: string;
  failureCount: number;
  windowStartedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): LoginThrottle {
  return {
    key: row.key,
    failureCount: row.failureCount,
    windowStartedAt: row.windowStartedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Finds a throttle row by its namespaced key.
 * Returns null when no row exists for the key. Expired rows are returned as
 * stored — the caller decides liveness against its own clock so application
 * and database clocks are never mixed.
 */
export async function findByKey(
  key: string,
  tx?: Prisma.TransactionClient,
): Promise<LoginThrottle | null> {
  const client = tx ?? prisma;
  const row = await client.loginThrottle.findUnique({
    where: { key },
    select: loginThrottleSelect,
  });

  return row ? toDomain(row) : null;
}

/**
 * Records one failed login attempt against a throttle key and returns the
 * resulting row.
 *
 * Fixed-window semantics: a live row (unexpired) is incremented atomically
 * with a conditional `updateMany`, so concurrent failures serialize on the
 * row lock and no increment is ever lost. When no live row exists, any stale
 * row is removed and the window is (re)created with a single `upsert`:
 * create at count 1, or — when a concurrent request won the create race —
 * converge into the winner's live row with one atomic increment.
 *
 * The upsert (rather than create-plus-unique-violation-recovery) is what
 * makes this function safe inside an explicit transaction: a unique
 * violation would abort the whole PostgreSQL transaction (25P02) and poison
 * every later statement in it, while the upsert's server-side conflict
 * handling never raises. Callers inside and outside transactions share this
 * one path with identical observable behavior.
 *
 * Unexpected database errors propagate: the service layer fails closed
 * instead of masking an outage as an authentication outcome.
 */
export async function recordFailure(
  input: CreateLoginThrottleInput,
  tx?: Prisma.TransactionClient,
): Promise<LoginThrottle> {
  const client = tx ?? prisma;
  const now = new Date();

  const incremented = await client.loginThrottle.updateMany({
    where: { key: input.key, expiresAt: { gt: now } },
    data: { failureCount: { increment: 1 } },
  });

  if (incremented.count === 1) {
    const current = await client.loginThrottle.findUnique({
      where: { key: input.key },
      select: loginThrottleSelect,
    });
    // The conditional increment just matched this row, so it still exists;
    // a vanishing row would be a database-integrity signal worth surfacing.
    if (!current) {
      throw new Error(`LoginThrottle row vanished after atomic increment for key.`);
    }
    return toDomain(current);
  }

  // Remove only the expired row (if any). A live row created by a
  // concurrent request must survive: deleting it here would strand the
  // concurrent request's increment.
  await client.loginThrottle.deleteMany({
    where: { key: input.key, expiresAt: { lte: now } },
  });

  const row = await client.loginThrottle.upsert({
    where: { key: input.key },
    create: {
      key: input.key,
      failureCount: input.failureCount,
      windowStartedAt: input.windowStartedAt,
      expiresAt: input.expiresAt,
    },
    update: { failureCount: { increment: 1 } },
    select: loginThrottleSelect,
  });
  return toDomain(row);
}

/**
 * Clears the throttle row for a key, if one exists.
 * Used when a successful login resets account-scoped failure state.
 * Returns true when a row was removed. Unexpected errors propagate.
 */
export async function clearByKey(
  key: string,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const client = tx ?? prisma;
  const result = await client.loginThrottle.deleteMany({ where: { key } });

  return result.count === 1;
}

/**
 * Removes every expired throttle row.
 *
 * Opportunistic bounded cleanup: failure traffic is the only writer, so
 * piggybacking expiration cleanup on the failure path keeps the table at
 * roughly one window's worth of rows without a background worker. The
 * `expiresAt` index keeps the scan cheap when little has expired.
 */
export async function deleteExpired(tx?: Prisma.TransactionClient): Promise<number> {
  const client = tx ?? prisma;
  const result = await client.loginThrottle.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });

  return result.count;
}

export const loginThrottleRepository = {
  findByKey,
  recordFailure,
  clearByKey,
  deleteExpired,
};
