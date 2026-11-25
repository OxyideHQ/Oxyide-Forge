import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@prisma/client';

const mockPrismaSession = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
};

const mockPrismaRefreshToken = {
  deleteMany: vi.fn(),
};

vi.mock('../../../platform/database/prisma.js', () => ({
  prisma: {
    session: mockPrismaSession,
    refreshToken: mockPrismaRefreshToken,
  },
}));

const { findById, create, removeByUserId, revokeFamily, revokeAllByUserId, sessionRepository } = await import(
  './session.repository.js'
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sessionRepository', () => {
  const mockRow = {
    id: 's_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
    userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
    expiresAt: new Date('2026-02-15T09:30:00.000Z'),
    revokedAt: null,
    createdAt: new Date('2026-01-15T09:30:00.000Z'),
    updatedAt: new Date('2026-01-15T09:30:00.000Z'),
  };

  describe('findById', () => {
    it('returns a domain Session when a matching record exists', async () => {
      mockPrismaSession.findUnique.mockResolvedValueOnce(mockRow);

      const result = await findById('s_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toEqual(mockRow);
      expect(mockPrismaSession.findUnique).toHaveBeenCalledWith({
        where: { id: 's_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
        select: {
          id: true,
          userId: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('returns null when no session exists for the given ID', async () => {
      mockPrismaSession.findUnique.mockResolvedValueOnce(null);

      const result = await findById('s_nonexistent');

      expect(result).toBeNull();
    });

    it('never selects token material', async () => {
      mockPrismaSession.findUnique.mockResolvedValueOnce(mockRow);

      await findById('s_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      const selectClause = mockPrismaSession.findUnique.mock.calls[0][0].select;
      expect(selectClause).not.toHaveProperty('tokenHash');
      expect(selectClause).not.toHaveProperty('refreshTokens');
    });
  });

  describe('create', () => {
    it('creates a Session and returns the domain representation', async () => {
      mockPrismaSession.create.mockResolvedValueOnce(mockRow);

      const expiresAt = new Date('2026-02-15T09:30:00.000Z');
      const result = await create({
        id: 's_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        expiresAt,
      });

      expect(result).toEqual(mockRow);
      expect(mockPrismaSession.create).toHaveBeenCalledWith({
        data: {
          id: 's_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          expiresAt,
        },
        select: {
          id: true,
          userId: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });
  });

  describe('transaction client support', () => {
    it('uses the provided transaction client instead of the default prisma instance', async () => {
      const mockTxSession = { findUnique: vi.fn().mockResolvedValueOnce(mockRow) };
      const mockTx = { session: mockTxSession } as unknown as Prisma.TransactionClient;

      const result = await findById('s_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', mockTx);

      expect(result).toEqual(mockRow);
      expect(mockTxSession.findUnique).toHaveBeenCalled();
      expect(mockPrismaSession.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('removeByUserId', () => {
    it('deletes instances before sessions and returns the session count', async () => {
      mockPrismaSession.findMany.mockResolvedValueOnce([
        { id: 's_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
      ]);
      mockPrismaRefreshToken.deleteMany.mockResolvedValueOnce({ count: 1 });
      mockPrismaSession.deleteMany.mockResolvedValueOnce({ count: 1 });

      const result = await removeByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(1);
      expect(mockPrismaRefreshToken.deleteMany).toHaveBeenCalledWith({
        where: { sessionId: { in: ['s_01HX9Z6Y7K8Q3V2N4M5P6R7S8T'] } },
      });
      expect(mockPrismaSession.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
      });
      const instanceCalls = mockPrismaRefreshToken.deleteMany.mock.invocationCallOrder[0];
      const sessionCalls = mockPrismaSession.deleteMany.mock.invocationCallOrder[0];
      expect(instanceCalls).toBeLessThan(sessionCalls);
    });

    it('returns zero without touching instances when the user has no sessions', async () => {
      mockPrismaSession.findMany.mockResolvedValueOnce([]);
      mockPrismaSession.deleteMany.mockResolvedValueOnce({ count: 0 });

      const result = await removeByUserId('u_nonexistent');

      expect(result).toBe(0);
      expect(mockPrismaRefreshToken.deleteMany).not.toHaveBeenCalled();
    });

    it('propagates database errors so enclosing transactions roll back', async () => {
      mockPrismaSession.findMany.mockRejectedValueOnce(
        Object.assign(new Error('connection terminated'), { code: 'P2010' }),
      );

      await expect(removeByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T')).rejects.toThrow(
        'connection terminated',
      );
    });

    it('uses the provided transaction client for all deletions', async () => {
      const mockTxSession = {
        findMany: vi.fn().mockResolvedValueOnce([{ id: 's_1' }]),
        deleteMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
      };
      const mockTxRefreshToken = { deleteMany: vi.fn().mockResolvedValueOnce({ count: 1 }) };
      const mockTx = {
        session: mockTxSession,
        refreshToken: mockTxRefreshToken,
      } as unknown as Prisma.TransactionClient;

      const result = await removeByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', mockTx);

      expect(result).toBe(1);
      expect(mockTxSession.deleteMany).toHaveBeenCalled();
      expect(mockPrismaSession.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('revokeFamily', () => {
    it('marks the session revoked and reports the transition', async () => {
      mockPrismaSession.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await revokeFamily('s_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(true);
      const args = mockPrismaSession.updateMany.mock.calls[0][0];
      expect(args.where).toEqual({ id: 's_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', revokedAt: null });
      expect(args.data.revokedAt).toBeInstanceOf(Date);
    });

    it('is idempotent: an already-revoked family reports no transition', async () => {
      mockPrismaSession.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await revokeFamily('s_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(false);
    });

    it('uses the provided transaction client', async () => {
      const mockTxSession = { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }) };
      const mockTx = { session: mockTxSession } as unknown as Prisma.TransactionClient;

      const result = await revokeFamily('s_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', mockTx);

      expect(result).toBe(true);
      expect(mockTxSession.updateMany).toHaveBeenCalled();
      expect(mockPrismaSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllByUserId', () => {
    it('revokes every live session in one set-based update', async () => {
      mockPrismaSession.updateMany.mockResolvedValueOnce({ count: 3 });

      const result = await revokeAllByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(3);
      const args = mockPrismaSession.updateMany.mock.calls[0][0];
      expect(args.where).toEqual({ userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', revokedAt: null });
      expect(args.data.revokedAt).toBeInstanceOf(Date);
    });

    it('reports zero for users with no live sessions', async () => {
      mockPrismaSession.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await revokeAllByUserId('u_nonexistent');

      expect(result).toBe(0);
    });

    it('propagates database errors instead of masking them', async () => {
      mockPrismaSession.updateMany.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(revokeAllByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T')).rejects.toThrow(
        'connection terminated',
      );
    });

    it('uses the provided transaction client', async () => {
      const mockTxSession = { updateMany: vi.fn().mockResolvedValueOnce({ count: 2 }) };
      const mockTx = { session: mockTxSession } as unknown as Prisma.TransactionClient;

      const result = await revokeAllByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', mockTx);

      expect(result).toBe(2);
      expect(mockTxSession.updateMany).toHaveBeenCalled();
      expect(mockPrismaSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('exports', () => {
    it('exports sessionRepository with all repository methods', () => {
      expect(sessionRepository.findById).toBe(findById);
      expect(sessionRepository.create).toBe(create);
      expect(sessionRepository.removeByUserId).toBe(removeByUserId);
      expect(sessionRepository.revokeFamily).toBe(revokeFamily);
      expect(sessionRepository.revokeAllByUserId).toBe(revokeAllByUserId);
    });
  });
});
