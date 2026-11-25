import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';

// Set required env vars before any imports
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const mockPrismaTransaction = vi.fn();
const mockPrisma = {
  $transaction: mockPrismaTransaction,
};

vi.mock('../../../platform/database/prisma.js', () => ({
  prisma: mockPrisma,
}));

const mockFindResetByHash = vi.fn();
const mockCreateResetToken = vi.fn();
const mockConsumeResetToken = vi.fn();
const mockInvalidateActive = vi.fn();
const mockRemoveResetTokens = vi.fn();

vi.mock('../repositories/password-reset.repository.js', () => ({
  passwordResetRepository: {
    findByTokenHash: mockFindResetByHash,
    create: mockCreateResetToken,
    consumeIfActive: mockConsumeResetToken,
    invalidateActiveForUser: mockInvalidateActive,
    removeByUserId: mockRemoveResetTokens,
  },
}));

const mockUpdatePasswordHash = vi.fn();

vi.mock('../repositories/credential.repository.js', () => ({
  credentialRepository: {
    updatePasswordHash: mockUpdatePasswordHash,
  },
}));

const mockRevokeAllSessions = vi.fn();

vi.mock('./session.service.js', () => ({
  sessionService: {
    revokeAllSessionsForUser: mockRevokeAllSessions,
  },
}));

