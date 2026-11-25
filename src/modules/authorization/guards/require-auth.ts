import type { FastifyRequest } from 'fastify';

import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';
import {
  logSecurityDecision,
  SecurityDecisionReason,
  SecurityEventName,
} from '../authorization-logger.js';
import { usersService } from '../../users/users.service.js';

/**
 * Authentication guard — verifies JWT and attaches AuthContext to the request.
 *
 * Delegates to the `authenticate` hook decorated by the auth plugin, then
 * enforces the subject-existence contract (M4.6): authentication means a
 * valid token for a currently existing subject, not merely a valid
 * signature. A cryptographically valid token whose subject no longer exists
 * (deleted account) fails here with 401, coherently with `/me` — downstream
 * guards and policies never observe a missing subject over HTTP.
 *
 * Failures throw `AppError` (M6.2): the centralized mapper builds the
 * public body and the `WWW-Authenticate` header, so this guard constructs
 * no envelopes. The M4.7 security event below is preserved verbatim.
 *
 * Account status is deliberately NOT consulted: suspension semantics belong
 * to login/refresh/recovery (M4.1-F1, owned by a later milestone).
 *
 * Use as a preHandler:
 * ```ts
 * fastify.get('/protected', { preHandler: [requireAuth] }, handler);
 * ```
 */
export async function requireAuth(request: FastifyRequest): Promise<void> {
  // Throws AppError on any authentication failure; success attaches
  // request.auth with no reply side effects.
  await request.server.authenticate(request);

  const subject = request.auth?.sub;
  if (typeof subject !== 'string' || subject.length === 0) {
    throw unauthorized();
  }

  // Fail closed on missing subjects; propagate store failures to the
  // sanitized 500 contract instead of bypassing authentication.
  const user = await usersService.findById(subject);
  if (!user) {
    // A stale credential presented after account deletion: security-relevant
    // authentication-boundary signal (M4.7). No token, cookie, or header
    // enters the event — only the (now-orphaned) subject identifier.
    logSecurityDecision(request.log, {
      event: SecurityEventName.AUTHENTICATION_SUBJECT_INVALID,
      decision: 'deny',
      reason: SecurityDecisionReason.SUBJECT_INVALID,
      subjectId: subject,
    });
    throw unauthorized();
  }
}

function unauthorized(): AppError {
  return new AppError(
    ErrorCodes.AUTH_INVALID_TOKEN,
    401,
    'Authentication credentials were not provided or are invalid.',
    { title: 'Unauthorized' },
  );
}
