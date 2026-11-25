/**
 * Domain representation of a Session.
 *
 * A Session is persistent server-side authentication state owned by the auth
 * module. It is the revocation boundary for the refresh-token lifecycle
 * (revocation itself arrives in a later milestone). The `userId` links the
 * session to its owning User; PostgreSQL enforces the ownership.
 * Prisma-generated types never leave the repository layer.
 */
export type Session = {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Input for creating a new Session record.
 * The expiry must already be computed from the refresh-token lifetime
 * before calling the repository.
 */
export type CreateSessionInput = {
  id: string;
  userId: string;
  expiresAt: Date;
};

/**
 * Domain representation of a RefreshToken instance.
 *
 * One row per issued refresh credential. Only the SHA-256 hash of the raw
 * credential is persisted — the raw bearer credential must never reach the
 * repository layer. Prisma-generated types never leave the repository layer.
 */
export type RefreshToken = {
  id: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  supersededBy: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Input for creating a new RefreshToken record.
 * The tokenHash must already be the SHA-256 hex digest of the raw credential.
 */
export type CreateRefreshTokenInput = {
  id: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
};
