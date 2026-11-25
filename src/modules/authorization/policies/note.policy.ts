import type { AuthContext } from '../../../types/auth-context.js';

/**
 * Note policy — owner-only access (M7.9). Minimal consistent extension of
 * the policy layer, mirroring the shape and fail-closed identity check of
 * `userPolicy`. Deterministic, no HTTP, no persistence: it answers one
 * question from two inputs (the authenticated principal and the resource
 * owner) and never invents access from anything else.
 *
 * Ownership is the whole policy for notes: there is no shared-admission
 * or admin-read-override path. If that changes, it changes here — one
 * place, reviewed — never implicit in the routes.
 */
function isUsableIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export async function canAccessNote(
  authContext: AuthContext,
  ownerId: string,
): Promise<boolean> {
  if (!isUsableIdentity(authContext?.sub) || !isUsableIdentity(ownerId)) {
    return false;
  }
  return authContext.sub === ownerId;
}

export const notePolicy = {
  canAccessNote,
};
