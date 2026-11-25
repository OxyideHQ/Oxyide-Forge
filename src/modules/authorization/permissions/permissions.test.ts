import { describe, expect, it } from 'vitest';

import { AuthPermissions } from './auth.permissions.js';
import { UserPermissions } from './user.permissions.js';
import { RolePermissions } from './role.permissions.js';

describe('AuthPermissions', () => {
  it('defines LOGIN permission', () => {
    expect(AuthPermissions.LOGIN).toBe('auth:login');
  });

  it('defines LOGOUT permission', () => {
    expect(AuthPermissions.LOGOUT).toBe('auth:logout');
  });

  it('has exactly 2 permissions', () => {
    expect(Object.keys(AuthPermissions)).toHaveLength(2);
  });

  it('has no auth:register permission — registration is pre-auth by design', () => {
    // Public registration cannot be gated behind an RBAC permission: the
    // registrant has no authenticated subject/role yet. auth:register was
    // therefore removed as "dead by construction" (M4.2); registration is
    // protected by rate/abuse throttling at the route, not by a permission.
    // This guards against re-introducing the dead permission.
    expect(AuthPermissions).not.toHaveProperty('REGISTER');
    expect(Object.values(AuthPermissions)).not.toContain('auth:register');
  });
});

describe('UserPermissions', () => {
  it('defines READ permission', () => {
    expect(UserPermissions.READ).toBe('users:read');
  });

  it('defines READ_SELF permission', () => {
    expect(UserPermissions.READ_SELF).toBe('users:read:self');
  });

  it('defines UPDATE permission', () => {
    expect(UserPermissions.UPDATE).toBe('users:update');
  });

  it('defines UPDATE_SELF permission', () => {
    expect(UserPermissions.UPDATE_SELF).toBe('users:update:self');
  });

  it('defines DELETE permission', () => {
    expect(UserPermissions.DELETE).toBe('users:delete');
  });

  it('has exactly 5 permissions', () => {
    expect(Object.keys(UserPermissions)).toHaveLength(5);
  });
});

describe('RolePermissions', () => {
  it('defines READ permission', () => {
    expect(RolePermissions.READ).toBe('roles:read');
  });

  it('defines CREATE permission', () => {
    expect(RolePermissions.CREATE).toBe('roles:create');
  });

  it('defines UPDATE permission', () => {
    expect(RolePermissions.UPDATE).toBe('roles:update');
  });

  it('defines DELETE permission', () => {
    expect(RolePermissions.DELETE).toBe('roles:delete');
  });

  it('has exactly 4 permissions', () => {
    expect(Object.keys(RolePermissions)).toHaveLength(4);
  });
});

describe('permission format', () => {
  it('all permissions follow domain:action format', () => {
    const allPermissions = [
      ...Object.values(AuthPermissions),
      ...Object.values(UserPermissions),
      ...Object.values(RolePermissions),
    ];

    for (const permission of allPermissions) {
      expect(permission).toMatch(/^[a-z]+:[a-z:]+$/);
    }
  });

  it('all permissions are unique', () => {
    const allPermissions = [
      ...Object.values(AuthPermissions),
      ...Object.values(UserPermissions),
      ...Object.values(RolePermissions),
    ];

    const unique = new Set(allPermissions);
    expect(unique.size).toBe(allPermissions.length);
  });

  it('the complete vocabulary is exactly the 11 supported permissions', () => {
    // Proves the full intended contract rather than a per-domain count: any
    // added or removed permission fails this, and a dangling `auth:register`
    // cannot slip back in.
    const allPermissions = [
      ...Object.values(AuthPermissions),
      ...Object.values(UserPermissions),
      ...Object.values(RolePermissions),
    ].sort();
    expect(allPermissions).toEqual(
      [
        'auth:login',
        'auth:logout',
        'users:read',
        'users:read:self',
        'users:update',
        'users:update:self',
        'users:delete',
        'roles:read',
        'roles:create',
        'roles:update',
        'roles:delete',
      ].sort(),
    );
  });
});
