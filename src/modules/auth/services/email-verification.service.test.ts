import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const mockFindVerifyByHash = vi.fn();
const mockCreateVerifyToken = vi.fn();
const mockConsumeVerifyToken = vi.fn();
const mockInvalidateVerifyActive = vi.fn();
const mockRemoveVerifyTokens = vi.fn();

vi.mock('../repositories/email-verification.repository.js', () => ({
  emailVerificationRepository: {
    findByTokenHash: mockFindVerifyByHash,
    create: mockCreateVerifyToken,
    consumeIfActive: mockConsumeVerifyToken,
    invalidateActiveForUser: mockInvalidateVerifyActive,
    removeByUserId: mockRemoveVerifyTokens,
  },
}));

const {
  hashVerificationToken,
  buildVerificationUrl,
  issueToken,
  findActiveToken,
  removeByUserId,
  noopEmailVerificationMailer,
  emailVerificationService,
} = await import('./email-verification.service.js');
const { config } = await import('../../../config/index.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('emailVerificationService', () => {
  describe('hashVerificationToken', () => {
    it('produces the documented SHA-256 hex digest', () => {
      expect(hashVerificationToken('test')).toBe(
        '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      );
    });

    it('is deterministic and differs across inputs', () => {
      expect(hashVerificationToken('token-a')).toBe(hashVerificationToken('token-a'));
      expect(hashVerificationToken('token-a')).not.toBe(hashVerificationToken('token-b'));
      expect(hashVerificationToken('token-a')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('buildVerificationUrl', () => {
    it('builds an absolute verification link from configured base URL and raw token', () => {
      const url = buildVerificationUrl('raw-token-value');

      expect(url).toBe(`${config.appBaseUrl}/verify-email?token=raw-token-value`);
    });

    it('embeds only the token besides the documented path', () => {
      const url = buildVerificationUrl('raw-token-value');

      expect(url).not.toContain('@');
      const query = url.split('?')[1] ?? '';
      expect(Object.keys(Object.fromEntries(new URLSearchParams(query)))).toEqual(['token']);
    });
  });

  describe('noopEmailVerificationMailer', () => {
    it('resolves without delivering', async () => {
      await expect(
        noopEmailVerificationMailer.sendVerificationEmail({ to: 'a@b.com', verificationUrl: 'https://x/y' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('issueToken', () => {
    const mockTx = {};

    function mockSuccessfulIssue(): void {
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockInvalidateVerifyActive.mockResolvedValueOnce(1);
        mockCreateVerifyToken.mockResolvedValueOnce({
          id: 'e_issued',
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
      const sent: Array<{ to: string; verificationUrl: string }> = [];
      const mailer = {
        sendVerificationEmail: vi.fn(async (email: { to: string; verificationUrl: string }) => {
          sent.push(email);
        }),
      };

      await issueToken('u_123', 'alice@example.com', mailer);

      expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
      expect(mockInvalidateVerifyActive).toHaveBeenCalledWith('u_123', mockTx);
      const persistedHash = mockCreateVerifyToken.mock.calls[0][0].tokenHash;
      expect(persistedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('alice@example.com');
      expect(sent[0].verificationUrl.startsWith(`${config.appBaseUrl}/verify-email?token=`)).toBe(true);
      const deliveredRaw = sent[0].verificationUrl.split('token=')[1];
      expect(deliveredRaw).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(persistedHash).toBe(hashVerificationToken(deliveredRaw));
      expect(JSON.stringify(mockCreateVerifyToken.mock.calls[0][0])).not.toContain(deliveredRaw);
    });

    it('sets expiry from the configured verification lifetime', async () => {
      const before = Date.now();
      mockSuccessfulIssue();
      const mailer = { sendVerificationEmail: vi.fn(async () => {}) };

      await issueToken('u_123', 'alice@example.com', mailer);

      const expiresAt = mockCreateVerifyToken.mock.calls[0][0].expiresAt as Date;
      const expected = before + config.auth.emailVerificationTtlSeconds * 1000;
      expect(Math.abs(expiresAt.getTime() - expected)).toBeLessThan(5000);
    });

    it('propagates email failure without masking it as success', async () => {
      mockSuccessfulIssue();
      const mailer = {
        sendVerificationEmail: vi.fn(async () => {
          throw new Error('SMTP unreachable');
        }),
      };

      await expect(issueToken('u_123', 'alice@example.com', mailer)).rejects.toThrow(
        'SMTP unreachable',
      );
    });

    it('rejects when the transaction fails, delivering nothing', async () => {
      mockPrismaTransaction.mockRejectedValueOnce(new Error('connection terminated'));
      const mailer = { sendVerificationEmail: vi.fn(async () => {}) };

      await expect(issueToken('u_123', 'alice@example.com', mailer)).rejects.toThrow(
        'connection terminated',
      );
      expect(mailer.sendVerificationEmail).not.toHaveBeenCalled();
    });
  });

  describe('findActiveToken', () => {
    it('resolves the token identity for a live credential', async () => {
      mockFindVerifyByHash.mockResolvedValueOnce({
        id: 'e_live',
        userId: 'u_123',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 3600_000),
        consumedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await findActiveToken('valid-raw-token');

      expect(result).toEqual({ id: 'e_live', userId: 'u_123' });
      expect(mockFindVerifyByHash).toHaveBeenCalledWith(hashVerificationToken('valid-raw-token'));
    });

    it.each([[undefined], [null], [''], [12345]])('returns null for %s input', async (input) => {
      const result = await findActiveToken(input);

      expect(result).toBeNull();
      expect(mockFindVerifyByHash).not.toHaveBeenCalled();
    });

    it('returns null for unknown, consumed, and expired rows', async () => {
      mockFindVerifyByHash.mockResolvedValueOnce(null);
      expect(await findActiveToken('unknown')).toBeNull();

      mockFindVerifyByHash.mockResolvedValueOnce({
        id: 'e_old',
        userId: 'u_123',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 3600_000),
        consumedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(await findActiveToken('consumed')).toBeNull();

      mockFindVerifyByHash.mockResolvedValueOnce({
        id: 'e_expired',
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

  describe('removeByUserId', () => {
    it('delegates deletion with the transaction client and reports the count', async () => {
      const { emailVerificationRepository } = await import(
        '../repositories/email-verification.repository.js'
      );
      const spy = vi.spyOn(emailVerificationRepository, 'removeByUserId').mockResolvedValueOnce(2);
      const mockTx = {};

      const result = await removeByUserId('u_123', mockTx as never);

      expect(result).toBe(2);
      expect(spy).toHaveBeenCalledWith('u_123', mockTx);
      spy.mockRestore();
    });
  });

  describe('exports', () => {
    it('exports emailVerificationService with the lifecycle methods', () => {
      expect(emailVerificationService.hashVerificationToken).toBe(hashVerificationToken);
      expect(emailVerificationService.buildVerificationUrl).toBe(buildVerificationUrl);
      expect(emailVerificationService.issueToken).toBe(issueToken);
      expect(emailVerificationService.findActiveToken).toBe(findActiveToken);
      expect(emailVerificationService.removeByUserId).toBe(removeByUserId);
      expect(emailVerificationService.noopEmailVerificationMailer).toBe(noopEmailVerificationMailer);
    });
  });
});
