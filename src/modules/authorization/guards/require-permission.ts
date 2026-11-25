import type { FastifyRequest } from 'fastify';

import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';
import { AUTH_FORBIDDEN_DETAIL } from '../../../shared/errors/error-mapper.js';
import {
  logSecurityDecision,
  SecurityDecisionReason,
  SecurityEventName,
} from '../authorization-logger.js';
import type { Permission } from '../roles.js';
import { authorizationService } from '../services/authorization.service.js';

/**
 * Authorization guard — checks whether the authenticated user has a specific permission.
 *
 * Must be used after `requireAuth` or `app.authenticate` has already run,
 * which sets `request.auth`.
 *
 * Throws 401 if the request is not authenticated.
 * Throws 403 if the user lacks the required permission.
 * (M6.2: failures throw AppError for the centralized mapper; the public
 * bodies and the M4.7 security events are preserved verbatim.)
 *
 * Use as a preHandler:
 * ```ts
 * fastify.delete('/users/:id', {
 *   preHandler: [requireAuth, requirePermission('users:delete')],
 * }, handler);
 * ```
 */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.auth) {
      throw new AppError(
        ErrorCodes.AUTH_INVALID_TOKEN,
        401,
        'Authentication credentials were not provided or are invalid.',
        { title: 'Unauthorized' },
      );
    }

    const result = await authorizationService.can(request.auth, permission);

    if (!result.granted) {
      // Observational only: the decision is made; this records it once for
      // operators. Only server-side values enter the event (M4.7). The
      // denial reason (`result.reason`) stays here for operators only —
      // the public body never carries role or permission vocabulary (M6.8).
      logSecurityDecision(request.log, {
        event: SecurityEventName.AUTHORIZATION_DECISION,
        decision: 'deny',
        reason: SecurityDecisionReason.PERMISSION_DENIED,
        subjectId: request.auth.sub,
        permission,
        resource: permissionResource(permission),
      });
      throw new AppError(ErrorCodes.AUTH_FORBIDDEN, 403, AUTH_FORBIDDEN_DETAIL, {
        title: 'Forbidden',
      });
    }
  };
}

/**
 * Derives the stable resource name from a canonical `domain:action`
 * permission. The permission constants are the closed vocabulary, so the
 * domain half is server-controlled; unknown shapes fall back to the raw
 * domain rather than trusting structure.
 */
function permissionResource(permission: Permission): string {
  const domain = permission.split(':')[0];
  if (domain === 'users') {
    return 'user';
  }
  if (domain === 'roles') {
    return 'role';
  }
  return domain;
}
