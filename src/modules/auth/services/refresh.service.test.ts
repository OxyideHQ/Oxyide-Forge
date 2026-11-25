import type { FastifyInstance } from 'fastify';
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

const mockFindUserById = vi.fn();

vi.mock('../../users/users.service.js', () => ({
  usersService: {
    findById: mockFindUserById,
  },
}));

const mockCreateSession = vi.fn();
const mockFindSessionById = vi.fn();
const mockRemoveSessions = vi.fn();
const mockRevokeFamily = vi.fn();

vi.mock('../repositories/session.repository.js', () => ({
  sessionRepository: {
    create: mockCreateSession,
    findById: mockFindSessionById,
    removeByUserId: mockRemoveSessions,
    revokeFamily: mockRevokeFamily,
  },
}));

const mockCreateRefreshToken = vi.fn();
const mockFindByTokenHash = vi.fn();
const mockFindRefreshById = vi.fn();
const mockConsumeIfActive = vi.fn();
const mockMarkSuperseded = vi.fn();
const mockRevokeOne = vi.fn();

vi.mock('../repositories/refresh-token.repository.js', () => ({
  refreshTokenRepository: {
    create: mockCreateRefreshToken,
    findByTokenHash: mockFindByTokenHash,
    findById: mockFindRefreshById,
    consumeIfActive: mockConsumeIfActive,
    markSuperseded: mockMarkSuperseded,
    revokeOne: mockRevokeOne,
  },
}));

const mockCreateAccessToken = vi.fn();

vi.mock('./token.service.js', () => ({
  createAccessToken: mockCreateAccessToken,
}));

