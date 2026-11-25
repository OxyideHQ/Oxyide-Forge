/**
 * Domain representation of a User.
 *
 * This is the public shape returned by the users repository.
 * It excludes all credential and internal infrastructure fields.
 * Prisma-generated types never leave the repository layer.
 */
export type User = {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  role: string;
  emailVerifiedAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Input for creating a new User record.
 * Email must be normalized (trimmed, lowercased) before passing to the repository.
 */
export type CreateUserInput = {
  id: string;
  email: string;
  displayName?: string | null;
  status?: string;
  role?: string;
};

/**
 * Input for updating an existing User record.
 * Only provided fields are updated.
 */
export type UpdateUserInput = {
  displayName?: string | null;
  status?: string;
  emailVerifiedAt?: Date | null;
  lockedUntil?: Date | null;
};
