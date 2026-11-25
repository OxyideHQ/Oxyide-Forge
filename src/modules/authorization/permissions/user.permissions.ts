/**
 * User-related permissions.
 *
 * Permission format: `<domain>:<action>`
 * These constants are the single source of truth for user permission strings.
 */
export const UserPermissions = {
  /** Allows reading any user's profile. */
  READ: 'users:read',

  /** Allows reading one's own profile. */
  READ_SELF: 'users:read:self',

  /** Allows updating any user's profile. */
  UPDATE: 'users:update',

  /** Allows updating one's own profile. */
  UPDATE_SELF: 'users:update:self',

  /** Allows deleting any user. */
  DELETE: 'users:delete',
} as const;

/** Union type of all user permission strings. */
export type UserPermission = (typeof UserPermissions)[keyof typeof UserPermissions];
