import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@prisma/client';

const mockPrismaUser = {
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
};

vi.mock('../../platform/database/prisma.js', () => ({
  prisma: {
    user: mockPrismaUser,
  },
}));

const { findByEmail, findById, create, update, setLockedUntilIfUnlocked, clearExpiredLockout, remove, usersRepository } = await import('./user.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('usersRepository', () => {
  const mockRow = {
    id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
    email: 'alice@example.com',
    displayName: 'Alice',
    status: 'active',
    role: 'user',
    emailVerifiedAt: null,
    lockedUntil: null,
    createdAt: new Date('2026-01-15T09:30:00.000Z'),
    updatedAt: new Date('2026-01-15T09:30:00.000Z'),
  };

  describe('findByEmail', () => {
    it('returns a domain User when a matching record exists', async () => {
      mockPrismaUser.findUnique.mockResolvedValueOnce(mockRow);

      const result = await findByEmail('alice@example.com');

      expect(result).toEqual(mockRow);
      expect(mockPrismaUser.findUnique).toHaveBeenCalledWith({
        where: { email: 'alice@example.com' },
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          role: true,
          emailVerifiedAt: true,
          lockedUntil: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('returns null when no user exists with the given email', async () => {
      mockPrismaUser.findUnique.mockResolvedValueOnce(null);

      const result = await findByEmail('nonexistent@example.com');

      expect(result).toBeNull();
    });

    it('does not select the Credential relation', async () => {
      mockPrismaUser.findUnique.mockResolvedValueOnce(mockRow);

      await findByEmail('alice@example.com');

      const selectClause = mockPrismaUser.findUnique.mock.calls[0][0].select;
      expect(selectClause).not.toHaveProperty('credential');
    });
  });

  describe('findById', () => {
    it('returns a domain User when a matching record exists', async () => {
      mockPrismaUser.findUnique.mockResolvedValueOnce(mockRow);

      const result = await findById('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toEqual(mockRow);
      expect(mockPrismaUser.findUnique).toHaveBeenCalledWith({
        where: { id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          role: true,
          emailVerifiedAt: true,
          lockedUntil: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('returns null when no user exists with the given ID', async () => {
      mockPrismaUser.findUnique.mockResolvedValueOnce(null);

      const result = await findById('u_nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('creates a User and returns the domain representation', async () => {
      mockPrismaUser.create.mockResolvedValueOnce(mockRow);

      const input = {
        id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        email: 'alice@example.com',
        displayName: 'Alice',
      };

      const result = await create(input);

      expect(result).toEqual(mockRow);
      expect(mockPrismaUser.create).toHaveBeenCalledWith({
        data: {
          id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          email: 'alice@example.com',
          displayName: 'Alice',
          status: 'active',
          role: 'user',
        },
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          role: true,
          emailVerifiedAt: true,
          lockedUntil: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('defaults displayName to null and status to active when not provided', async () => {
      mockPrismaUser.create.mockResolvedValueOnce(mockRow);

      const input = {
        id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        email: 'alice@example.com',
      };

      await create(input);

      expect(mockPrismaUser.create).toHaveBeenCalledWith({
        data: {
          id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          email: 'alice@example.com',
          displayName: null,
          status: 'active',
          role: 'user',
        },
        select: expect.objectContaining({ role: true }),
      });
    });

    it('does not select the Credential relation on create', async () => {
      mockPrismaUser.create.mockResolvedValueOnce(mockRow);

      await create({ id: 'u_123', email: 'test@example.com' });

      const selectClause = mockPrismaUser.create.mock.calls[0][0].select;
      expect(selectClause).not.toHaveProperty('credential');
    });
  });

  describe('transaction client support', () => {
    it('uses the provided transaction client instead of the default prisma instance', async () => {
      const mockTxUser = { findUnique: vi.fn().mockResolvedValueOnce(mockRow) };
      const mockTx = { user: mockTxUser } as unknown as Prisma.TransactionClient;

      const result = await findByEmail('alice@example.com', mockTx);

      expect(result).toEqual(mockRow);
      expect(mockTxUser.findUnique).toHaveBeenCalled();
      expect(mockPrismaUser.findUnique).not.toHaveBeenCalled();
    });

    it('uses the provided transaction client for create operations', async () => {
      const mockTxUser = { create: vi.fn().mockResolvedValueOnce(mockRow) };
      const mockTx = { user: mockTxUser } as unknown as Prisma.TransactionClient;

      const result = await create(
        { id: 'u_123', email: 'alice@example.com' },
        mockTx,
      );

      expect(result).toEqual(mockRow);
      expect(mockTxUser.create).toHaveBeenCalled();
      expect(mockPrismaUser.create).not.toHaveBeenCalled();
    });

    it('uses the provided transaction client for delete operations', async () => {
      const mockTxUser = { delete: vi.fn().mockResolvedValueOnce({}) };
      const mockTx = { user: mockTxUser } as unknown as Prisma.TransactionClient;

      const result = await remove('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', mockTx);

      expect(result).toBe(true);
      expect(mockTxUser.delete).toHaveBeenCalled();
      expect(mockPrismaUser.delete).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates a User and returns the domain representation', async () => {
      const updatedRow = { ...mockRow, displayName: 'Updated Name' };
      mockPrismaUser.update = vi.fn().mockResolvedValueOnce(updatedRow);

      const result = await update('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', { displayName: 'Updated Name' });

      expect(result).toEqual(updatedRow);
      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
        data: { displayName: 'Updated Name' },
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          role: true,
          emailVerifiedAt: true,
          lockedUntil: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('updates status field', async () => {
      const updatedRow = { ...mockRow, status: 'inactive' };
      mockPrismaUser.update = vi.fn().mockResolvedValueOnce(updatedRow);

      const result = await update('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', { status: 'inactive' });

      expect(result).toEqual(updatedRow);
      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
        data: { status: 'inactive' },
        select: expect.objectContaining({ status: true }),
      });
    });

    it('updates emailVerifiedAt field', async () => {
      const verifiedAt = new Date('2026-02-01T10:00:00.000Z');
      const updatedRow = { ...mockRow, emailVerifiedAt: verifiedAt };
      mockPrismaUser.update = vi.fn().mockResolvedValueOnce(updatedRow);

      const result = await update('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', { emailVerifiedAt: verifiedAt });

      expect(result).toEqual(updatedRow);
      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
        data: { emailVerifiedAt: verifiedAt },
        select: expect.objectContaining({ emailVerifiedAt: true }),
      });
    });

    it('sets displayName to null when explicitly provided', async () => {
      const updatedRow = { ...mockRow, displayName: null };
      mockPrismaUser.update = vi.fn().mockResolvedValueOnce(updatedRow);

      const result = await update('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', { displayName: null });

      expect(result).toEqual(updatedRow);
      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
        data: { displayName: null },
        select: expect.objectContaining({ displayName: true }),
      });
    });

    it('returns null when user does not exist', async () => {
      mockPrismaUser.update = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('Record not found.'), { code: 'P2025' }));

      const result = await update('u_nonexistent', { displayName: 'Updated' });

      expect(result).toBeNull();
    });

    it('drops forged role/owner fields instead of persisting them (M4.8)', async () => {
      mockPrismaUser.update = vi.fn().mockResolvedValueOnce(mockRow);

      await update('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', {
        displayName: 'Updated Name',
        role: 'admin',
        ownerId: 'u_victim',
        userId: 'u_victim',
      } as unknown as Parameters<typeof update>[1]);

      const data = mockPrismaUser.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data).toEqual({ displayName: 'Updated Name' });
      expect(data).not.toHaveProperty('role');
      expect(data).not.toHaveProperty('ownerId');
      expect(data).not.toHaveProperty('userId');
    });

    it('propagates database errors other than P2025 so enclosing transactions roll back', async () => {
      mockPrismaUser.update = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: 'P2034' }));

      await expect(
        update('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', { displayName: 'Updated' }),
      ).rejects.toThrow('deadlock detected');
    });

    it('propagates connection failures instead of converting them to null', async () => {
      mockPrismaUser.update = vi
        .fn()
        .mockRejectedValueOnce(new Error("Can't reach database server"));

      await expect(
        update('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', { displayName: 'Updated' }),
      ).rejects.toThrow("Can't reach database server");
    });

    it('uses the provided transaction client for update operations', async () => {
      const mockTxUser = { update: vi.fn().mockResolvedValueOnce(mockRow) };
      const mockTx = { user: mockTxUser } as unknown as Prisma.TransactionClient;

      const result = await update('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', { displayName: 'Updated' }, mockTx);

      expect(result).toEqual(mockRow);
      expect(mockTxUser.update).toHaveBeenCalled();
      expect(mockPrismaUser.update).not.toHaveBeenCalled();
    });

    it('propagates unexpected errors through the provided transaction client', async () => {
      const mockTxUser = {
        update: vi
          .fn()
          .mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { code: 'P2010' })),
      };
      const mockTx = { user: mockTxUser } as unknown as Prisma.TransactionClient;

      await expect(
        update('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', { displayName: 'Updated' }, mockTx),
      ).rejects.toThrow('connection terminated');
      expect(mockPrismaUser.update).not.toHaveBeenCalled();
    });

    it('does not select the Credential relation on update', async () => {
      mockPrismaUser.update = vi.fn().mockResolvedValueOnce(mockRow);

      await update('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', { displayName: 'Updated' });

      const selectClause = mockPrismaUser.update.mock.calls[0][0].select;
      expect(selectClause).not.toHaveProperty('credential');
    });

    it('updates the lockout marker when lockedUntil is provided', async () => {
      const lockedUntil = new Date('2026-09-29T12:00:00.000Z');
      mockPrismaUser.update = vi.fn().mockResolvedValueOnce({ ...mockRow, lockedUntil });

      const result = await update('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', { lockedUntil });

      expect(result?.lockedUntil).toEqual(lockedUntil);
      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
        data: { lockedUntil },
        select: expect.anything(),
      });
    });

    it('clears the lockout marker when lockedUntil is null', async () => {
      mockPrismaUser.update = vi.fn().mockResolvedValueOnce(mockRow);

      const result = await update('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', { lockedUntil: null });

      expect(result?.lockedUntil).toBeNull();
      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
        data: { lockedUntil: null },
        select: expect.anything(),
      });
    });
  });

  describe('setLockedUntilIfUnlocked', () => {
    it('sets the marker with a conditional predicate evaluated by PostgreSQL', async () => {
      mockPrismaUser.updateMany = vi.fn().mockResolvedValueOnce({ count: 1 });
      const lockedUntil = new Date('2026-09-29T12:00:00.000Z');

      const result = await setLockedUntilIfUnlocked('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', lockedUntil);

      expect(result).toBe(true);
      const args = mockPrismaUser.updateMany.mock.calls[0][0];
      expect(args.where.id).toBe('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');
      // Only transitions when no live lock exists — never extends one.
      expect(args.where.OR).toEqual([{ lockedUntil: null }, { lockedUntil: { lte: expect.any(Date) } }]);
      expect(args.data).toEqual({ lockedUntil });
    });

    it('returns false when a live lock already exists', async () => {
      mockPrismaUser.updateMany = vi.fn().mockResolvedValueOnce({ count: 0 });

      const result = await setLockedUntilIfUnlocked(
        'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        new Date('2026-09-29T12:00:00.000Z'),
      );

      expect(result).toBe(false);
    });

    it('returns false for unknown IDs without throwing', async () => {
      mockPrismaUser.updateMany = vi.fn().mockResolvedValueOnce({ count: 0 });

      expect(await setLockedUntilIfUnlocked('u_nonexistent', new Date())).toBe(false);
    });

    it('propagates unexpected database errors', async () => {
      mockPrismaUser.updateMany = vi.fn().mockRejectedValueOnce(new Error('connection terminated'));

      await expect(
        setLockedUntilIfUnlocked('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', new Date()),
      ).rejects.toThrow('connection terminated');
    });

    it('threads an optional transaction client', async () => {
      const mockTxUser = { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }) };
      const mockTx = { user: mockTxUser } as unknown as Prisma.TransactionClient;

      const result = await setLockedUntilIfUnlocked(
        'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        new Date('2026-09-29T12:00:00.000Z'),
        mockTx,
      );

      expect(result).toBe(true);
      expect(mockTxUser.updateMany).toHaveBeenCalled();
      expect(mockPrismaUser.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('clearExpiredLockout', () => {
    it('clears only an expired marker, never a live lock', async () => {
      mockPrismaUser.updateMany = vi.fn().mockResolvedValueOnce({ count: 1 });
      const now = new Date('2026-09-29T12:00:00.000Z');

      const result = await clearExpiredLockout('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', now);

      expect(result).toBe(true);
      expect(mockPrismaUser.updateMany).toHaveBeenCalledWith({
        where: { id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', lockedUntil: { lte: now } },
        data: { lockedUntil: null },
      });
    });

    it('returns false when the lock is still live', async () => {
      mockPrismaUser.updateMany = vi.fn().mockResolvedValueOnce({ count: 0 });

      expect(await clearExpiredLockout('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', new Date())).toBe(false);
    });

    it('propagates unexpected database errors', async () => {
      mockPrismaUser.updateMany = vi.fn().mockRejectedValueOnce(new Error('connection terminated'));

      await expect(
        clearExpiredLockout('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', new Date()),
      ).rejects.toThrow('connection terminated');
    });

    it('threads an optional transaction client', async () => {
      const mockTxUser = { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }) };
      const mockTx = { user: mockTxUser } as unknown as Prisma.TransactionClient;

      const result = await clearExpiredLockout('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', new Date(), mockTx);

      expect(result).toBe(true);
      expect(mockTxUser.updateMany).toHaveBeenCalled();
      expect(mockPrismaUser.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes a User and returns true', async () => {
      mockPrismaUser.delete = vi.fn().mockResolvedValueOnce({});

      const result = await remove('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toBe(true);
      expect(mockPrismaUser.delete).toHaveBeenCalledWith({
        where: { id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' },
      });
    });

    it('returns false when user does not exist', async () => {
      mockPrismaUser.delete = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('Record not found.'), { code: 'P2025' }));

      const result = await remove('u_nonexistent');

      expect(result).toBe(false);
    });

    it('propagates database errors other than P2025 so enclosing transactions roll back', async () => {
      mockPrismaUser.delete = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: 'P2034' }));

      await expect(remove('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T')).rejects.toThrow('deadlock detected');
    });
  });

  describe('exports', () => {
    it('exports usersRepository with all repository methods', () => {
      expect(usersRepository.findByEmail).toBe(findByEmail);
      expect(usersRepository.findById).toBe(findById);
      expect(usersRepository.create).toBe(create);
      expect(usersRepository.update).toBe(update);
      expect(usersRepository.setLockedUntilIfUnlocked).toBe(setLockedUntilIfUnlocked);
      expect(usersRepository.clearExpiredLockout).toBe(clearExpiredLockout);
      expect(usersRepository.remove).toBe(remove);
    });
  });
});
