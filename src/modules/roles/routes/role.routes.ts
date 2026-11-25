import type { FastifyInstance, FastifySchema } from 'fastify';

import { authorizationService } from '../../authorization/services/authorization.service.js';
import { requireAuth } from '../../authorization/guards/require-auth.js';
import { requirePermission } from '../../authorization/guards/require-permission.js';
import { RolePermissions } from '../../authorization/permissions/role.permissions.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';
import { AppError } from '../../../shared/errors/app-error.js';

// --- Validation schemas ---

/**
 * Public role shape (M7.2): static code data, not a database model.
 * Permissions are the established `domain:action` vocabulary already
 * returned by these endpoints — explicitly schemed, not redesigned.
 * Exported (not just route-local) so tests and the future OpenAPI
 * assembler (M7.6) reference the same const the route serves.
 */
export const roleResponseSchema = {
  type: 'object',
  required: ['name', 'permissions'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    permissions: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const roleListResponseSchema = {
  type: 'object',
  required: ['roles'],
  additionalProperties: false,
  properties: {
    roles: { type: 'array', items: roleResponseSchema },
  },
} as const;

const roleNameParamsSchema: FastifySchema = {
  params: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      // No maxLength here by design (M5.3): see userIdParamsSchema. The
      // handler allowlist remains authoritative for role names.
      name: { type: 'string' },
    },
  },
};

/**
 * Registers role routes under /api/v1/roles.
 *
 * Routes:
 *   GET /api/v1/roles          — List built-in roles
 *   GET /api/v1/roles/:name    — Get a role and its permissions
 *
 * All roles are static (defined in code). There is no CRUD for roles in V1.
 */
export async function registerRoleRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/roles
  app.get(
    '/api/v1/roles',
    {
      preHandler: [requireAuth, requirePermission(RolePermissions.READ)],
      schema: {
        response: { 200: { ...roleListResponseSchema, description: 'All built-in roles.' } },
        tags: ['Roles'],
        summary: 'List built-in roles',
        description:
          'Returns all static roles with their permission vocabularies. Requires roles:read. Roles are code-defined; no role administration exists in V1.',
        operationId: 'listRoles',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request, reply) => {
      const roleNames = authorizationService.getRoles();

      const roles = roleNames.map((name) => ({
        name,
        permissions: authorizationService.getPermissionsForRole(name),
      }));

      return reply.status(200).send({ roles });
    },
  );

  // GET /api/v1/roles/:name
  app.get(
    '/api/v1/roles/:name',
    {
      schema: {
        ...roleNameParamsSchema,
        response: { 200: { ...roleResponseSchema, description: 'Requested role.' } },
        tags: ['Roles'],
        summary: 'Get a role by name',
        description:
          'Returns one static role with its permission vocabulary, or 404 for unknown names. Requires roles:read.',
        operationId: 'getRoleByName',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth, requirePermission(RolePermissions.READ)],
    },
    async (request, reply) => {
const { name } = request.params as { name: string };

// Validate that the role name is a known built-in role
const knownRoles = authorizationService.getRoles();
if (!knownRoles.includes(name)) {
  throw new AppError(ErrorCodes.ROLES_NOT_FOUND, 404, 'Role not found.');
}

const permissions = authorizationService.getPermissionsForRole(name);

return reply.status(200).send({
  name,
  permissions,
});
    },
  );
}
