import type { AuthContext } from '../../../types/auth-context.js';
import { usersService } from '../../users/users.service.js';

import type { Permission } from '../roles.js';
import { Roles, ROLE_PERMISSIONS, type RoleName } from '../roles.js';

/**
 * Result of an authorization check.
 * `granted` is true when the action is permitted.
 * `reason` provides a human-readable explanation for logging.
 */
export type AuthorizationResult = {
  granted: boolean;
  reason: string;
};

/**
 * Checks whether the authenticated user has a specific permission.
 *
 * Steps:
 * 1. Look up the user's role from the database.
 * 2. If the user does not exist, deny.
 * 3. Look up the permissions granted to the user's role.
 * 4. Check whether the required permission is in the set.
 *
 * This function never trusts client-supplied data.
 * All authorization decisions derive from the server-side role lookup.
 */
async function can(
  authContext: AuthContext,
  permission: Permission,
): Promise<AuthorizationResult> {
  const role = await usersService.findRoleById(authContext.sub);

  if (!role) {
    return { granted: false, reason: 'User not found.' };
  }

  const roleName = role as RoleName;
  const grantedPermissions = ROLE_PERMISSIONS[roleName];

  if (!grantedPermissions) {
    return { granted: false, reason: `Unknown role: ${roleName}.` };
  }

  const hasPermission = grantedPermissions.includes(permission);

  return hasPermission
    ? { granted: true, reason: 'Permission granted.' }
    : { granted: false, reason: `Role '${roleName}' does not have permission '${permission}'.` };
}

/**
 * Checks whether the authenticated user has a specific role.
 *
 * Steps:
 * 1. Look up the user's role from the database.
 * 2. If the user does not exist, deny.
 * 3. Compare the user's role to the required role.
 */
async function hasRole(
  authContext: AuthContext,
  requiredRole: string,
): Promise<AuthorizationResult> {
  const role = await usersService.findRoleById(authContext.sub);

  if (!role) {
    return { granted: false, reason: 'User not found.' };
  }

  return role === requiredRole
    ? { granted: true, reason: 'Role match.' }
    : { granted: false, reason: `Required role '${requiredRole}', user has '${role}'.` };
}

/**
 * Returns the permissions granted to a given role.
 * Returns an empty array for unknown roles.
 */
function getPermissionsForRole(role: string): readonly Permission[] {
  const roleName = role as RoleName;
  return ROLE_PERMISSIONS[roleName] ?? [];
}

/**
 * Returns the built-in role names.
 */
function getRoles(): readonly string[] {
  return Object.values(Roles);
}

export const authorizationService = {
  can,
  hasRole,
  getPermissionsForRole,
  getRoles,
};
