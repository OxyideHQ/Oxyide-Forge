import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrismaTransaction = vi.fn();
const mockPrisma = {
  $transaction: mockPrismaTransaction,
};

vi.mock('../../platform/database/prisma.js', () => ({
  prisma: mockPrisma,
}));

const mockFindByEmail = vi.fn();
const mockFindById = vi.fn();
const mockCreateUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockRemoveUser = vi.fn();
const mockSetLockedUntilIfUnlocked = vi.fn();
const mockClearExpiredLockout = vi.fn();

vi.mock('./user.repository.js', () => ({
  usersRepository: {
    findByEmail: mockFindByEmail,
    findById: mockFindById,
    create: mockCreateUser,
    update: mockUpdateUser,
    remove: mockRemoveUser,
    setLockedUntilIfUnlocked: mockSetLockedUntilIfUnlocked,
    clearExpiredLockout: mockClearExpiredLockout,
  },
}));

const mockRemoveCredential = vi.fn();

vi.mock('../auth/services/credential.service.js', () => ({
  credentialService: {
    removeByUserId: mockRemoveCredential,
  },
}));

const mockRemoveSessions = vi.fn();

vi.mock('../auth/services/session.service.js', () => ({
  sessionService: {
    removeByUserId: mockRemoveSessions,
  },
}));

const mockRemoveResetTokens = vi.fn();

vi.mock('../auth/services/password-reset.service.js', () => ({
  passwordResetService: {
    removeByUserId: mockRemoveResetTokens,
  },
}));

const mockRemoveVerifyTokens = vi.fn();

vi.mock('../auth/services/email-verification.service.js', () => ({
  emailVerificationService: {
    removeByUserId: mockRemoveVerifyTokens,
  },
}));

