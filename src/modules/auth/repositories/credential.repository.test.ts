import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@prisma/client';

const mockPrismaCredential = {
  findUnique: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  updateMany: vi.fn(),
};

vi.mock('../../../platform/database/prisma.js', () => ({
  prisma: {
    credential: mockPrismaCredential,
  },
}));

const { findByUserId, create, updatePasswordHash, removeByUserId, credentialRepository } = await import('./credential.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('credentialRepository', () => {
  const mockRow = {
    id: 'c_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
    userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
    passwordHash: '$2b$12$hashedpasswordvalue',
    createdAt: new Date('2026-01-15T09:30:00.000Z'),
    updatedAt: new Date('2026-01-15T09:30:00.000Z'),
  };

  describe('findByUserId', () => {
    it('returns a domain Credential when a matching record exists', async () => {
      mockPrismaCredential.findUnique.mockResolvedValueOnce(mockRow);

      const result = await findByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toEqual(mockRow);
      expect(mockPrismaCredential.findUnique).toHaveBeenCalledWith({
        where: { userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
        select: {
          id: true,
          userId: true,
          passwordHash: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('returns null when no credential exists for the given user ID', async () => {
      mockPrismaCredential.findUnique.mockResolvedValueOnce(null);

      const result = await findByUserId('u_nonexistent');

      expect(result).toBeNull();
    });

    it('does not select the User relation', async () => {
      mockPrismaCredential.findUnique.mockResolvedValueOnce(mockRow);

      await findByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      const selectClause = mockPrismaCredential.findUnique.mock.calls[0][0].select;
      expect(selectClause).not.toHaveProperty('user');
    });
  });

  describe('create', () => {
    it('creates a Credential and returns the domain representation', async () => {
      mockPrismaCredential.create.mockResolvedValueOnce(mockRow);

      const input = {
        id: 'c_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        passwordHash: '$2b$12$hashedpasswordvalue',
      };

      const result = await create(input);

      expect(result).toEqual(mockRow);
      expect(mockPrismaCredential.create).toHaveBeenCalledWith({
        data: {
          id: 'c_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          passwordHash: '$2b$12$hashedpasswordvalue',
        },
        select: {
          id: true,
          userId: true,
          passwordHash: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('does not select the User relation on create', async () => {
      mockPrismaCredential.create.mockResolvedValueOnce(mockRow);

      await create({
        id: 'c_123',
        userId: 'u_123',
        passwordHash: '$2b$12$hash',
      });

      const selectClause = mockPrismaCredential.create.mock.calls[0][0].select;
      expect(selectClause).not.toHaveProperty('user');
    });
  });

  describe('transaction client support', () => {
    it('uses the provided transaction client instead of the default prisma instance', async () => {
      const mockTxCredential = { findUnique: vi.fn().mockResolvedValueOnce(mockRow) };
      const mockTx = { credential: mockTxCredential } as unknown as Prisma.TransactionClient;

      const result = await findByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', mockTx);

      expect(result).toEqual(mockRow);
      expect(mockTxCredential.findUnique).toHaveBeenCalled();
      expect(mockPrismaCredential.findUnique).not.toHaveBeenCalled();
    });

    it('uses the provided transaction client for create operations', async () => {
      const mockTxCredential = { create: vi.fn().mockResolvedValueOnce(mockRow) };
      const mockTx = { credential: mockTxCredential } as unknown as Prisma.TransactionClient;

      const result = await create(
        { id: 'c_123', userId: 'u_123', passwordHash: '$2b$12$hash' },
        mockTx,
      );

      expect(result).toEqual(mockRow);
      expect(mockTxCredential.create).toHaveBeenCalled();
      expect(mockPrismaCredential.create).not.toHaveBeenCalled();
    });
  });

  describe('removeByUserId', () => {
    it('deletes a Credential by userId and returns true', async () => {
      mockPrismaCredential.delete = vi.fn().mockResolvedValueOnce({});

      const result = await removeByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(true);
      expect(mockPrismaCredential.delete).toHaveBeenCalledWith({
        where: { userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
      });
    });

    it('returns false when no credential exists for the given userId', async () => {
      mockPrismaCredential.delete = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('Record not found.'), { code: 'P2025' }));

      const result = await removeByUserId('u_nonexistent');

      expect(result).toBe(false);
    });

    it('propagates database errors other than P2025 so enclosing transactions roll back', async () => {
      mockPrismaCredential.delete = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { code: 'P2010' }));

      await expect(removeByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T')).rejects.toThrow(
        'connection terminated',
      );
    });

    it('uses the provided transaction client for delete operations', async () => {
      const mockTxCredential = { delete: vi.fn().mockResolvedValueOnce({}) };
      const mockTx = { credential: mockTxCredential } as unknown as Prisma.TransactionClient;

      const result = await removeByUserId('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', mockTx);

      expect(result).toBe(true);
      expect(mockTxCredential.delete).toHaveBeenCalled();
      expect(mockPrismaCredential.delete).not.toHaveBeenCalled();
    });
  });

  describe('updatePasswordHash', () => {
    it('updates the stored hash and reports success', async () => {
      mockPrismaCredential.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await updatePasswordHash('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', '$2b$12$newhashvalue');

      expect(result).toBe(true);
      expect(mockPrismaCredential.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
        data: { passwordHash: '$2b$12$newhashvalue' },
      });
    });

    it('reports false when no credential exists instead of upserting', async () => {
      mockPrismaCredential.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await updatePasswordHash('u_nonexistent', '$2b$12$newhashvalue');

      expect(result).toBe(false);
    });

    it('propagates database errors so enclosing transactions roll back', async () => {
      mockPrismaCredential.updateMany.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(
        updatePasswordHash('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', '$2b$12$newhashvalue'),
      ).rejects.toThrow('connection terminated');
    });

    it('uses the provided transaction client', async () => {
      const mockTxCredential = { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }) };
      const mockTx = { credential: mockTxCredential } as unknown as Prisma.TransactionClient;

      const result = await updatePasswordHash('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', '$2b$12$hash', mockTx);

      expect(result).toBe(true);
      expect(mockTxCredential.updateMany).toHaveBeenCalled();
      expect(mockPrismaCredential.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('exports', () => {
    it('exports credentialRepository with all repository methods', () => {
      expect(credentialRepository.findByUserId).toBe(findByUserId);
      expect(credentialRepository.create).toBe(create);
      expect(credentialRepository.updatePasswordHash).toBe(updatePasswordHash);
      expect(credentialRepository.removeByUserId).toBe(removeByUserId);
    });
  });
});
