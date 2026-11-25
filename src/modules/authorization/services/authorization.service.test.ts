import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthContext } from '../../../types/auth-context.js';

const mockFindRoleById = vi.fn();

vi.mock('../../users/users.service.js', () => ({
  usersService: {
    findRoleById: mockFindRoleById,
  },
}));

const { authorizationService } = await import('./authorization.service.js');
const { Roles, ROLE_PERMISSIONS } = await import('../roles.js');
const { UserPermissions } = await import('../permissions/user.permissions.js');
const { RolePermissions } = await import('../permissions/role.permissions.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authorizationService', () => {
  const userAuth: AuthContext = { sub: 'user-1', iat: 1000, exp: 2000 };
  const adminAuth: AuthContext = { sub: 'admin-1', iat: 1000, exp: 2000 };

  describe('can', () => {
    it('grants permission when user role has the permission', async () => {
      mockFindRoleById.mockResolvedValueOnce('user');

      const result = await authorizationService.can(userAuth, UserPermissions.READ_SELF);

      expect(result.granted).toBe(true);
      expect(mockFindRoleById).toHaveBeenCalledWith('user-1');
    });

    it('denies permission when user role lacks the permission', async () => {
      mockFindRoleById.mockResolvedValueOnce('user');

      const result = await authorizationService.can(userAuth, UserPermissions.DELETE);

      expect(result.granted).toBe(false);
      expect(result.reason).toContain('does not have permission');
    });

    it('grants all permissions to admin role', async () => {
      mockFindRoleById.mockResolvedValue('admin');

      const allPermissions = [
        ...Object.values(UserPermissions),
        ...Object.values(RolePermissions),
      ];

      for (const permission of allPermissions) {
        const result = await authorizationService.can(adminAuth, permission);
        expect(result.granted).toBe(true);
      }
    });

    it('denies when user is not found', async () => {
      mockFindRoleById.mockResolvedValueOnce(null);

      const result = await authorizationService.can(userAuth, UserPermissions.READ_SELF);

      expect(result.granted).toBe(false);
      expect(result.reason).toBe('User not found.');
    });

    it('denies when role is unknown', async () => {
      mockFindRoleById.mockResolvedValueOnce('unknown-role');

      const result = await authorizationService.can(userAuth, UserPermissions.READ_SELF);

      expect(result.granted).toBe(false);
      expect(result.reason).toContain('Unknown role');
    });

    it('denies case and whitespace role variants without normalization (M42-INV-006/012)', async () => {
      for (const role of ['ADMIN', 'Admin', ' admin', 'admin ', '', 'user,admin', 'admin,user', '["admin"]', 'user admin']) {
        mockFindRoleById.mockResolvedValueOnce(role);

        const result = await authorizationService.can(userAuth, UserPermissions.DELETE);

        expect(result.granted).toBe(false);
      }
    });
  });

  describe('hasRole', () => {
    it('grants when user has the required role', async () => {
      mockFindRoleById.mockResolvedValueOnce('user');

      const result = await authorizationService.hasRole(userAuth, 'user');

      expect(result.granted).toBe(true);
    });

    it('denies when user lacks the required role', async () => {
      mockFindRoleById.mockResolvedValueOnce('user');

      const result = await authorizationService.hasRole(userAuth, 'admin');

      expect(result.granted).toBe(false);
      expect(result.reason).toContain("Required role 'admin'");
      expect(result.reason).toContain("user has 'user'");
    });

    it('denies when user is not found', async () => {
      mockFindRoleById.mockResolvedValueOnce(null);

      const result = await authorizationService.hasRole(userAuth, 'user');

      expect(result.granted).toBe(false);
      expect(result.reason).toBe('User not found.');
    });
  });

  describe('getPermissionsForRole', () => {
    it('returns permissions for user role', () => {
      const permissions = authorizationService.getPermissionsForRole(Roles.USER);
      expect(permissions).toEqual(ROLE_PERMISSIONS[Roles.USER]);
    });

    it('returns permissions for admin role', () => {
      const permissions = authorizationService.getPermissionsForRole(Roles.ADMIN);
      expect(permissions).toEqual(ROLE_PERMISSIONS[Roles.ADMIN]);
    });

    it('returns empty array for unknown role', () => {
      const permissions = authorizationService.getPermissionsForRole('nonexistent');
      expect(permissions).toEqual([]);
    });
  });

  describe('getRoles', () => {
    it('returns all built-in role names', () => {
      const roles = authorizationService.getRoles();
      expect(roles).toContain('user');
      expect(roles).toContain('admin');
    });
  });
});
