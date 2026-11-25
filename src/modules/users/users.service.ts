import type { Prisma } from '@prisma/client';

import { prisma } from '../../platform/database/prisma.js';
import type { User, UpdateUserInput } from './user.types.js';
import { usersRepository } from './user.repository.js';
import { credentialService } from '../auth/services/credential.service.js';
import { emailVerificationService } from '../auth/services/email-verification.service.js';
import { passwordResetService } from '../auth/services/password-reset.service.js';
import { sessionService } from '../auth/services/session.service.js';

/**
 * Finds a User by their normalized email address.
 */
async function findByEmail(email: string): Promise<User | null> {
  return usersRepository.findByEmail(email);
}

/**
 * Finds a User by their ID.
 */
async function findById(id: string): Promise<User | null> {
  return usersRepository.findById(id);
}

/**
 * Finds only the role for a User by their ID.
 * Returns null if no user exists with the given ID.
 * Used by the authorization service to avoid fetching unnecessary user data.
 */
async function findRoleById(id: string): Promise<string | null> {
  const user = await usersRepository.findById(id);
  return user?.role ?? null;
}

/**
 * Creates a new User record.
 * Accepts an optional transaction client for use within a service-owned transaction.
 */
async function create(
  input: { id: string; email: string; displayName?: string | null; status?: string; role?: string },
  tx?: Prisma.TransactionClient,
): Promise<User> {
  return usersRepository.create(input, tx);
}

/**
 * Updates an existing User record.
 * Returns null if no user exists with the given ID.
 */
async function update(
  id: string,
  input: UpdateUserInput,
  tx?: Prisma.TransactionClient,
): Promise<User | null> {
  return usersRepository.update(id, input, tx);
}

/**
 * Sets the account lockout marker only when no live lock exists.
 *
 * Auth-owned lockout policy (M3.16) calls this inside its service-owned
 * failure transaction at the lockout threshold. The conditional predicate
 * keeps concurrent threshold-crossers coherent and never extends a live
 * lock. Returns true when the transition was performed.
 */
async function setAccountLockIfUnlocked(
  id: string,
  lockedUntil: Date,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  return usersRepository.setLockedUntilIfUnlocked(id, lockedUntil, tx);
}

/**
 * Clears an expired lockout marker, leaving a live lock untouched.
 *
 * Request-driven recovery for M3.16: no background worker. Returns true
 * when the marker was cleared. A fresh lock committed between the caller's
 * read and this clear matches zero rows and survives.
 */
async function clearExpiredAccountLock(
  id: string,
  now: Date,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  return usersRepository.clearExpiredLockout(id, now, tx);
}

/**
 * Deletes a User and their Credential, Sessions, PasswordResetTokens, and
 * EmailVerificationTokens in a single database transaction.
 *
 * Because Credential.userId, Session.userId, PasswordResetToken.userId, and
 * EmailVerificationToken.userId reference User.id with ON DELETE RESTRICT,
 * owned rows must be deleted before the User. All deletions are wrapped in a
 * transaction to ensure atomicity — if User deletion fails, the owned-row
 * deletions are rolled back.
 *
 * Returns true if the user was deleted, false if no user exists.
 */
async function remove(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // Step 1: Verify the user exists before starting deletions
    const user = await usersRepository.findById(id, tx);
    if (!user) {
      return false;
    }

    // Step 2: Delete the user's sessions (if any) via the auth module's session contract
    await sessionService.removeByUserId(id, tx);

    // Step 3: Delete the user's password-reset tokens via the auth module's
    // password-reset contract
    await passwordResetService.removeByUserId(id, tx);

    // Step 4: Delete the user's email-verification tokens via the auth
    // module's verification contract
    await emailVerificationService.removeByUserId(id, tx);

    // Step 5: Delete the Credential (if one exists) via the auth module's credential contract
    await credentialService.removeByUserId(id, tx);

    // Step 6: Delete the User
    const deleted = await usersRepository.remove(id, tx);
    return deleted;
  });
}

export const usersService = {
  findByEmail,
  findById,
  findRoleById,
  create,
  update,
  setAccountLockIfUnlocked,
  clearExpiredAccountLock,
  remove,
};
