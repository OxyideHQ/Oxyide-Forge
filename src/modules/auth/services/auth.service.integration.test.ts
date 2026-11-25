/**
 * M1.3 — authService.register Transaction Boundary Integration Tests
 *
 * Proves real PostgreSQL atomicity for the Auth module's service-owned
 * transaction: `authService.register` commits the User and Credential inserts
 * together or not at all.
 *
 * The Users module counterpart (`usersService.remove`) lives in
 * `src/modules/users/users.service.integration.test.ts`.
 *
 * Rollback failure is injected at the repository seam (a database cannot be
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

const { authService } = await import('./auth.service.js');
const { credentialRepository } = await import('../repositories/credential.repository.js');

let dbAvailable = false;

async function cleanDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Credential" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
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

describe('authService.register — transaction atomicity (PostgreSQL)', () => {
  it('does not persist the user when credential creation fails', async () => {
    if (!dbAvailable) return;

    const failure = Object.assign(new Error('credential insert failed'), { code: 'P2003' });
    const createSpy = vi.spyOn(credentialRepository, 'create').mockImplementationOnce(async () => {
      throw failure;
    });

    await expect(
      authService.register({
        email: 'm13-register-rollback@example.com',
        password: 'StrongPassword123!',
        displayName: 'M1.3 Register Rollback',
      }),
    ).rejects.toThrow('credential insert failed');
    createSpy.mockRestore();

    // Operation 1 (user insert) must be rolled back with failed operation 2.
    expect(
      await prisma.user.findUnique({ where: { email: 'm13-register-rollback@example.com' } }),
    ).toBeNull();
  });

  it('commits the user and credential together on success', async () => {
    if (!dbAvailable) return;

    const publicUser = await authService.register({
      email: 'm13-register-success@example.com',
      password: 'StrongPassword123!',
      displayName: 'M1.3 Register Success',
    });

    expect(await prisma.user.findUnique({ where: { id: publicUser.id } })).not.toBeNull();
    expect(await prisma.credential.findUnique({ where: { userId: publicUser.id } })).not.toBeNull();
  });
});