const {
  hashResetToken,
  buildResetUrl,
  issueToken,
  findActiveToken,
  completeReset,
  removeByUserId,
  noopPasswordResetMailer,
  passwordResetService,
} = await import('./password-reset.service.js');
const { config } = await import('../../../config/index.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('passwordResetService', () => {
  describe('hashResetToken', () => {
    it('produces the documented SHA-256 hex digest', () => {
      expect(hashResetToken('test')).toBe(
        '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      );
    });

    it('is deterministic and differs across inputs', () => {
      expect(hashResetToken('token-a')).toBe(hashResetToken('token-a'));
      expect(hashResetToken('token-a')).not.toBe(hashResetToken('token-b'));
      expect(hashResetToken('token-a')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('buildResetUrl', () => {
    it('builds an absolute recovery link from configured base URL and raw token', () => {
      const url = buildResetUrl('raw-token-value');

      expect(url).toBe(`${config.appBaseUrl}/reset-password?token=raw-token-value`);
    });

    it('embeds only the token besides the documented path', () => {
      const url = buildResetUrl('raw-token-value');

      expect(url).not.toContain('@');
      const query = url.split('?')[1] ?? '';
      expect(Object.keys(Object.fromEntries(new URLSearchParams(query)))).toEqual(['token']);
    });
  });

  describe('noopPasswordResetMailer', () => {
    it('resolves without delivering', async () => {
      await expect(
        noopPasswordResetMailer.sendPasswordResetEmail({ to: 'a@b.com', resetUrl: 'https://x/y' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('issueToken', () => {
    const mockTx = {};

    function mockSuccessfulIssue(): void {
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockInvalidateActive.mockResolvedValueOnce(1);
        mockCreateResetToken.mockResolvedValueOnce({
          id: 'p_issued',
          userId: 'u_123',
          tokenHash: 'hash',
          expiresAt: new Date(),
          consumedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return fn(mockTx);
      });
    }

    it('persists only the hash in one transaction and emails the raw token', async () => {
      mockSuccessfulIssue();
      const sent: Array<{ to: string; resetUrl: string }> = [];
      const mailer = {
        sendPasswordResetEmail: vi.fn(async (email: { to: string; resetUrl: string }) => {
          sent.push(email);
        }),
      };

      await issueToken('u_123', 'alice@example.com', mailer);

      expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
      expect(mockInvalidateActive).toHaveBeenCalledWith('u_123', mockTx);
      const persistedHash = mockCreateResetToken.mock.calls[0][0].tokenHash;
      expect(persistedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('alice@example.com');
      expect(sent[0].resetUrl.startsWith(`${config.appBaseUrl}/reset-password?token=`)).toBe(true);
      // The persisted hash is the hash of the delivered raw token.
      const deliveredRaw = sent[0].resetUrl.split('token=')[1];
      expect(deliveredRaw).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(persistedHash).toBe(hashResetToken(deliveredRaw));
      const persistedStr = JSON.stringify(mockCreateResetToken.mock.calls[0][0]);
      expect(persistedStr).not.toContain(deliveredRaw);
    });

    it('sets expiry from the configured reset lifetime', async () => {
      const before = Date.now();
      mockSuccessfulIssue();
      const mailer = { sendPasswordResetEmail: vi.fn(async () => {}) };

      await issueToken('u_123', 'alice@example.com', mailer);

      const expiresAt = mockCreateResetToken.mock.calls[0][0].expiresAt as Date;
      const expected = before + config.auth.passwordResetTtlSeconds * 1000;
      expect(Math.abs(expiresAt.getTime() - expected)).toBeLessThan(5000);
    });

    it('propagates email failure without masking it as success', async () => {
      mockSuccessfulIssue();
      const mailer = {
        sendPasswordResetEmail: vi.fn(async () => {
          throw new Error('SMTP unreachable');
        }),
      };

      await expect(issueToken('u_123', 'alice@example.com', mailer)).rejects.toThrow(
        'SMTP unreachable',
      );
    });

    it('rejects when the transaction fails, delivering nothing', async () => {
      mockPrismaTransaction.mockRejectedValueOnce(new Error('connection terminated'));
      const mailer = { sendPasswordResetEmail: vi.fn(async () => {}) };

      await expect(issueToken('u_123', 'alice@example.com', mailer)).rejects.toThrow(
        'connection terminated',
      );
      expect(mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
    });
  });

  describe('findActiveToken', () => {
    it('resolves the owning user ID for a live credential', async () => {
      mockFindResetByHash.mockResolvedValueOnce({
        id: 'p_live',
        userId: 'u_123',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 3600_000),
        consumedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await findActiveToken('valid-raw-token');

      expect(result).toBe('u_123');
      expect(mockFindResetByHash).toHaveBeenCalledWith(hashResetToken('valid-raw-token'));
    });

    it.each([[undefined], [null], [''], [12345]])('returns null for %s input', async (input) => {
      const result = await findActiveToken(input);

      expect(result).toBeNull();
      expect(mockFindResetByHash).not.toHaveBeenCalled();
    });

    it('returns null for unknown, consumed, and expired rows', async () => {
      mockFindResetByHash.mockResolvedValueOnce(null);
      expect(await findActiveToken('unknown')).toBeNull();

      mockFindResetByHash.mockResolvedValueOnce({
        id: 'p_old',
        userId: 'u_123',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 3600_000),
        consumedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(await findActiveToken('consumed')).toBeNull();

      mockFindResetByHash.mockResolvedValueOnce({
        id: 'p_expired',
        userId: 'u_123',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() - 1000),
        consumedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(await findActiveToken('expired')).toBeNull();
    });
  });

  describe('completeReset', () => {
    const mockTx = {};

    function liveRow() {
      return {
        id: 'p_live',
        userId: 'u_123',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 3600_000),
        consumedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    function mockSuccessfulCompletion(): void {
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockFindResetByHash.mockResolvedValueOnce(liveRow());
        mockConsumeResetToken.mockResolvedValueOnce(true);
        mockUpdatePasswordHash.mockResolvedValueOnce(true);
        mockRevokeAllSessions.mockResolvedValueOnce(2);
        return fn(mockTx);
      });
    }

    it('atomically consumes, updates the password, and revokes all sessions', async () => {
      mockSuccessfulCompletion();

      await completeReset('valid-raw-token', 'u_123', '$2b$12$newhashvalue');

      expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
      expect(mockConsumeResetToken).toHaveBeenCalledWith('p_live', mockTx);
      expect(mockUpdatePasswordHash).toHaveBeenCalledWith('u_123', '$2b$12$newhashvalue', mockTx);
      expect(mockRevokeAllSessions).toHaveBeenCalledWith('u_123', mockTx);
      const consumeOrder = mockConsumeResetToken.mock.invocationCallOrder[0];
      const updateOrder = mockUpdatePasswordHash.mock.invocationCallOrder[0];
      const revokeOrder = mockRevokeAllSessions.mock.invocationCallOrder[0];
      expect(consumeOrder).toBeLessThan(updateOrder);
      expect(updateOrder).toBeLessThan(revokeOrder);
    });

    it('rejects rebound tokens whose row belongs to another user', async () => {
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockFindResetByHash.mockResolvedValueOnce({ ...liveRow(), userId: 'u_other' });
        return fn(mockTx);
      });

      await expect(completeReset('valid-raw-token', 'u_123', '$2b$12$newhashvalue')).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(AppError);
          expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_TOKEN);
          return true;
        },
      );
      expect(mockConsumeResetToken).not.toHaveBeenCalled();
      expect(mockUpdatePasswordHash).not.toHaveBeenCalled();
      expect(mockRevokeAllSessions).not.toHaveBeenCalled();
    });

    it('fails a lost consume race without touching password or sessions', async () => {
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockFindResetByHash.mockResolvedValueOnce(liveRow());
        mockConsumeResetToken.mockResolvedValueOnce(false);
        return fn(mockTx);
      });

      await expect(completeReset('valid-raw-token', 'u_123', '$2b$12$newhashvalue')).rejects.toSatisfy(
        (error: unknown) => error instanceof AppError,
      );
      expect(mockUpdatePasswordHash).not.toHaveBeenCalled();
      expect(mockRevokeAllSessions).not.toHaveBeenCalled();
    });

    it('rolls back consumption when the password update finds no credential', async () => {
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockFindResetByHash.mockResolvedValueOnce(liveRow());
        mockConsumeResetToken.mockResolvedValueOnce(true);
        mockUpdatePasswordHash.mockResolvedValueOnce(false);
        return fn(mockTx);
      });

      await expect(completeReset('valid-raw-token', 'u_123', '$2b$12$newhashvalue')).rejects.toSatisfy(
        (error: unknown) => error instanceof AppError,
      );
      expect(mockRevokeAllSessions).not.toHaveBeenCalled();
    });

    it('propagates unexpected database errors instead of converting them', async () => {
      mockPrismaTransaction.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(completeReset('valid-raw-token', 'u_123', '$2b$12$newhashvalue')).rejects.toThrow(
        'connection terminated',
      );
    });
  });

  describe('removeByUserId', () => {
    it('delegates deletion with the transaction client and reports the count', async () => {
      const { passwordResetRepository } = await import(
        '../repositories/password-reset.repository.js'
      );
      const spy = vi.spyOn(passwordResetRepository, 'removeByUserId').mockResolvedValueOnce(2);
      const mockTx = {};

      const result = await removeByUserId('u_123', mockTx as never);

      expect(result).toBe(2);
      expect(spy).toHaveBeenCalledWith('u_123', mockTx);
      spy.mockRestore();
    });
  });

  describe('exports', () => {
    it('exports passwordResetService with the lifecycle methods', () => {
      expect(passwordResetService.hashResetToken).toBe(hashResetToken);
      expect(passwordResetService.buildResetUrl).toBe(buildResetUrl);
      expect(passwordResetService.issueToken).toBe(issueToken);
      expect(passwordResetService.findActiveToken).toBe(findActiveToken);
      expect(passwordResetService.completeReset).toBe(completeReset);
      expect(passwordResetService.removeByUserId).toBe(removeByUserId);
      expect(passwordResetService.noopPasswordResetMailer).toBe(noopPasswordResetMailer);
    });
  });
});
