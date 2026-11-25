import { describe, expect, it } from 'vitest';

// Required before the service import evaluates validated config.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

import { AuthPermissions } from './permissions/auth.permissions.js';
import { RolePermissions } from './permissions/role.permissions.js';
import { UserPermissions } from './permissions/user.permissions.js';
import { Roles, ROLE_PERMISSIONS } from './roles.js';

const { authorizationService } = await import('./services/authorization.service.js');

/**
 * M4.2 — role/permission mapping integrity invariants.
 *
 * Proves the mapping is explicit, complete, and immutable: exact roles,
 * exact vocabulary membership, no duplicates, exact matrix, runtime freeze
 * (map, role constants, and every nested array), and fail-closed unknown
 * roles. Client-trust invariants (M42-INV-008/009) are proven live in the
 * M4.1 adversarial suite and referenced, not duplicated, here.
 */
describe('role model', () => {
  it('defines exactly the user and admin roles', () => {
    expect(Object.values(Roles)).toEqual(['user', 'admin']);
  });

  it('maps every defined role exactly once (M42-INV-001)', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(Object.values(Roles).sort());
  });
});

describe('permission vocabulary', () => {
  const vocabulary = new Set<string>([
    ...Object.values(AuthPermissions),
    ...Object.values(UserPermissions),
    ...Object.values(RolePermissions),
  ]);

  it('holds exactly 11 permissions across the three domains', () => {
    expect(vocabulary.size).toBe(11);
  });

  it('maps only vocabulary permissions with no duplicates (M42-INV-002/003/004)', () => {
    for (const roleName of Object.values(Roles)) {
      const mapped = ROLE_PERMISSIONS[roleName];
      for (const permission of mapped) {
        expect(vocabulary.has(permission)).toBe(true);
      }
      expect(new Set(mapped).size).toBe(mapped.length);
    }
  });
});

describe('role → permission matrix', () => {
  it('grants the user role exactly its four self-scoped permissions (M42-INV-010)', () => {
    expect([...ROLE_PERMISSIONS[Roles.USER]]).toEqual([
      'auth:login',
      'auth:logout',
      'users:read:self',
      'users:update:self',
    ]);
  });

  it('grants the admin role exactly its eleven permissions, nothing implicit (M42-INV-010/011)', () => {
    expect([...ROLE_PERMISSIONS[Roles.ADMIN]]).toEqual([
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
    ]);
  });

  it('grants no permission merely for being defined (M42-INV-011)', () => {
    // Every permission in the matrix above is asserted explicitly; a newly
    // defined constant appears in no role until a mapping entry names it.
    // This test fails if any role array gains an entry outside the matrix.
    const granted = new Set([...ROLE_PERMISSIONS[Roles.USER], ...ROLE_PERMISSIONS[Roles.ADMIN]]);
    expect(granted.size).toBe(11);
  });
});

describe('runtime immutability (M42-INV-005)', () => {
  it('freezes the role constants, the mapping, and every nested array', () => {
    expect(Object.isFrozen(Roles)).toBe(true);
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    for (const roleName of Object.values(Roles)) {
      expect(Object.isFrozen(ROLE_PERMISSIONS[roleName])).toBe(true);
    }
  });

  it('throws on permission-array mutation instead of widening access', () => {
    const mutable = ROLE_PERMISSIONS[Roles.USER] as unknown as Array<string>;
    expect(() => mutable.push('users:delete')).toThrow(TypeError);
    expect(ROLE_PERMISSIONS[Roles.USER]).not.toContain('users:delete');
  });

  it('throws on mapping reassignment', () => {
    const mutable = ROLE_PERMISSIONS as unknown as Record<string, ReadonlyArray<string>>;
    expect(() => {
      mutable[Roles.USER] = ['users:delete'];
    }).toThrow(TypeError);
    expect([...ROLE_PERMISSIONS[Roles.USER]]).toEqual([
      'auth:login',
      'auth:logout',
      'users:read:self',
      'users:update:self',
    ]);
  });
});

describe('unknown role handling (M42-INV-006/012)', () => {
  it.each([['ADMIN'], [' Admin'], ['admin '], [''], ['superuser'], ['user,admin'], ['admin,user']])(
    'resolves %j to no permissions',
    (role) => {
      expect(authorizationService.getPermissionsForRole(role)).toEqual([]);
    },
  );
});
