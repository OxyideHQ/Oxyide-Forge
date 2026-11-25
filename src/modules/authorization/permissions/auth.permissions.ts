/**
 * Authentication-related permissions.
 *
 * Permission format: `<domain>:<action>`
 * These constants are the single source of truth for auth permission strings.
 */
export const AuthPermissions = {
  /** Allows logging in. */
  LOGIN: 'auth:login',

  /** Allows logging out. */
  LOGOUT: 'auth:logout',
} as const;

/** Union type of all auth permission strings. */
export type AuthPermission = (typeof AuthPermissions)[keyof typeof AuthPermissions];