const { usersService } = await import('./users.service.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('usersService', () => {
  const mockUser = {
    id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
    email: 'alice@example.com',
    displayName: 'Alice',
    status: 'active',
    role: 'user',
    createdAt: new Date('2026-01-15T09:30:00.000Z'),
    updatedAt: new Date('2026-01-15T09:30:00.000Z'),
  };

  describe('setAccountLockIfUnlocked', () => {
    it('delegates the conditional lock transition with the transaction client', async () => {
      const mockTx = {};
      const lockedUntil = new Date('2026-09-29T12:00:00.000Z');
      mockSetLockedUntilIfUnlocked.mockResolvedValueOnce(true);

      const result = await usersService.setAccountLockIfUnlocked(
        'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        lockedUntil,
        mockTx as never,
      );

      expect(result).toBe(true);
      expect(mockSetLockedUntilIfUnlocked).toHaveBeenCalledWith(
        'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        lockedUntil,
        mockTx,
      );
    });

    it('reports a lost race without throwing', async () => {
      mockSetLockedUntilIfUnlocked.mockResolvedValueOnce(false);

      const result = await usersService.setAccountLockIfUnlocked(
        'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        new Date(),
      );

      expect(result).toBe(false);
    });
  });

  describe('clearExpiredAccountLock', () => {
    it('delegates the conditional clear with the transaction client', async () => {
      const mockTx = {};
      const now = new Date('2026-09-29T12:00:00.000Z');
      mockClearExpiredLockout.mockResolvedValueOnce(true);

      const result = await usersService.clearExpiredAccountLock(
        'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        now,
        mockTx as never,
      );

      expect(result).toBe(true);
      expect(mockClearExpiredLockout).toHaveBeenCalledWith(
        'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        now,
        mockTx,
      );
    });

    it('reports a surviving live lock without throwing', async () => {
      mockClearExpiredLockout.mockResolvedValueOnce(false);

      const result = await usersService.clearExpiredAccountLock(
        'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        new Date(),
      );

      expect(result).toBe(false);
    });
  });

  describe('remove', () => {
    it('returns false without deleting anything when the user does not exist', async () => {
      const mockTx = {};
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
      mockFindById.mockResolvedValueOnce(null);

      const result = await usersService.remove('u_01HX9Z6Y7K8Q3V2N4M5P6R7S9U');

      expect(result).toBe(false);
      expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
      expect(mockRemoveSessions).not.toHaveBeenCalled();
      expect(mockRemoveResetTokens).not.toHaveBeenCalled();
      expect(mockRemoveVerifyTokens).not.toHaveBeenCalled();
      expect(mockRemoveCredential).not.toHaveBeenCalled();
      expect(mockRemoveUser).not.toHaveBeenCalled();
    });

    it('deletes the sessions through the auth-owned session service within a single transaction', async () => {
      const mockTx = {};
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
      mockFindById.mockResolvedValueOnce(mockUser);
      mockRemoveSessions.mockResolvedValueOnce(2);
      mockRemoveResetTokens.mockResolvedValueOnce(0);
      mockRemoveVerifyTokens.mockResolvedValueOnce(0);
      mockRemoveCredential.mockResolvedValueOnce(true);
      mockRemoveUser.mockResolvedValueOnce(true);

      const result = await usersService.remove(mockUser.id);

      expect(result).toBe(true);
      expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
      expect(mockRemoveSessions).toHaveBeenCalledWith(mockUser.id, mockTx);
    });

    it('deletes password-reset tokens through the auth-owned reset service within a single transaction', async () => {
      const mockTx = {};
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
      mockFindById.mockResolvedValueOnce(mockUser);
      mockRemoveSessions.mockResolvedValueOnce(0);
      mockRemoveResetTokens.mockResolvedValueOnce(1);
      mockRemoveVerifyTokens.mockResolvedValueOnce(0);
      mockRemoveCredential.mockResolvedValueOnce(true);
      mockRemoveUser.mockResolvedValueOnce(true);

      const result = await usersService.remove(mockUser.id);

      expect(result).toBe(true);
      expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
      expect(mockRemoveResetTokens).toHaveBeenCalledWith(mockUser.id, mockTx);
    });

    it('deletes email-verification tokens through the auth-owned verification service within a single transaction', async () => {
      const mockTx = {};
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
      mockFindById.mockResolvedValueOnce(mockUser);
      mockRemoveSessions.mockResolvedValueOnce(0);
      mockRemoveResetTokens.mockResolvedValueOnce(0);
      mockRemoveVerifyTokens.mockResolvedValueOnce(1);
      mockRemoveCredential.mockResolvedValueOnce(true);
      mockRemoveUser.mockResolvedValueOnce(true);

      const result = await usersService.remove(mockUser.id);

      expect(result).toBe(true);
      expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
      expect(mockRemoveVerifyTokens).toHaveBeenCalledWith(mockUser.id, mockTx);
    });

    it('deletes the credential through the auth-owned credential service within a single transaction', async () => {
      const mockTx = {};
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
      mockFindById.mockResolvedValueOnce(mockUser);
      mockRemoveSessions.mockResolvedValueOnce(0);
      mockRemoveResetTokens.mockResolvedValueOnce(0);
      mockRemoveVerifyTokens.mockResolvedValueOnce(0);
      mockRemoveCredential.mockResolvedValueOnce(true);
      mockRemoveUser.mockResolvedValueOnce(true);

      const result = await usersService.remove(mockUser.id);

      expect(result).toBe(true);
      expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
      expect(mockFindById).toHaveBeenCalledWith(mockUser.id, mockTx);
      expect(mockRemoveCredential).toHaveBeenCalledWith(mockUser.id, mockTx);
      expect(mockRemoveUser).toHaveBeenCalledWith(mockUser.id, mockTx);
    });

    it('removes sessions and reset tokens before the credential and the credential before the user to satisfy ON DELETE RESTRICT ordering', async () => {
      const mockTx = {};
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
      mockFindById.mockResolvedValueOnce(mockUser);
      mockRemoveSessions.mockResolvedValueOnce(1);
      mockRemoveResetTokens.mockResolvedValueOnce(1);
      mockRemoveVerifyTokens.mockResolvedValueOnce(1);
      mockRemoveCredential.mockResolvedValueOnce(true);
      mockRemoveUser.mockResolvedValueOnce(true);

      await usersService.remove(mockUser.id);

      const sessionCalls = mockRemoveSessions.mock.invocationCallOrder[0];
      const resetCalls = mockRemoveResetTokens.mock.invocationCallOrder[0];
      const verifyCalls = mockRemoveVerifyTokens.mock.invocationCallOrder[0];
      const credentialCalls = mockRemoveCredential.mock.invocationCallOrder[0];
      const userCalls = mockRemoveUser.mock.invocationCallOrder[0];
      expect(sessionCalls).toBeLessThan(credentialCalls);
      expect(resetCalls).toBeLessThan(credentialCalls);
      expect(verifyCalls).toBeLessThan(credentialCalls);
      expect(credentialCalls).toBeLessThan(userCalls);
    });

    it('removes the credential before the user to satisfy ON DELETE RESTRICT ordering', async () => {
      const mockTx = {};
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
      mockFindById.mockResolvedValueOnce(mockUser);
      mockRemoveSessions.mockResolvedValueOnce(0);
      mockRemoveResetTokens.mockResolvedValueOnce(0);
      mockRemoveVerifyTokens.mockResolvedValueOnce(0);
      mockRemoveCredential.mockResolvedValueOnce(true);
      mockRemoveUser.mockResolvedValueOnce(true);

      await usersService.remove(mockUser.id);

      const credentialCalls = mockRemoveCredential.mock.invocationCallOrder[0];
      const userCalls = mockRemoveUser.mock.invocationCallOrder[0];
      expect(credentialCalls).toBeLessThan(userCalls);
    });
  });
});
