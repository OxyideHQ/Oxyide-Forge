import type { FastifyRequest } from 'fastify';

import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';
import { AUTH_FORBIDDEN_DETAIL } from '../../../shared/errors/error-mapper.js';
import {
  logSecurityDecision,
  SecurityDecisionReason,
  SecurityEventName,
} from '../authorization-logger.js';
import { authorizationService } from '../services/authorization.service.js';

/**
 * Authorization guard — checks whether the authenticated user has a specific role.
 *
 * Must be used after `requireAuth` or `app.authenticate` has already run,
 * which sets `request.auth`.
 *
 * Throws 401 if the request is not authenticated.
 * Throws 403 if the user lacks the required role.
 * (M6.2: failures throw AppError for the centralized mapper; the public
 * bodies and the M4.7 security events are preserved verbatim.)
 *
 * Use as a preHandler:
 * ```ts
 * fastify.delete('/admin/users', {
 *   preHandler: [requireAuth, requireRole('admin')],
 * }, handler);
 * ```
 */
export function requireRole(role: string) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.auth) {
      throw new AppError(
        ErrorCodes.AUTH_INVALID_TOKEN,
        401,
        'Authentication credentials were not provided or are invalid.',
        { title: 'Unauthorized' },
      );
    }

    const result = await authorizationService.hasRole(request.auth, role);

    if (!result.granted) {
      // Observational only (M4.7): the required role is a server-side guard
      // argument, never request input. The denial reason (`result.reason`)
      // stays here for operators only — the public body never carries role
      // or permission vocabulary (M6.8).
      logSecurityDecision(request.log, {
        event: SecurityEventName.AUTHORIZATION_DECISION,
        decision: 'deny',
        reason: SecurityDecisionReason.ROLE_DENIED,
        subjectId: request.auth.sub,
        role,
      });
      throw new AppError(ErrorCodes.AUTH_FORBIDDEN, 403, AUTH_FORBIDDEN_DETAIL, {
        title: 'Forbidden',
      });
    }
  };
}
