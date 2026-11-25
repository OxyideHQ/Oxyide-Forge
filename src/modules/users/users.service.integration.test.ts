/**
 * M1.3 — usersService.remove Transaction Boundary Integration Tests
 *
 * Proves real PostgreSQL atomicity for the Users module's service-owned
 * transaction: `usersService.remove` commits the Credential and User
 * deletions together or not at all, with the transaction client crossing the
 * Users → Auth service boundary (`credentialService.removeByUserId(id, tx)`).
 *
 * The Auth module counterpart (`authService.register`) lives in
 * `src/modules/auth/services/auth.service.integration.test.ts`.
 *
 * Rollback failures are injected at the repository seam (a database cannot be
 * asked to fail on demand); the transaction, the writes, and the rollback are
 * real database behavior. Assertions are database state, not call counts.
 *
 * Requires a running PostgreSQL instance at DATABASE_URL. When the database is
 * unavailable, the suite fails fast instead of silently passing.
 */

// Environment must be set before any module imports evaluate config.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { usersService } = await import('./users.service.js');
const { usersRepository } = await import('./user.repository.js');

let dbAvailable = false;

const SEED_USER = {
  id: 'u_m13tx000000000000000000000001',
  email: 'm13-tx@example.com',
  displayName: 'M1.3 Transaction User',
};

const SEED_CREDENTIAL = {
  id: 'c_m13tx000000000000000000000001',
  passwordHash: '$2b$12$m13seededhashvaluethatisnotarealbcryptvalue',
};

async function cleanDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EmailVerificationToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "PasswordResetToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "RefreshToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Session" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Credential" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
}

async function seedUserWithCredential(): Promise<void> {
  await prisma.user.create({
    data: {
      id: SEED_USER.id,
      email: SEED_USER.email,
      displayName: SEED_USER.displayName,
    },
  });
  await prisma.credential.create({
    data: {
      id: SEED_CREDENTIAL.id,
      userId: SEED_USER.id,
      passwordHash: SEED_CREDENTIAL.passwordHash,
    },
  });
}

beforeAll(async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run integration tests with NODE_ENV=production: suites truncate tables.',
    );
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    // Fail fast instead of silently passing: a missing database must be visible.
    throw new Error(
      'PostgreSQL unavailable: integration tests require a running database at DATABASE_URL.',
    );
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await cleanDatabase();
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanDatabase();
  }
  await prisma.$disconnect();
});

// ────────────────────────────────────────────────────────
// usersService.remove — cross-module transaction
// ────────────────────────────────────────────────────────

describe('usersService.remove — transaction atomicity (PostgreSQL)', () => {
  it('commits the credential and user deletions together on success', async () => {
    if (!dbAvailable) return;
    await seedUserWithCredential();

    const removed = await usersService.remove(SEED_USER.id);

    expect(removed).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: SEED_USER.id } })).toBeNull();
    expect(await prisma.credential.findUnique({ where: { userId: SEED_USER.id } })).toBeNull();
  });

  it('rolls back the cross-module credential deletion when the user deletion fails', async () => {
    if (!dbAvailable) return;
    await seedUserWithCredential();

    const failure = Object.assign(new Error('connection terminated unexpectedly'), {
      code: 'P2010',
    });
    const removeSpy = vi.spyOn(usersRepository, 'remove').mockImplementationOnce(async () => {
      throw failure;
    });

    await expect(usersService.remove(SEED_USER.id)).rejects.toThrow(
      'connection terminated unexpectedly',
    );
    removeSpy.mockRestore();

    // The credential deletion ran through the Auth credential service on the
    // SAME transaction client; if that context were lost across the service
    // boundary, the credential would be gone here while the user survives.
    expect(await prisma.credential.findUnique({ where: { userId: SEED_USER.id } })).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: SEED_USER.id } })).not.toBeNull();
  });

  it('returns false without deleting anything when the user does not exist', async () => {
    if (!dbAvailable) return;

    const removed = await usersService.remove('u_m13tx_missing_user');

    expect(removed).toBe(false);
  });

  it('deletes owned sessions and refresh instances together with the user', async () => {
    if (!dbAvailable) return;
    await seedUserWithCredential();
    await prisma.session.create({
      data: {
        id: 's_m13tx000000000000000000000001',
        userId: SEED_USER.id,
        expiresAt: new Date(Date.now() + 3600_000),
        refreshTokens: {
          create: {
            id: 'r_m13tx000000000000000000000001',
            tokenHash: 'm13seededtokenhashvaluethatisnotarealcredential',
            expiresAt: new Date(Date.now() + 3600_000),
          },
        },
      },
    });

    const removed = await usersService.remove(SEED_USER.id);

    expect(removed).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: SEED_USER.id } })).toBeNull();
    expect(await prisma.session.findMany({ where: { userId: SEED_USER.id } })).toHaveLength(0);
    expect(await prisma.refreshToken.findMany()).toHaveLength(0);
  });

  it('deletes a rotated chain (self-linked successor) without FK violations', async () => {
    if (!dbAvailable) return;
    await seedUserWithCredential();
    await prisma.session.create({
      data: {
        id: 's_m13tx000000000000000000000002',
        userId: SEED_USER.id,
        expiresAt: new Date(Date.now() + 3600_000),
        refreshTokens: {
          // Successor listed first: the old instance references it, so it
          // must exist before the referencing row is inserted.
          create: [
            {
              id: 'r_m13tx000000000000000000000003',
              tokenHash: 'm13seedednewhashvaluethatisnotarealcredential2',
              expiresAt: new Date(Date.now() + 3600_000),
            },
            {
              id: 'r_m13tx000000000000000000000002',
              tokenHash: 'm13seededoldhashvaluethatisnotarealcredential1',
              expiresAt: new Date(Date.now() + 3600_000),
              consumedAt: new Date(),
              supersededBy: 'r_m13tx000000000000000000000003',
            },
          ],
        },
      },
    });

    const removed = await usersService.remove(SEED_USER.id);

    expect(removed).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: SEED_USER.id } })).toBeNull();
    expect(await prisma.session.findMany({ where: { userId: SEED_USER.id } })).toHaveLength(0);
    expect(await prisma.refreshToken.findMany()).toHaveLength(0);
  });

  it('deletes owned password-reset tokens together with the user', async () => {
    if (!dbAvailable) return;
    await seedUserWithCredential();
    await prisma.passwordResetToken.create({
      data: {
        id: 'p_m13tx000000000000000000000001',
        userId: SEED_USER.id,
        tokenHash: 'm13seededresethashvaluethatisnotarealcredential',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const removed = await usersService.remove(SEED_USER.id);

    expect(removed).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: SEED_USER.id } })).toBeNull();
    expect(await prisma.passwordResetToken.findMany()).toHaveLength(0);
  });

  it('deletes owned email-verification tokens together with the user', async () => {
    if (!dbAvailable) return;
    await seedUserWithCredential();
    await prisma.emailVerificationToken.create({
      data: {
        id: 'e_m13tx000000000000000000000001',
        userId: SEED_USER.id,
        tokenHash: 'm13seededverifyhashvaluethatisnotarealcredential',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const removed = await usersService.remove(SEED_USER.id);

    expect(removed).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: SEED_USER.id } })).toBeNull();
    expect(await prisma.emailVerificationToken.findMany()).toHaveLength(0);
  });
});
