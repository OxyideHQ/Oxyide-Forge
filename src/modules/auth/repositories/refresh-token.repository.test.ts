import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@prisma/client';

const mockPrismaRefreshToken = {
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
};

vi.mock('../../../platform/database/prisma.js', () => ({
  prisma: {
    refreshToken: mockPrismaRefreshToken,
  },
}));

const { findById, findByTokenHash, create, consumeIfActive, markSuperseded, revokeOne, refreshTokenRepository } =
  await import('./refresh-token.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('refreshTokenRepository', () => {
  const mockRow = {
    id: 'r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
    sessionId: 's_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
    tokenHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    expiresAt: new Date('2026-02-15T09:30:00.000Z'),
    consumedAt: null,
    supersededBy: null,
    revokedAt: null,
    createdAt: new Date('2026-01-15T09:30:00.000Z'),
    updatedAt: new Date('2026-01-15T09:30:00.000Z'),
  };

  const fullSelect = {
    id: true,
    sessionId: true,
    tokenHash: true,
    expiresAt: true,
    consumedAt: true,
    supersededBy: true,
    revokedAt: true,
    createdAt: true,
    updatedAt: true,
  };

  describe('findById', () => {
    it('returns a domain RefreshToken when a matching id exists', async () => {
      mockPrismaRefreshToken.findUnique.mockResolvedValueOnce(mockRow);

      const result = await findById('r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toEqual(mockRow);
      expect(mockPrismaRefreshToken.findUnique).toHaveBeenCalledWith({
        where: { id: 'r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
        select: fullSelect,
      });
    });

    it('returns null when no instance exists for the given id', async () => {
      mockPrismaRefreshToken.findUnique.mockResolvedValueOnce(null);

      const result = await findById('r_nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByTokenHash', () => {
    it('returns a domain RefreshToken when a matching hash exists', async () => {
      mockPrismaRefreshToken.findUnique.mockResolvedValueOnce(mockRow);

      const result = await findByTokenHash(mockRow.tokenHash);

      expect(result).toEqual(mockRow);
      expect(mockPrismaRefreshToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: mockRow.tokenHash },
        select: fullSelect,
      });
    });

    it('returns null when no instance exists for the given hash', async () => {
      mockPrismaRefreshToken.findUnique.mockResolvedValueOnce(null);

      const result = await findByTokenHash('unknown-hash-value');

      expect(result).toBeNull();
    });

    it('looks up by hash directly — never scans or compares raw tokens', async () => {
      mockPrismaRefreshToken.findUnique.mockResolvedValueOnce(mockRow);

      await findByTokenHash(mockRow.tokenHash);

      expect(mockPrismaRefreshToken.findUnique).toHaveBeenCalledTimes(1);
      const args = mockPrismaRefreshToken.findUnique.mock.calls[0][0];
      expect(Object.keys(args.where)).toEqual(['tokenHash']);
    });
  });

  describe('create', () => {
    it('creates a RefreshToken and returns the domain representation', async () => {
      mockPrismaRefreshToken.create.mockResolvedValueOnce(mockRow);

      const expiresAt = new Date('2026-02-15T09:30:00.000Z');
      const result = await create({
        id: 'r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        sessionId: 's_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        tokenHash: mockRow.tokenHash,
        expiresAt,
      });

      expect(result).toEqual(mockRow);
      expect(mockPrismaRefreshToken.create).toHaveBeenCalledWith({
        data: {
          id: 'r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          sessionId: 's_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          tokenHash: mockRow.tokenHash,
          expiresAt,
        },
        select: fullSelect,
      });
    });

    it('propagates unique violations so the service maps them instead of masking them', async () => {
      mockPrismaRefreshToken.create.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed.'), { code: 'P2002' }),
      );

      await expect(
        create({
          id: 'r_duplicate',
          sessionId: 's_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          tokenHash: mockRow.tokenHash,
          expiresAt: new Date('2026-02-15T09:30:00.000Z'),
        }),
      ).rejects.toThrow('Unique constraint failed.');
    });
  });

  describe('transaction client support', () => {
    it('uses the provided transaction client instead of the default prisma instance', async () => {
      const mockTxRefreshToken = { findUnique: vi.fn().mockResolvedValueOnce(mockRow) };
      const mockTx = { refreshToken: mockTxRefreshToken } as unknown as Prisma.TransactionClient;

      const result = await findByTokenHash(mockRow.tokenHash, mockTx);

      expect(result).toEqual(mockRow);
      expect(mockTxRefreshToken.findUnique).toHaveBeenCalled();
      expect(mockPrismaRefreshToken.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('consumeIfActive', () => {
    it('returns true when exactly one active row transitions to consumed', async () => {
      mockPrismaRefreshToken.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await consumeIfActive('r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(true);
      const args = mockPrismaRefreshToken.updateMany.mock.calls[0][0];
      expect(args.where.id).toBe('r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');
      expect(args.where.consumedAt).toBeNull();
      expect(args.where.revokedAt).toBeNull();
      expect(args.where.expiresAt.gt).toBeInstanceOf(Date);
      expect(args.data.consumedAt).toBeInstanceOf(Date);
    });

    it('returns false when no row transitions (lost race, consumed, or expired)', async () => {
      mockPrismaRefreshToken.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await consumeIfActive('r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(false);
    });

    it('uses the provided transaction client', async () => {
      const mockTxRefreshToken = { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }) };
      const mockTx = { refreshToken: mockTxRefreshToken } as unknown as Prisma.TransactionClient;

      const result = await consumeIfActive('r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', mockTx);

      expect(result).toBe(true);
      expect(mockTxRefreshToken.updateMany).toHaveBeenCalled();
      expect(mockPrismaRefreshToken.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('markSuperseded', () => {
    it('links the consumed instance to its successor', async () => {
      mockPrismaRefreshToken.update.mockResolvedValueOnce({});

      await markSuperseded('r_old', 'r_new');

      expect(mockPrismaRefreshToken.update).toHaveBeenCalledWith({
        where: { id: 'r_old' },
        data: { supersededBy: 'r_new' },
      });
    });

    it('propagates failures so the enclosing rotation rolls back', async () => {
      mockPrismaRefreshToken.update.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(markSuperseded('r_old', 'r_new')).rejects.toThrow('connection terminated');
    });
  });

  describe('revokeOne', () => {
    it('marks one instance revoked and reports the transition', async () => {
      mockPrismaRefreshToken.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await revokeOne('r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(true);
      const args = mockPrismaRefreshToken.updateMany.mock.calls[0][0];
      expect(args.where).toEqual({ id: 'r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', revokedAt: null });
      expect(args.data.revokedAt).toBeInstanceOf(Date);
    });

    it('is idempotent: already-revoked and unknown IDs report no transition', async () => {
      mockPrismaRefreshToken.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await revokeOne('r_unknown');

      expect(result).toBe(false);
    });

    it('propagates database errors instead of masking them', async () => {
      mockPrismaRefreshToken.updateMany.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(revokeOne('r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T')).rejects.toThrow(
        'connection terminated',
      );
    });

    it('uses the provided transaction client', async () => {
      const mockTxRefreshToken = { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }) };
      const mockTx = { refreshToken: mockTxRefreshToken } as unknown as Prisma.TransactionClient;

      const result = await revokeOne('r_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', mockTx);

      expect(result).toBe(true);
      expect(mockTxRefreshToken.updateMany).toHaveBeenCalled();
      expect(mockPrismaRefreshToken.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('exports', () => {
    it('exports refreshTokenRepository with all repository methods', () => {
      expect(refreshTokenRepository.findById).toBe(findById);
      expect(refreshTokenRepository.findByTokenHash).toBe(findByTokenHash);
      expect(refreshTokenRepository.create).toBe(create);
      expect(refreshTokenRepository.consumeIfActive).toBe(consumeIfActive);
      expect(refreshTokenRepository.markSuperseded).toBe(markSuperseded);
      expect(refreshTokenRepository.revokeOne).toBe(revokeOne);
    });
  });
});
