/**
 * Domain representation of a PasswordResetToken.
 *
 * One row per issued password-recovery credential. Only the SHA-256 hash of
 * the raw credential is persisted — the raw bearer credential must never
 * reach the repository layer. Prisma-generated types never leave the
 * repository layer.
 */
export type PasswordResetToken = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Input for creating a new PasswordResetToken record.
 * The tokenHash must already be the SHA-256 hex digest of the raw credential,
 * and expiresAt must already be computed from the reset-token lifetime.
 */
export type CreatePasswordResetTokenInput = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};
