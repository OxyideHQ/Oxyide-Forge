import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@prisma/client';

const mockPrismaEmailVerificationToken = {
  findUnique: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
};

vi.mock('../../../platform/database/prisma.js', () => ({
  prisma: {
    emailVerificationToken: mockPrismaEmailVerificationToken,
  },
}));

const {
  findByTokenHash,
  create,
  consumeIfActive,
  invalidateActiveForUser,
  removeByUserId,
  emailVerificationRepository,
} = await import('./email-verification.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('emailVerificationRepository', () => {
  const mockRow = {
    id: 'e_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
    userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
    tokenHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    expiresAt: new Date('2026-01-16T09:30:00.000Z'),
    consumedAt: null,
    createdAt: new Date('2026-01-15T09:30:00.000Z'),
    updatedAt: new Date('2026-01-15T09:30:00.000Z'),
  };

  const fullSelect = {
    id: true,
    userId: true,
    tokenHash: true,
    expiresAt: true,
    consumedAt: true,
    createdAt: true,
    updatedAt: true,
  };

  describe('findByTokenHash', () => {
    it('returns a domain token when a matching hash exists', async () => {
      mockPrismaEmailVerificationToken.findUnique.mockResolvedValueOnce(mockRow);

      const result = await findByTokenHash(mockRow.tokenHash);

      expect(result).toEqual(mockRow);
      expect(mockPrismaEmailVerificationToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: mockRow.tokenHash },
        select: fullSelect,
      });
    });

    it('returns null when no instance exists for the given hash', async () => {
      mockPrismaEmailVerificationToken.findUnique.mockResolvedValueOnce(null);

      const result = await findByTokenHash('unknown-hash-value');

      expect(result).toBeNull();
    });

    it('looks up by hash directly — never scans or compares raw tokens', async () => {
      mockPrismaEmailVerificationToken.findUnique.mockResolvedValueOnce(mockRow);

      await findByTokenHash(mockRow.tokenHash);

      expect(mockPrismaEmailVerificationToken.findUnique).toHaveBeenCalledTimes(1);
      const args = mockPrismaEmailVerificationToken.findUnique.mock.calls[0][0];
      expect(Object.keys(args.where)).toEqual(['tokenHash']);
    });
  });

  describe('create', () => {
    it('creates a token and returns the domain representation', async () => {
      mockPrismaEmailVerificationToken.create.mockResolvedValueOnce(mockRow);

      const expiresAt = new Date('2026-01-16T09:30:00.000Z');
      const result = await create({
        id: 'e_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        tokenHash: mockRow.tokenHash,
        expiresAt,
      });

      expect(result).toEqual(mockRow);
      expect(mockPrismaEmailVerificationToken.create).toHaveBeenCalledWith({
        data: {
          id: 'e_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          tokenHash: mockRow.tokenHash,
          expiresAt,
        },
        select: fullSelect,
      });
    });

    it('propagates unique violations so the service handles collisions safely', async () => {
      mockPrismaEmailVerificationToken.create.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed.'), { code: 'P2002' }),
      );

      await expect(
        create({
          id: 'e_duplicate',
          userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          tokenHash: mockRow.tokenHash,
          expiresAt: new Date('2026-01-16T09:30:00.000Z'),
        }),
      ).rejects.toThrow('Unique constraint failed.');
    });
  });

  describe('consumeIfActive', () => {
    it('returns true when exactly one active row transitions to consumed', async () => {
      mockPrismaEmailVerificationToken.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await consumeIfActive('e_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(true);
      const args = mockPrismaEmailVerificationToken.updateMany.mock.calls[0][0];
      expect(args.where.id).toBe('e_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');
      expect(args.where.consumedAt).toBeNull();
      expect(args.where.expiresAt.gt).toBeInstanceOf(Date);
      expect(args.data.consumedAt).toBeInstanceOf(Date);
    });

    it('returns false when no row transitions', async () => {
      mockPrismaEmailVerificationToken.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await consumeIfActive('e_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(false);
    });

    it('uses the provided transaction client', async () => {
      const mockTxToken = { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }) };
      const mockTx = { emailVerificationToken: mockTxToken } as unknown as Prisma.TransactionClient;

      const result = await consumeIfActive('e_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', mockTx);

      expect(result).toBe(true);
      expect(mockTxToken.updateMany).toHaveBeenCalled();
      expect(mockPrismaEmailVerificationToken.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('invalidateActiveForUser', () => {
    it('marks all active tokens consumed in one set-based update', async () => {
      mockPrismaEmailVerificationToken.updateMany.mockResolvedValueOnce({ count: 2 });

      const result = await invalidateActiveForUser('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(2);
      const args = mockPrismaEmailVerificationToken.updateMany.mock.calls[0][0];
      expect(args.where).toEqual({
        userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        consumedAt: null,
      });
      expect(args.data.consumedAt).toBeInstanceOf(Date);
    });

    it('reports zero when no active token exists', async () => {
      mockPrismaEmailVerificationToken.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await invalidateActiveForUser('u_nobody');

      expect(result).toBe(0);
    });
  });

  describe('removeByUserId', () => {
    it('deletes every token of the user and reports the count', async () => {
      mockPrismaEmailVerificationToken.deleteMany.mockResolvedValueOnce({ count: 2 });

      const result = await removeByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(2);
      expect(mockPrismaEmailVerificationToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
      });
    });

    it('propagates database errors so enclosing transactions roll back', async () => {
      mockPrismaEmailVerificationToken.deleteMany.mockRejectedValueOnce(
        new Error('connection terminated'),
      );

      await expect(removeByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T')).rejects.toThrow(
        'connection terminated',
      );
    });
  });

  describe('transaction client support', () => {
    it('uses the provided transaction client instead of the default prisma instance', async () => {
      const mockTxToken = { findUnique: vi.fn().mockResolvedValueOnce(mockRow) };
      const mockTx = { emailVerificationToken: mockTxToken } as unknown as Prisma.TransactionClient;

      const result = await findByTokenHash(mockRow.tokenHash, mockTx);

      expect(result).toEqual(mockRow);
      expect(mockTxToken.findUnique).toHaveBeenCalled();
      expect(mockPrismaEmailVerificationToken.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('exports', () => {
    it('exports emailVerificationRepository with all repository methods', () => {
      expect(emailVerificationRepository.findByTokenHash).toBe(findByTokenHash);
      expect(emailVerificationRepository.create).toBe(create);
      expect(emailVerificationRepository.consumeIfActive).toBe(consumeIfActive);
      expect(emailVerificationRepository.invalidateActiveForUser).toBe(invalidateActiveForUser);
      expect(emailVerificationRepository.removeByUserId).toBe(removeByUserId);
    });
  });
});
