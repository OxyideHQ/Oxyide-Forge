import type { FastifyInstance, FastifySchema } from 'fastify';

import { usersService } from '../users.service.js';
import { toPublicUser } from '../user-response.js';
import {
  logSecurityDecision,
  SecurityDecisionReason,
  SecurityEventName,
} from '../../authorization/authorization-logger.js';
import { userPolicy } from '../../authorization/policies/user.policy.js';
import { requireAuth } from '../../authorization/guards/require-auth.js';
import { requirePermission } from '../../authorization/guards/require-permission.js';
import { UserPermissions } from '../../authorization/permissions/user.permissions.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { PUBLIC_USER_JSON_SCHEMA } from '../user-response.js';
import type { AuthContext } from '../../../types/auth-context.js';

// --- Validation schemas ---

const userIdParamsSchema: FastifySchema = {
  params: {
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: {
      // No maxLength here by design (M5.3): the explicit maxParamLength
      // transport cap (100 chars) already rejects oversized identifiers at
      // routing time, well above the 36-character UUID contract. A schema
      // bound at or above 100 would never execute.
      id: { type: 'string' },
    },
  },
  // M7.2: explicit success contract for the GET/PUT routes sharing this
  // schema (same resource, same 200 shape). DELETE reuses only the params
  // validation — its 204 carries no body, so no response serialization runs.
  response: {
    200: { ...PUBLIC_USER_JSON_SCHEMA, description: 'Public user representation.' },
  },
};

const updateUserSchema: FastifySchema = {
  // Inherits `params` and the 200 PublicUser response contract from
  // userIdParamsSchema above (same resource, same shape).
  ...userIdParamsSchema,
  body: {
    type: 'object',
    required: [],
    additionalProperties: false,
    properties: {
      displayName: { type: ['string', 'null'], maxLength: 100 },
      status: { type: 'string', enum: ['active', 'inactive', 'suspended'] },
    },
  },
};

/**
 * Registers user routes under /api/v1/users.
 *
 * Routes:
 *   GET    /api/v1/users/:id   — Read a user by ID
 *   PUT    /api/v1/users/:id   — Update a user by ID
 *   DELETE /api/v1/users/:id   — Delete a user by ID
 */
