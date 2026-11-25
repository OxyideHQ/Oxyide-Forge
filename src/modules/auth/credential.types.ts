/**
 * Domain representation of a Credential.
 *
 * This is the shape returned by the credential repository within the auth boundary.
 * The `passwordHash` field must never leave the auth module.
 * Prisma-generated types never leave the repository layer.
 */
export type Credential = {
  id: string;
  userId: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Input for creating a new Credential record.
 */
export type CreateCredentialInput = {
  id: string;
  userId: string;
  passwordHash: string;
};
