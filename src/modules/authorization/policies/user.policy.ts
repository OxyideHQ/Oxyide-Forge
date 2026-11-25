import type { AuthContext } from '../../../types/auth-context.js';

import { UserPermissions } from '../permissions/user.permissions.js';
import { authorizationService } from '../services/authorization.service.js';

/**
 * User policy: determines whether an authenticated user can perform user actions.
 *
 * Policies are deterministic, independently testable, and do not contain
 * HTTP-specific logic. They consume AuthContext and delegate to the
 * authorization service for permission evaluation.
 */

/**
 * Fail-closed identity validation (M4.4): route params are untrusted input,
 * and direct misuse must never produce an accidental grant — in particular,
 * `undefined === undefined` must never read as self-access. Non-string or
 * empty identities deny before any other logic runs.
 */
function isUsableIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export async function canReadUser(
  authContext: AuthContext,
  targetUserId: string,
): Promise<boolean> {
  if (!isUsableIdentity(authContext?.sub) || !isUsableIdentity(targetUserId)) {
    return false;
  }
  // Self-read is always allowed
  if (authContext.sub === targetUserId) {
    return true;
  }

  const result = await authorizationService.can(authContext, UserPermissions.READ);
  return result.granted;
}

export async function canUpdateUser(
  authContext: AuthContext,
  targetUserId: string,
): Promise<boolean> {
  if (!isUsableIdentity(authContext?.sub) || !isUsableIdentity(targetUserId)) {
    return false;
  }
  // Self-update is always allowed
  if (authContext.sub === targetUserId) {
    return true;
  }

  const result = await authorizationService.can(authContext, UserPermissions.UPDATE);
  return result.granted;
}

export async function canDeleteUser(
  authContext: AuthContext,
  targetUserId: string,
): Promise<boolean> {
  if (!isUsableIdentity(authContext?.sub) || !isUsableIdentity(targetUserId)) {
    return false;
  }
  // Self-deletion is not allowed via this policy
  if (authContext.sub === targetUserId) {
    return false;
  }

  const result = await authorizationService.can(authContext, UserPermissions.DELETE);
  return result.granted;
}

export const userPolicy = {
  canReadUser,
  canUpdateUser,
  canDeleteUser,
};
