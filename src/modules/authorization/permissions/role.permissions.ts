/**
 * Role-related permissions.
 *
 * Permission format: `<domain>:<action>`
 * These constants are the single source of truth for role permission strings.
 */
export const RolePermissions = {
  /** Allows reading roles. */
  READ: 'roles:read',

  /** Allows creating roles. */
  CREATE: 'roles:create',

  /** Allows updating roles. */
  UPDATE: 'roles:update',

  /** Allows deleting roles. */
  DELETE: 'roles:delete',
} as const;

/** Union type of all role permission strings. */
export type RolePermission = (typeof RolePermissions)[keyof typeof RolePermissions];
