/**
 * Domain representation of an EmailVerificationToken.
 *
 * One row per issued email-proof credential. Only the SHA-256 hash of the
 * raw credential is persisted — the raw bearer credential must never reach
 * the repository layer. Prisma-generated types never leave the repository
 * layer.
 */
export type EmailVerificationToken = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Input for creating a new EmailVerificationToken record.
 * The tokenHash must already be the SHA-256 hex digest of the raw credential,
 * and expiresAt must already be computed from the verification lifetime.
 */
export type CreateEmailVerificationTokenInput = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};
