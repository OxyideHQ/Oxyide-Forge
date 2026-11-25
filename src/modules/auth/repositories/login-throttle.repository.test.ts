import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrismaLoginThrottle = {
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  upsert: vi.fn(),
};

vi.mock('../../../platform/database/prisma.js', () => ({
  prisma: {
    loginThrottle: mockPrismaLoginThrottle,
  },
}));

const { findByKey, recordFailure, clearByKey, deleteExpired, loginThrottleRepository } =
  await import('./login-throttle.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loginThrottleRepository', () => {
  const mockRow = {
    key: 'auth:login:v1:account:deadbeef',
    failureCount: 3,
    windowStartedAt: new Date('2026-09-29T10:00:00.000Z'),
    expiresAt: new Date('2026-09-29T10:15:00.000Z'),
    createdAt: new Date('2026-09-29T10:00:00.000Z'),
    updatedAt: new Date('2026-09-29T10:00:00.000Z'),
  };

  describe('findByKey', () => {
    it('returns the domain row for a known key', async () => {
      mockPrismaLoginThrottle.findUnique.mockResolvedValueOnce(mockRow);

      const result = await findByKey(mockRow.key);

      expect(result).toEqual(mockRow);
      expect(mockPrismaLoginThrottle.findUnique).toHaveBeenCalledWith({
        where: { key: mockRow.key },
        select: {
          key: true,
          failureCount: true,
          windowStartedAt: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('returns null for an unknown key', async () => {
      mockPrismaLoginThrottle.findUnique.mockResolvedValueOnce(null);

      expect(await findByKey('auth:login:v1:account:missing')).toBeNull();
    });

    it('propagates unexpected database errors instead of masking an outage', async () => {
      mockPrismaLoginThrottle.findUnique.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(findByKey(mockRow.key)).rejects.toThrow('connection terminated');
    });
  });

  describe('recordFailure', () => {
    const input = {
      key: mockRow.key,
      failureCount: 1,
      windowStartedAt: new Date('2026-09-29T10:00:00.000Z'),
      expiresAt: new Date('2026-09-29T10:15:00.000Z'),
    };

    it('atomically increments a live row with a conditional predicate', async () => {
      mockPrismaLoginThrottle.updateMany.mockResolvedValueOnce({ count: 1 });
      mockPrismaLoginThrottle.findUnique.mockResolvedValueOnce({ ...mockRow, failureCount: 4 });

      const result = await recordFailure(input);

      expect(result.failureCount).toBe(4);
      const predicate = mockPrismaLoginThrottle.updateMany.mock.calls[0][0];
      expect(predicate.where.key).toBe(input.key);
      expect(predicate.where.expiresAt.gt).toBeInstanceOf(Date);
      expect(predicate.data).toEqual({ failureCount: { increment: 1 } });
      expect(mockPrismaLoginThrottle.upsert).not.toHaveBeenCalled();
    });

    it('starts a fresh window when no live row exists', async () => {
      mockPrismaLoginThrottle.updateMany.mockResolvedValueOnce({ count: 0 });
      mockPrismaLoginThrottle.deleteMany.mockResolvedValueOnce({ count: 1 });
      mockPrismaLoginThrottle.upsert.mockResolvedValueOnce({ ...mockRow, failureCount: 1 });

      const result = await recordFailure(input);

      expect(result.failureCount).toBe(1);
      const deletePredicate = mockPrismaLoginThrottle.deleteMany.mock.calls[0][0];
      expect(deletePredicate.where.key).toBe(input.key);
      expect(deletePredicate.where.expiresAt.lte).toBeInstanceOf(Date);
      expect(mockPrismaLoginThrottle.upsert).toHaveBeenCalledWith({
        where: { key: input.key },
        create: {
          key: input.key,
          failureCount: 1,
          windowStartedAt: input.windowStartedAt,
          expiresAt: input.expiresAt,
        },
        update: { failureCount: { increment: 1 } },
        select: expect.anything(),
      });
    });

    it('converges a lost create race without ever raising a unique violation', async () => {
      // A concurrent creator wins between our conditional delete and the
      // upsert: the update branch converges into the winner's live row.
      // No P2002 is possible, so this path is safe inside an explicit
      // transaction (where a unique violation would abort everything).
      mockPrismaLoginThrottle.updateMany.mockResolvedValueOnce({ count: 0 });
      mockPrismaLoginThrottle.deleteMany.mockResolvedValueOnce({ count: 0 });
      mockPrismaLoginThrottle.upsert.mockResolvedValueOnce({ ...mockRow, failureCount: 2 });

      const result = await recordFailure(input);

      expect(result.failureCount).toBe(2);
      expect(mockPrismaLoginThrottle.updateMany).toHaveBeenCalledTimes(1);
      const upsertArgs = mockPrismaLoginThrottle.upsert.mock.calls[0][0];
      expect(upsertArgs.update).toEqual({ failureCount: { increment: 1 } });
    });

    it('propagates upsert errors instead of masking an outage', async () => {
      mockPrismaLoginThrottle.updateMany.mockResolvedValueOnce({ count: 0 });
      mockPrismaLoginThrottle.deleteMany.mockResolvedValueOnce({ count: 0 });
      mockPrismaLoginThrottle.upsert.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(recordFailure(input)).rejects.toThrow('connection terminated');
    });

    it('surfaces a vanishing row instead of fabricating a count', async () => {
      mockPrismaLoginThrottle.updateMany.mockResolvedValueOnce({ count: 1 });
      mockPrismaLoginThrottle.findUnique.mockResolvedValueOnce(null);

      await expect(recordFailure(input)).rejects.toThrow();
    });
  });

  describe('clearByKey', () => {
    it('returns true when a row was removed', async () => {
      mockPrismaLoginThrottle.deleteMany.mockResolvedValueOnce({ count: 1 });

      expect(await clearByKey(mockRow.key)).toBe(true);
      expect(mockPrismaLoginThrottle.deleteMany).toHaveBeenCalledWith({
        where: { key: mockRow.key },
      });
    });

    it('returns false when no row exists', async () => {
      mockPrismaLoginThrottle.deleteMany.mockResolvedValueOnce({ count: 0 });

      expect(await clearByKey('auth:login:v1:account:missing')).toBe(false);
    });
  });

  describe('deleteExpired', () => {
    it('removes only expired rows and reports the count', async () => {
      mockPrismaLoginThrottle.deleteMany.mockResolvedValueOnce({ count: 4 });

      expect(await deleteExpired()).toBe(4);
      const predicate = mockPrismaLoginThrottle.deleteMany.mock.calls[0][0];
      expect(predicate.where.expiresAt.lte).toBeInstanceOf(Date);
    });
  });

  describe('contract', () => {
    it('exposes the documented repository surface', async () => {
      expect(loginThrottleRepository.findByKey).toBe(findByKey);
      expect(loginThrottleRepository.recordFailure).toBe(recordFailure);
      expect(loginThrottleRepository.clearByKey).toBe(clearByKey);
      expect(loginThrottleRepository.deleteExpired).toBe(deleteExpired);
    });
  });
});
