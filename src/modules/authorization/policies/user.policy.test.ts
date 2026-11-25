import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthContext } from '../../../types/auth-context.js';

const mockCan = vi.fn();

vi.mock('../services/authorization.service.js', () => ({
  authorizationService: {
    can: mockCan,
  },
}));

const { userPolicy } = await import('./user.policy.js');

/**
 * M4.3 — userPolicy contract tests.
 *
 * Proves the policy abstraction boundary directly ( beneath the mocked
 * route layer): self-access short-circuits without any service call
 * (pure, deterministic), non-self access delegates to the permission
 * mapping exactly once, self-deletion is banned without side effects, and
 * decisions derive from server-side identity only. No HTTP, no Prisma, no
 * transactions involved.
 */
describe('userPolicy', () => {
  const selfAuth: AuthContext = { sub: 'user-1', iat: 1000, exp: 2000 };
  const otherAuth: AuthContext = { sub: 'user-2', iat: 1000, exp: 2000 };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('canReadUser', () => {
    it('allows self-read without consulting the permission mapping', async () => {
      await expect(userPolicy.canReadUser(selfAuth, 'user-1')).resolves.toBe(true);
      expect(mockCan).not.toHaveBeenCalled();
    });

    it('delegates non-self reads to the permission mapping exactly once', async () => {
      mockCan.mockResolvedValueOnce({ granted: true, reason: 'Permission granted.' });

      await expect(userPolicy.canReadUser(otherAuth, 'user-1')).resolves.toBe(true);
      expect(mockCan).toHaveBeenCalledTimes(1);
      expect(mockCan).toHaveBeenCalledWith(otherAuth, 'users:read');
    });

    it('propagates mapping denial for non-self reads', async () => {
      mockCan.mockResolvedValueOnce({ granted: false, reason: 'Denied.' });

      await expect(userPolicy.canReadUser(otherAuth, 'user-1')).resolves.toBe(false);
    });
  });

  describe('canUpdateUser', () => {
    it('allows self-update without consulting the permission mapping', async () => {
      await expect(userPolicy.canUpdateUser(selfAuth, 'user-1')).resolves.toBe(true);
      expect(mockCan).not.toHaveBeenCalled();
    });

    it('delegates non-self updates to the permission mapping exactly once', async () => {
      mockCan.mockResolvedValueOnce({ granted: true, reason: 'Permission granted.' });

      await expect(userPolicy.canUpdateUser(otherAuth, 'user-1')).resolves.toBe(true);
      expect(mockCan).toHaveBeenCalledTimes(1);
      expect(mockCan).toHaveBeenCalledWith(otherAuth, 'users:update');
    });
  });

  describe('canDeleteUser', () => {
    it('bans self-deletion without consulting the permission mapping', async () => {
      await expect(userPolicy.canDeleteUser(selfAuth, 'user-1')).resolves.toBe(false);
      expect(mockCan).not.toHaveBeenCalled();
    });

    it('delegates non-self deletes to the permission mapping exactly once', async () => {
      mockCan.mockResolvedValueOnce({ granted: true, reason: 'Permission granted.' });

      await expect(userPolicy.canDeleteUser(otherAuth, 'user-1')).resolves.toBe(true);
      expect(mockCan).toHaveBeenCalledTimes(1);
      expect(mockCan).toHaveBeenCalledWith(otherAuth, 'users:delete');
    });
  });

  describe('determinism', () => {
    it('returns identical decisions for equivalent trusted inputs', async () => {
      mockCan.mockResolvedValue({ granted: true, reason: 'Permission granted.' });

      const first = await userPolicy.canUpdateUser(otherAuth, 'user-1');
      const second = await userPolicy.canUpdateUser({ ...otherAuth }, 'user-1');

      expect(first).toBe(second);
      expect(mockCan).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalid identity fail-closed (M4.4)', () => {
    it.each([
      ['null target', null],
      ['undefined target', undefined],
      ['empty target', ''],
      ['numeric target', 42],
      ['object target', { id: 'user-1' }],
    ])('denies %s without consulting the permission mapping', async (_label, target) => {
      await expect(
        userPolicy.canReadUser(selfAuth, target as unknown as string),
      ).resolves.toBe(false);
      await expect(
        userPolicy.canUpdateUser(selfAuth, target as unknown as string),
      ).resolves.toBe(false);
      await expect(
        userPolicy.canDeleteUser(otherAuth, target as unknown as string),
      ).resolves.toBe(false);
      expect(mockCan).not.toHaveBeenCalled();
    });

    it.each([[null], [undefined]])(
      'denies %s actor identity without consulting the mapping',
      async (sub) => {
        const forged = { sub, iat: 1000, exp: 2000 } as unknown as AuthContext;
        await expect(userPolicy.canReadUser(forged, 'user-1')).resolves.toBe(false);
        expect(mockCan).not.toHaveBeenCalled();
      },
    );

    it('never grants on undefined === undefined self-comparison', async () => {
      const forged = { sub: undefined, iat: 1000, exp: 2000 } as unknown as AuthContext;
      await expect(
        userPolicy.canReadUser(forged, undefined as unknown as string),
      ).resolves.toBe(false);
      expect(mockCan).not.toHaveBeenCalled();
    });

    it.each([[['USER-1']], [[' user-1']], [['user-1 ']]])(
      'denies %j as non-self without normalization',
      async (target) => {
        mockCan.mockResolvedValue({ granted: false, reason: 'Denied.' });
        await expect(userPolicy.canReadUser(selfAuth, target[0])).resolves.toBe(false);
        // Not short-circuited as self: the mapping decides.
        expect(mockCan).toHaveBeenCalledTimes(1);
      },
    );
  });
});
