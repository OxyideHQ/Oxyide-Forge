// Permissions
export { AuthPermissions, type AuthPermission } from './permissions/auth.permissions.js';
export { UserPermissions, type UserPermission } from './permissions/user.permissions.js';
export { RolePermissions, type RolePermission } from './permissions/role.permissions.js';

// Roles
export { Roles, ROLE_PERMISSIONS, type RoleName, type Permission } from './roles.js';

// Authorization service
export { authorizationService, type AuthorizationResult } from './services/authorization.service.js';

// Policies
export { userPolicy } from './policies/user.policy.js';

// Guards
export { requireAuth } from './guards/require-auth.js';
export { requirePermission } from './guards/require-permission.js';
export { requireRole } from './guards/require-role.js';