const { hashRefreshToken, issueRefreshSession, refreshAccessToken, revokeRefreshToken, revokeSessionForRefreshToken, refreshService } = await import(
  './refresh.service.js'
);
const { config } = await import('../../../config/index.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('refreshService', () => {
  describe('hashRefreshToken', () => {
    it('produces the documented SHA-256 hex digest', () => {
      // Well-known SHA-256('test') vector — pins algorithm and encoding.
      expect(hashRefreshToken('test')).toBe(
        '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      );
    });

    it('is deterministic: the same raw token always yields the same hash', () => {
      expect(hashRefreshToken('some-raw-token')).toBe(hashRefreshToken('some-raw-token'));
    });

    it('returns a 64-character lowercase hex string', () => {
      expect(hashRefreshToken('anything')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('differs across inputs', () => {
      expect(hashRefreshToken('token-a')).not.toBe(hashRefreshToken('token-b'));
    });
  });

  describe('issueRefreshSession', () => {
    const mockTx = {};

    function mockSuccessfulIssuance(): void {
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateSession.mockResolvedValueOnce({
          id: 's_issued',
          userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
          expiresAt: new Date(Date.now() + config.auth.refreshTokenTtlSeconds * 1000),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        mockCreateRefreshToken.mockResolvedValueOnce({
          id: 'r_issued',
          sessionId: 's_issued',
          tokenHash: 'hash',
          expiresAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return fn(mockTx);
      });
    }

    it('issues a 256-bit base64url credential with a fresh session', async () => {
      mockSuccessfulIssuance();

      const result = await issueRefreshSession('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.sessionId).toBe('s_issued');
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('generates a different credential on every issuance', async () => {
      mockSuccessfulIssuance();
      const first = await issueRefreshSession('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');
      mockSuccessfulIssuance();
      const second = await issueRefreshSession('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(first.refreshToken).not.toBe(second.refreshToken);
    });

    it('persists only the hash — never the raw credential', async () => {
      mockSuccessfulIssuance();

      const result = await issueRefreshSession('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      const persistedHash = mockCreateRefreshToken.mock.calls[0][0].tokenHash;
      expect(persistedHash).toBe(hashRefreshToken(result.refreshToken));
      expect(persistedHash).not.toBe(result.refreshToken);
      const persistedStr = JSON.stringify(mockCreateRefreshToken.mock.calls[0][0]);
      expect(persistedStr).not.toContain(result.refreshToken);
    });

    it('creates session and instance inside one transaction with the same client', async () => {
      mockSuccessfulIssuance();

      await issueRefreshSession('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' }),
        mockTx,
      );
      expect(mockCreateRefreshToken).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's_issued' }),
        mockTx,
      );
    });

    it('sets expiry from the configured refresh lifetime', async () => {
      const before = Date.now();
      mockSuccessfulIssuance();

      await issueRefreshSession('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      const sessionExpiresAt = (mockCreateSession.mock.calls[0][0].expiresAt as Date).getTime();
      const instanceExpiresAt = (
        mockCreateRefreshToken.mock.calls[0][0].expiresAt as Date
      ).getTime();
      const expected = before + config.auth.refreshTokenTtlSeconds * 1000;
      expect(Math.abs(sessionExpiresAt - expected)).toBeLessThan(5000);
      expect(Math.abs(instanceExpiresAt - expected)).toBeLessThan(5000);
    });

    it('rejects when the transaction fails, delivering no credential', async () => {
      mockPrismaTransaction.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(issueRefreshSession('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T')).rejects.toThrow(
        'connection terminated',
      );
    });
  });

  describe('refreshAccessToken', () => {
    const mockApp = {} as FastifyInstance;
    const mockTx = {};
    const mockUser = {
      id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      email: 'alice@example.com',
      displayName: 'Alice',
      status: 'active',
      role: 'user',
      createdAt: new Date('2026-01-15T09:30:00.000Z'),
      updatedAt: new Date('2026-01-15T09:30:00.000Z'),
    };
    const sessionExpiry = new Date(Date.now() + 6 * 24 * 3600_000);

    function liveInstance() {
      return {
        id: 'r_live',
        sessionId: 's_live',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 3600_000),
        consumedAt: null,
        supersededBy: null,
        revokedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    function liveSession() {
      return {
        id: 's_live',
        userId: mockUser.id,
        expiresAt: sessionExpiry,
        revokedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    function mockPreChecks(user: unknown = mockUser): void {
      mockFindByTokenHash.mockResolvedValueOnce(liveInstance());
      mockFindSessionById.mockResolvedValueOnce(liveSession());
      mockFindUserById.mockResolvedValueOnce(user as never);
    }

    /**
     * Runs the rotation transaction body against stubbed repositories.
     * `outcome` controls the consume race: 'win' consumes and creates the
     * successor; 'lost-consumed' simulates a taken token (replay path);
     * 'lost-live' simulates a lost race on a live row (invalid path).
     */
    function mockRotation(outcome: 'win' | 'lost-consumed' | 'lost-live'): void {
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        if (outcome === 'win') {
          mockFindSessionById.mockResolvedValueOnce(liveSession());
          mockFindUserById.mockResolvedValueOnce(mockUser);
          mockConsumeIfActive.mockResolvedValueOnce(true);
          mockCreateRefreshToken.mockResolvedValueOnce({
            id: 'r_successor',
            sessionId: 's_live',
            tokenHash: 'successor-hash',
            expiresAt: sessionExpiry,
            consumedAt: null,
            supersededBy: null,
            revokedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          mockMarkSuperseded.mockResolvedValueOnce(undefined);
        } else if (outcome === 'lost-consumed') {
          mockFindSessionById.mockResolvedValueOnce(liveSession());
          mockFindUserById.mockResolvedValueOnce(mockUser);
          mockConsumeIfActive.mockResolvedValueOnce(false);
          mockFindRefreshById.mockResolvedValueOnce({
            ...liveInstance(),
            consumedAt: new Date(),
            supersededBy: 'r_successor',
          });
          mockRevokeFamily.mockResolvedValueOnce(true);
        } else {
          mockFindSessionById.mockResolvedValueOnce(liveSession());
          mockFindUserById.mockResolvedValueOnce(mockUser);
          mockConsumeIfActive.mockResolvedValueOnce(false);
          mockFindRefreshById.mockResolvedValueOnce(liveInstance());
        }
        return fn(mockTx);
      });
      mockCreateAccessToken.mockReturnValue('new-access-jwt');
    }

    it('rotates: consumes the old token and returns a successor plus access JWT', async () => {
      mockPreChecks();
      mockRotation('win');

      const result = await refreshAccessToken(mockApp, 'valid-raw-refresh-token');

      expect(result.accessToken).toBe('new-access-jwt');
      expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.refreshToken).not.toBe('valid-raw-refresh-token');
      expect(result.refreshExpiresAt).toEqual(sessionExpiry);
      expect(mockCreateAccessToken).toHaveBeenCalledWith(mockApp, { sub: mockUser.id });
    });

    it('atomically consumes exactly once inside one transaction', async () => {
      mockPreChecks();
      mockRotation('win');

      await refreshAccessToken(mockApp, 'valid-raw-refresh-token');

      expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
      expect(mockConsumeIfActive).toHaveBeenCalledWith('r_live', mockTx);
      expect(mockCreateRefreshToken).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's_live' }),
        mockTx,
      );
      expect(mockMarkSuperseded).toHaveBeenCalledWith('r_live', 'r_successor', mockTx);
      const consumeOrder = mockConsumeIfActive.mock.invocationCallOrder[0];
      const createOrder = mockCreateRefreshToken.mock.invocationCallOrder[0];
      const linkOrder = mockMarkSuperseded.mock.invocationCallOrder[0];
      expect(consumeOrder).toBeLessThan(createOrder);
      expect(createOrder).toBeLessThan(linkOrder);
    });

    it('keeps the successor in the same family with the absolute session expiry', async () => {
      mockPreChecks();
      mockRotation('win');

      const result = await refreshAccessToken(mockApp, 'valid-raw-refresh-token');

      const createInput = mockCreateRefreshToken.mock.calls[0][0];
      expect(createInput.sessionId).toBe('s_live');
      // Absolute boundary preserved: successor expires with the session, not
      // with a fresh TTL (no sliding window).
      expect(createInput.expiresAt).toEqual(sessionExpiry);
      expect(result.refreshExpiresAt).toEqual(sessionExpiry);
    });

    it('persists only the successor hash — never either raw credential', async () => {
      mockPreChecks();
      mockRotation('win');

      const result = await refreshAccessToken(mockApp, 'valid-raw-refresh-token');

      const persistedHash = mockCreateRefreshToken.mock.calls[0][0].tokenHash;
      expect(persistedHash).toBe(hashRefreshToken(result.refreshToken));
      expect(persistedHash).not.toBe(result.refreshToken);
      expect(JSON.stringify(mockCreateRefreshToken.mock.calls[0][0])).not.toContain(
        result.refreshToken,
      );
    });

    it('detects replay: a consumed credential invalidates the family and fails closed', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({ ...liveInstance(), consumedAt: new Date() });
      mockFindSessionById.mockResolvedValueOnce(liveSession());
      mockFindUserById.mockResolvedValueOnce(mockUser);
      mockRotation('lost-consumed');

      const error = await refreshAccessToken(mockApp, 'consumed-token').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_TOKEN);
      expect((error as AppError).statusCode).toBe(401);
      expect(mockRevokeFamily).toHaveBeenCalledWith('s_live', mockTx);
      expect(mockCreateRefreshToken).not.toHaveBeenCalled();
      expect(mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('treats a lost race on a live row as invalid without touching the family', async () => {
      mockPreChecks();
      mockRotation('lost-live');

      const error = await refreshAccessToken(mockApp, 'valid-raw-refresh-token').catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_TOKEN);
      expect(mockRevokeFamily).not.toHaveBeenCalled();
      expect(mockCreateRefreshToken).not.toHaveBeenCalled();
    });

    it('replays idempotently: a consumed token of a dead family changes nothing', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({ ...liveInstance(), consumedAt: new Date() });
      mockFindSessionById.mockResolvedValueOnce({ ...liveSession(), revokedAt: new Date() });

      const error = await refreshAccessToken(mockApp, 'consumed-token').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_TOKEN);
      expect(mockPrismaTransaction).not.toHaveBeenCalled();
      expect(mockRevokeFamily).not.toHaveBeenCalled();
    });

    it.each([
      ['missing (undefined)', undefined],
      ['missing (null)', null],
      ['empty string', ''],
      ['non-string', 12345],
    ])('rejects %s with the generic 401', async (_label, input) => {
      await expect(refreshAccessToken(mockApp, input)).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_TOKEN);
        expect((error as AppError).statusCode).toBe(401);
        return true;
      });
      expect(mockFindByTokenHash).not.toHaveBeenCalled();
    });

    it('rejects unknown, expired, orphaned, revoked, and inactive cases with byte-identical failures', async () => {
      const past = new Date(Date.now() - 1000);
      const future = new Date(Date.now() + 3600_000);
      const liveInstance = {
        id: 'r_live',
        sessionId: 's_live',
        tokenHash: 'hash',
        expiresAt: future,
        consumedAt: null,
        supersededBy: null,
        revokedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const liveSession = {
        id: 's_live',
        userId: mockUser.id,
        expiresAt: future,
        revokedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const cases: Array<{ name: string; setup: () => void }> = [
        {
          name: 'unknown hash',
          setup: () => mockFindByTokenHash.mockResolvedValueOnce(null),
        },
        {
          name: 'expired instance',
          setup: () => mockFindByTokenHash.mockResolvedValueOnce({ ...liveInstance, expiresAt: past }),
        },
        {
          name: 'revoked instance',
          setup: () => mockFindByTokenHash.mockResolvedValueOnce({ ...liveInstance, revokedAt: new Date() }),
        },
        {
          name: 'missing session',
          setup: () => {
            mockFindByTokenHash.mockResolvedValueOnce(liveInstance);
            mockFindSessionById.mockResolvedValueOnce(null);
          },
        },
        {
          name: 'revoked session',
          setup: () => {
            mockFindByTokenHash.mockResolvedValueOnce(liveInstance);
            mockFindSessionById.mockResolvedValueOnce({ ...liveSession, revokedAt: new Date() });
          },
        },
        {
          name: 'expired session',
          setup: () => {
            mockFindByTokenHash.mockResolvedValueOnce(liveInstance);
            mockFindSessionById.mockResolvedValueOnce({ ...liveSession, expiresAt: past });
          },
        },
        {
          name: 'deleted user',
          setup: () => {
            mockFindByTokenHash.mockResolvedValueOnce(liveInstance);
            mockFindSessionById.mockResolvedValueOnce(liveSession);
            mockFindUserById.mockResolvedValueOnce(null);
          },
        },
        {
          name: 'suspended user',
          setup: () => {
            mockFindByTokenHash.mockResolvedValueOnce(liveInstance);
            mockFindSessionById.mockResolvedValueOnce(liveSession);
            mockFindUserById.mockResolvedValueOnce({ ...mockUser, status: 'suspended' });
          },
        },
      ];

      const bodies: string[] = [];
      for (const testCase of cases) {
        testCase.setup();
        const error = await refreshAccessToken(mockApp, 'presented-token').catch(
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_TOKEN);
        expect((error as AppError).statusCode).toBe(401);
        bodies.push((error as AppError).message);
      }

      // No existence oracle: every cause produces the identical message.
      for (const message of bodies) {
        expect(message).toBe(bodies[0]);
      }
      // None of these open a rotation transaction.
      expect(mockPrismaTransaction).not.toHaveBeenCalled();
    });

    it('renders replay failures byte-identical to every other failure', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({ ...liveInstance(), consumedAt: new Date() });
      mockFindSessionById.mockResolvedValueOnce(liveSession());
      mockFindUserById.mockResolvedValueOnce(mockUser);
      mockRotation('lost-consumed');
      const replayError = await refreshAccessToken(mockApp, 'consumed-token').catch(
        (e: unknown) => e,
      );

      mockFindByTokenHash.mockResolvedValueOnce(null);
      const unknownError = await refreshAccessToken(mockApp, 'unknown-token').catch(
        (e: unknown) => e,
      );

      expect((replayError as AppError).message).toBe((unknownError as AppError).message);
      expect((replayError as AppError).code).toBe((unknownError as AppError).code);
    });

    it('looks the instance up by hash — never by raw token or scan', async () => {
      mockPreChecks();
      mockRotation('win');

      await refreshAccessToken(mockApp, 'valid-raw-refresh-token');

      expect(mockFindByTokenHash).toHaveBeenCalledWith(
        hashRefreshToken('valid-raw-refresh-token'),
      );
      expect(mockFindByTokenHash).toHaveBeenCalledTimes(1);
    });

    it('propagates unexpected database errors instead of converting them to 401', async () => {
      mockFindByTokenHash.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(refreshAccessToken(mockApp, 'any-token')).rejects.toThrow(
        'connection terminated',
      );
    });

    it('rolls the transaction back when successor persistence fails, keeping the old token usable', async () => {
      mockPreChecks();
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockFindSessionById.mockResolvedValueOnce(liveSession());
        mockFindUserById.mockResolvedValueOnce(mockUser);
        mockConsumeIfActive.mockResolvedValueOnce(true);
        mockCreateRefreshToken.mockRejectedValueOnce(new Error('connection terminated'));
        return fn(mockTx);
      });
      mockCreateAccessToken.mockReturnValue('new-access-jwt');

      await expect(refreshAccessToken(mockApp, 'valid-raw-refresh-token')).rejects.toThrow(
        'connection terminated',
      );
      // No access token is issued and no successor cookie material exists.
      expect(mockCreateAccessToken).not.toHaveBeenCalled();
      expect(mockMarkSuperseded).not.toHaveBeenCalled();
    });

    it('resolves the user through usersService, never a repository', async () => {
      mockPreChecks();
      mockRotation('win');

      await refreshAccessToken(mockApp, 'valid-raw-refresh-token');

      expect(mockFindUserById).toHaveBeenCalledWith(mockUser.id);
    });
  });

  describe('revokeRefreshToken', () => {
    it('revokes one instance and reports the transition', async () => {
      mockRevokeOne.mockResolvedValueOnce(true);

      const result = await revokeRefreshToken('r_live');

      expect(result).toBe(true);
      expect(mockRevokeOne).toHaveBeenCalledWith('r_live');
    });

    it('reports false for already-revoked and unknown IDs without error', async () => {
      mockRevokeOne.mockResolvedValueOnce(false);

      const result = await revokeRefreshToken('r_unknown');

      expect(result).toBe(false);
    });

    it('propagates database errors', async () => {
      mockRevokeOne.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(revokeRefreshToken('r_live')).rejects.toThrow('connection terminated');
    });
  });

  describe('revokeSessionForRefreshToken', () => {
    it('revokes the family identified by a live credential', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({ id: 'r_1', sessionId: 's_1' });
      mockRevokeFamily.mockResolvedValueOnce(true);

      const result = await revokeSessionForRefreshToken('raw-token');

      expect(mockFindByTokenHash).toHaveBeenCalledWith(hashRefreshToken('raw-token'));
      expect(mockRevokeFamily).toHaveBeenCalledWith('s_1');
      expect(result).toBe(true);
    });

    it('revokes the family for consumed and expired credentials alike', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({ id: 'r_old', sessionId: 's_old' });
      mockRevokeFamily.mockResolvedValueOnce(true);

      const result = await revokeSessionForRefreshToken('stale-token');

      expect(result).toBe(true);
      expect(mockRevokeFamily).toHaveBeenCalledWith('s_old');
    });

    it('reports false without revoking for unknown credentials', async () => {
      mockFindByTokenHash.mockResolvedValueOnce(null);

      const result = await revokeSessionForRefreshToken('unknown-token');

      expect(result).toBe(false);
      expect(mockRevokeFamily).not.toHaveBeenCalled();
    });

    it.each([[undefined], [null], [''], [12345]])(
      'reports false without lookup for %s input',
      async (input) => {
        const result = await revokeSessionForRefreshToken(input);

        expect(result).toBe(false);
        expect(mockFindByTokenHash).not.toHaveBeenCalled();
      },
    );

    it('propagates database errors instead of reporting success', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({ id: 'r_1', sessionId: 's_1' });
      mockRevokeFamily.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(revokeSessionForRefreshToken('raw-token')).rejects.toThrow(
        'connection terminated',
      );
    });
  });

  describe('exports', () => {
    it('exports refreshService with the lifecycle methods', () => {
      expect(refreshService.hashRefreshToken).toBe(hashRefreshToken);
      expect(refreshService.issueRefreshSession).toBe(issueRefreshSession);
      expect(refreshService.refreshAccessToken).toBe(refreshAccessToken);
      expect(refreshService.revokeRefreshToken).toBe(revokeRefreshToken);
      expect(refreshService.revokeSessionForRefreshToken).toBe(revokeSessionForRefreshToken);
    });
  });
});
