import { AuthPermissions, type AuthPermission } from './permissions/auth.permissions.js';
import { UserPermissions, type UserPermission } from './permissions/user.permissions.js';
import { RolePermissions, type RolePermission } from './permissions/role.permissions.js';

/**
 * All permission strings in the application.
 * Union of all domain-specific permission types.
 */
export type Permission = AuthPermission | UserPermission | RolePermission;

/**
 * Built-in role names.
 *
 * The starter ships with two roles:
 * - `user` — default role assigned at registration.
 * - `admin` — elevated role with full permission set.
 *
 * Applications should extend this by adding domain-specific roles
 * and updating the ROLE_PERMISSIONS mapping accordingly.
 */
export const Roles = {
  USER: 'user',
  ADMIN: 'admin',
} as const;

export type RoleName = (typeof Roles)[keyof typeof Roles];

/**
 * Static mapping from role names to their granted permissions.
 *
 * This is the single source of truth for what each role can do.
 * Authorization decisions are derived from this mapping — never from
 * client-supplied data.
 *
 * The `admin` role inherits all permissions. The `user` role has
 * only self-scoped permissions.
 */
export const ROLE_PERMISSIONS: Record<RoleName, readonly Permission[]> = {
  [Roles.USER]: [
    AuthPermissions.LOGIN,
    AuthPermissions.LOGOUT,
    UserPermissions.READ_SELF,
    UserPermissions.UPDATE_SELF,
  ],
  [Roles.ADMIN]: [
    // Auth
    AuthPermissions.LOGIN,
    AuthPermissions.LOGOUT,
    // Users
    UserPermissions.READ,
    UserPermissions.READ_SELF,
    UserPermissions.UPDATE,
    UserPermissions.UPDATE_SELF,
    UserPermissions.DELETE,
    // Roles
    RolePermissions.READ,
    RolePermissions.CREATE,
    RolePermissions.UPDATE,
    RolePermissions.DELETE,
  ],
} as const;

/**
 * Runtime immutability (M4.2 F5): TypeScript `readonly` is compile-time only,
 * so the map, the role constants, and each role's permission array are
 * frozen explicitly. Ordinary application code cannot push, splice,
 * reassign, or otherwise expand authorization after initialization — any
 * such attempt throws a TypeError instead of silently widening access.
 * The stored values are strings, so freezing the containers is sufficient;
 * no nested objects exist to freeze further.
 */
Object.freeze(Roles);
for (const roleName of Object.values(Roles)) {
  Object.freeze(ROLE_PERMISSIONS[roleName]);
}
Object.freeze(ROLE_PERMISSIONS);