export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/users/:id
  app.get(
    '/api/v1/users/:id',
    {
      schema: {
        ...userIdParamsSchema,
        tags: ['Users'],
        summary: 'Read a user by ID',
        description:
          'Returns the public user for self-reads or callers with users:read. Other users denied (403); missing users 404.',
        operationId: 'getUserById',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
const { id } = request.params as { id: string };
const authContext = request.auth as AuthContext;

// Authorization: self or users:read
const allowed = await userPolicy.canReadUser(authContext, id);
if (!allowed) {
  // Observational only (M4.7): policy-denied reads are ownership
  // denials — the policy is the ownership policy. Server-side values
  // only; the decision stands regardless of logging.
  logSecurityDecision(request.log, {
    event: SecurityEventName.AUTHORIZATION_DECISION,
    decision: 'deny',
    reason: SecurityDecisionReason.OWNERSHIP_DENIED,
    subjectId: authContext.sub,
    permission: UserPermissions.READ,
    resource: 'user',
    targetId: id,
  });
  throw new AppError(ErrorCodes.AUTH_FORBIDDEN, 403, 'You do not have permission to read this user.', {
    title: 'Forbidden',
  });
}

const user = await usersService.findById(id);
if (!user) {
  throw new AppError(ErrorCodes.USERS_NOT_FOUND, 404, 'User not found.');
}

if (authContext.sub !== id) {
  // Privileged cross-user read via permission override (M4.7): worth
  // an audit trail. Ordinary self-reads stay silent by design.
  logSecurityDecision(request.log, {
    event: SecurityEventName.AUTHORIZATION_DECISION,
    decision: 'allow',
    reason: SecurityDecisionReason.PERMISSION_OVERRIDE,
    subjectId: authContext.sub,
    permission: UserPermissions.READ,
    resource: 'user',
    targetId: id,
  });
}

return reply.status(200).send(toPublicUser(user));
    },
  );

  // PUT /api/v1/users/:id
  app.put(
    '/api/v1/users/:id',
    {
      schema: {
        ...updateUserSchema,
        tags: ['Users'],
        summary: 'Update a user by ID',
        description:
          'Updates displayName (self or users:update) and returns the public user. Only admins may change status; self-updates silently ignore it.',
        operationId: 'updateUser',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
const { id } = request.params as { id: string };
const body = request.body as { displayName?: string | null; status?: string };
const authContext = request.auth as AuthContext;

// Authorization: self or users:update
const allowed = await userPolicy.canUpdateUser(authContext, id);
if (!allowed) {
  logSecurityDecision(request.log, {
    event: SecurityEventName.AUTHORIZATION_DECISION,
    decision: 'deny',
    reason: SecurityDecisionReason.OWNERSHIP_DENIED,
    subjectId: authContext.sub,
    permission: UserPermissions.UPDATE,
    resource: 'user',
    targetId: id,
  });
  throw new AppError(
    ErrorCodes.AUTH_FORBIDDEN,
    403,
    'You do not have permission to update this user.',
    { title: 'Forbidden' },
  );
}

if (authContext.sub !== id) {
  logSecurityDecision(request.log, {
    event: SecurityEventName.AUTHORIZATION_DECISION,
    decision: 'allow',
    reason: SecurityDecisionReason.PERMISSION_OVERRIDE,
    subjectId: authContext.sub,
    permission: UserPermissions.UPDATE,
    resource: 'user',
    targetId: id,
  });
}

// Build update input: only provided fields
const updateInput: { displayName?: string | null; status?: string } = {};
if ('displayName' in body) {
  updateInput.displayName = body.displayName;
}
if ('status' in body) {
  // Only admins can update status
  if (authContext.sub === id) {
    // Self-update: silently ignore status field
  } else {
    updateInput.status = body.status;
  }
}

// Skip update if nothing to change
if (Object.keys(updateInput).length === 0) {
  const user = await usersService.findById(id);
  if (!user) {
    throw new AppError(ErrorCodes.USERS_NOT_FOUND, 404, 'User not found.');
  }
  return reply.status(200).send(toPublicUser(user));
}

const updated = await usersService.update(id, updateInput);
if (!updated) {
  throw new AppError(ErrorCodes.USERS_NOT_FOUND, 404, 'User not found.');
}

return reply.status(200).send(toPublicUser(updated));
    },
  );

  // DELETE /api/v1/users/:id
  app.delete(
    '/api/v1/users/:id',
    {
      schema: {
        ...userIdParamsSchema,
        tags: ['Users'],
        summary: 'Delete a user by ID',
        description:
          'Requires users:delete; self-deletion is always denied (403). Only admins reach this operation.',
        operationId: 'deleteUser',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth, requirePermission(UserPermissions.DELETE)],
    },
    async (request, reply) => {
const { id } = request.params as { id: string };
const authContext = request.auth as AuthContext;

// Authorization: not self (self-deletion is banned) and
// users:delete permission, via the centralized user policy —
// the rule lives in exactly one place (M4.3).
const allowed = await userPolicy.canDeleteUser(authContext, id);
if (!allowed) {
  // Reachable only as self-deletion here: requireAuth guarantees a
  // live subject and the guard guarantees the delete permission
  // (M4.7). Observational only.
  logSecurityDecision(request.log, {
    event: SecurityEventName.AUTHORIZATION_DECISION,
    decision: 'deny',
    reason: SecurityDecisionReason.SELF_DELETE_FORBIDDEN,
    subjectId: authContext.sub,
    permission: UserPermissions.DELETE,
    resource: 'user',
    targetId: id,
  });
  throw new AppError(ErrorCodes.AUTH_FORBIDDEN, 403, 'You cannot delete your own account.', {
    title: 'Forbidden',
  });
}

// Every allowed delete is a privileged cross-user delete
// (self-deletion is banned above) — always audit-trailed (M4.7).
logSecurityDecision(request.log, {
  event: SecurityEventName.AUTHORIZATION_DECISION,
  decision: 'allow',
  reason: SecurityDecisionReason.PERMISSION_OVERRIDE,
  subjectId: authContext.sub,
  permission: UserPermissions.DELETE,
  resource: 'user',
  targetId: id,
});

const deleted = await usersService.remove(id);
if (!deleted) {
  throw new AppError(ErrorCodes.USERS_NOT_FOUND, 404, 'User not found.');
}

return reply.status(204).send();
    },
  );
}
