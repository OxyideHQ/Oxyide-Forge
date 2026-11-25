import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@prisma/client';

const mockRemoveSessions = vi.fn();
const mockRevokeFamily = vi.fn();
const mockRevokeAllByUserId = vi.fn();

vi.mock('../repositories/session.repository.js', () => ({
  sessionRepository: {
    removeByUserId: mockRemoveSessions,
    revokeFamily: mockRevokeFamily,
    revokeAllByUserId: mockRevokeAllByUserId,
  },
}));

const {
  removeByUserId,
  revokeSession,
  revokeAllSessionsForUser,
  sessionService,
} = await import('./session.service.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sessionService', () => {
  describe('removeByUserId', () => {
    it('delegates deletion to the repository with the transaction client', async () => {
      const mockTx = {} as Prisma.TransactionClient;
      mockRemoveSessions.mockResolvedValueOnce(2);

      const result = await removeByUserId('u_123', mockTx);

      expect(result).toBe(2);
      expect(mockRemoveSessions).toHaveBeenCalledWith('u_123', mockTx);
    });
  });

  describe('revokeSession', () => {
    it('revokes one family and reports the transition', async () => {
      mockRevokeFamily.mockResolvedValueOnce(true);

      const result = await revokeSession('s_123');

      expect(result).toBe(true);
      expect(mockRevokeFamily).toHaveBeenCalledWith('s_123', undefined);
    });

    it('reports false for already-revoked sessions without error', async () => {
      mockRevokeFamily.mockResolvedValueOnce(false);

      const result = await revokeSession('s_revoked');

      expect(result).toBe(false);
    });

    it('propagates database errors instead of reporting success', async () => {
      mockRevokeFamily.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(revokeSession('s_123')).rejects.toThrow('connection terminated');
    });
  });

  describe('revokeAllSessionsForUser', () => {
    it('revokes every live session in one call and reports the count', async () => {
      mockRevokeAllByUserId.mockResolvedValueOnce(3);

      const result = await revokeAllSessionsForUser('u_123');

      expect(result).toBe(3);
      expect(mockRevokeAllByUserId).toHaveBeenCalledWith('u_123', undefined);
    });

    it('reports zero for users with no live sessions', async () => {
      mockRevokeAllByUserId.mockResolvedValueOnce(0);

      const result = await revokeAllSessionsForUser('u_nobody');

      expect(result).toBe(0);
    });

    it('propagates database errors instead of reporting success', async () => {
      mockRevokeAllByUserId.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(revokeAllSessionsForUser('u_123')).rejects.toThrow('connection terminated');
    });
  });

  describe('exports', () => {
    it('exports sessionService with all session operations', () => {
      expect(sessionService.removeByUserId).toBe(removeByUserId);
      expect(sessionService.revokeSession).toBe(revokeSession);
      expect(sessionService.revokeAllSessionsForUser).toBe(revokeAllSessionsForUser);
    });
  });
});
