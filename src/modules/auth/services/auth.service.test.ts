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

const mockFindByEmail = vi.fn();
const mockCreateUser = vi.fn();
const mockFindUserById = vi.fn();
const mockUpdateUser = vi.fn();

vi.mock('../../../platform/database/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../users/users.service.js', () => ({
  usersService: {
    findByEmail: mockFindByEmail,
    create: mockCreateUser,
    findById: mockFindUserById,
    update: mockUpdateUser,
  },
}));

const mockCreateCredential = vi.fn();
const mockFindByUserId = vi.fn();

vi.mock('../repositories/credential.repository.js', () => ({
  credentialRepository: {
    create: mockCreateCredential,
    findByUserId: mockFindByUserId,
  },
}));

const mockHashPassword = vi.fn();
const mockVerifyPassword = vi.fn();
const mockValidatePasswordForSetting = vi.fn();

vi.mock('./password.service.js', () => ({
  hashPassword: mockHashPassword,
  verifyPassword: mockVerifyPassword,
  validatePasswordForSetting: mockValidatePasswordForSetting,
}));

const mockCreateAccessToken = vi.fn();

vi.mock('./token.service.js', () => ({
  createAccessToken: mockCreateAccessToken,
}));

const mockIssueRefreshSession = vi.fn();
const mockServiceRefreshAccessToken = vi.fn();
const mockRevokeSessionForRefreshToken = vi.fn();

vi.mock('./refresh.service.js', () => ({
  refreshService: {
    issueRefreshSession: mockIssueRefreshSession,
    refreshAccessToken: mockServiceRefreshAccessToken,
    revokeSessionForRefreshToken: mockRevokeSessionForRefreshToken,
  },
}));

const mockCheckLoginAllowed = vi.fn();
const mockRecordLoginFailure = vi.fn();
const mockClearAccountThrottle = vi.fn();
const mockThrottleDelay = vi.fn();
const mockCheckAccountLockout = vi.fn();
const mockRevalidateUnlockedForIssuance = vi.fn();

vi.mock('./login-throttle.service.js', () => ({
  loginThrottleService: {
    checkLoginAllowed: mockCheckLoginAllowed,
    recordLoginFailure: mockRecordLoginFailure,
    clearAccountThrottle: mockClearAccountThrottle,
    delay: mockThrottleDelay,
    checkAccountLockout: mockCheckAccountLockout,
    revalidateUnlockedForIssuance: mockRevalidateUnlockedForIssuance,
  },
}));

const mockCheckAndRecordRecoveryAttempt = vi.fn();

vi.mock('./recovery-throttle.service.js', () => ({
  recoveryThrottleService: {
    checkAndRecordRecoveryAttempt: mockCheckAndRecordRecoveryAttempt,
  },
}));

const mockIssueResetToken = vi.fn();
const mockFindActiveResetToken = vi.fn();
const mockCompleteReset = vi.fn();
const mockRemoveResetTokens = vi.fn();

vi.mock('./password-reset.service.js', () => ({
  passwordResetService: {
    issueToken: mockIssueResetToken,
    findActiveToken: mockFindActiveResetToken,
    completeReset: mockCompleteReset,
    removeByUserId: mockRemoveResetTokens,
  },
}));

const mockRevokeAllSessionsForUser = vi.fn();

vi.mock('./session.service.js', () => ({
  sessionService: {
    revokeAllSessionsForUser: mockRevokeAllSessionsForUser,
  },
}));

const mockFindActiveVerifyToken = vi.fn();
const mockIssueVerifyToken = vi.fn();
const mockHashVerifyToken = vi.fn((raw: string): string => `hashed:${raw}`);
const mockBuildVerifyUrl = vi.fn((raw: string): string => `https://app.example.com/verify-email?token=${raw}`);

vi.mock('./email-verification.service.js', () => ({
  emailVerificationService: {
    findActiveToken: mockFindActiveVerifyToken,
    issueToken: mockIssueVerifyToken,
    removeByUserId: vi.fn(),
  },
  hashVerificationToken: mockHashVerifyToken,
  buildVerificationUrl: mockBuildVerifyUrl,
  noopEmailVerificationMailer: { sendVerificationEmail: vi.fn(async () => {}) },
}));

const mockFindVerifyByHash = vi.fn();
const mockCreateVerifyToken = vi.fn();
const mockConsumeVerifyToken = vi.fn();

vi.mock('../repositories/email-verification.repository.js', () => ({
  emailVerificationRepository: {
    findByTokenHash: mockFindVerifyByHash,
    create: mockCreateVerifyToken,
    consumeIfActive: mockConsumeVerifyToken,
  },
}));

const {
  register,
  login,
  getCurrentUser,
  refreshAccessToken,
  logout,
  requestPasswordReset,
  resetPassword,
  resendVerificationEmail,
  confirmEmailVerification,
  revokeAllSessions,
  authService,
  DUMMY_PASSWORD_HASH,
} = await import('./auth.service.js');
const { config } = await import('../../../config/index.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockIssueRefreshSession.mockResolvedValue({
    refreshToken: 'mock-refresh-token-value',
    sessionId: 's_mocksession00000000000000001',
    expiresAt: new Date(Date.now() + 604800000),
  });
  mockCheckLoginAllowed.mockResolvedValue({ delayMs: 0 });
  mockRecordLoginFailure.mockResolvedValue(undefined);
  mockClearAccountThrottle.mockResolvedValue(undefined);
  mockThrottleDelay.mockResolvedValue(undefined);
  mockCheckAccountLockout.mockResolvedValue(undefined);
  mockRevalidateUnlockedForIssuance.mockResolvedValue(undefined);
  mockValidatePasswordForSetting.mockReturnValue(undefined);
  mockCheckAndRecordRecoveryAttempt.mockResolvedValue(undefined);
});

describe('authService', () => {
  describe('register', () => {
    const mockUser = {
      id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      email: 'alice@example.com',
      displayName: 'Alice',
      status: 'active',
      role: 'user',
      createdAt: new Date('2026-01-15T09:30:00.000Z'),
      updatedAt: new Date('2026-01-15T09:30:00.000Z'),
    };

    const mockCredential = {
      id: 'c_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      passwordHash: '$2b$12$hashedpasswordvalue',
      createdAt: new Date('2026-01-15T09:30:00.000Z'),
      updatedAt: new Date('2026-01-15T09:30:00.000Z'),
    };

    it('successfully registers a new user and returns the public User representation', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      const result = await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        displayName: 'Alice',
      });

      expect(result).toEqual({
        id: mockUser.id,
        email: 'alice@example.com',
        displayName: 'Alice',
        status: 'active',
        role: 'user',
        createdAt: '2026-01-15T09:30:00.000Z',
        updatedAt: '2026-01-15T09:30:00.000Z',
      });
    });

    it('creates the verification token in the same transaction and emails after commit', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      const mockTx = {};
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        mockCreateVerifyToken.mockResolvedValueOnce({ id: 'e_1' });
        return fn(mockTx);
      });
      const sent: Array<{ to: string; verificationUrl: string }> = [];
      const mailer = {
        sendVerificationEmail: vi.fn(async (email: { to: string; verificationUrl: string }) => {
          sent.push(email);
        }),
      };

      const result = await register(
        { email: 'alice@example.com', password: 'correct-horse-battery-staple' },
        mailer,
      );

      expect(result.id).toBe(mockUser.id);
      expect(mockCreateVerifyToken).toHaveBeenCalledWith(
        expect.objectContaining({ userId: mockUser.id }),
        mockTx,
      );
      const tokenHash = mockCreateVerifyToken.mock.calls[0][0].tokenHash as string;
      expect(typeof tokenHash).toBe('string');
      expect(tokenHash.length).toBeGreaterThan(0);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('alice@example.com');
      const deliveredRaw = sent[0].verificationUrl.split('token=')[1];
      expect(deliveredRaw).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The persisted value is the hash of the delivered raw (mocked hash here;
      // the real SHA-256 relationship is proven in the service and integration tests).
      expect(tokenHash).toBe(`hashed:${deliveredRaw}`);
    });

    it('rejects when verification persistence fails, delivering nothing', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        mockCreateVerifyToken.mockRejectedValueOnce(new Error('connection terminated'));
        return fn({});
      });
      const mailer = { sendVerificationEmail: vi.fn(async () => {}) };

      await expect(
        register({ email: 'alice@example.com', password: 'correct-horse-battery-staple' }, mailer),
      ).rejects.toThrow('connection terminated');
      expect(mailer.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it('propagates email failure while keeping the committed account', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        mockCreateVerifyToken.mockResolvedValueOnce({ id: 'e_1' });
        return fn({});
      });
      const mailer = {
        sendVerificationEmail: vi.fn(async () => {
          throw new Error('SMTP unreachable');
        }),
      };

      await expect(
        register({ email: 'alice@example.com', password: 'correct-horse-battery-staple' }, mailer),
      ).rejects.toThrow('SMTP unreachable');
    });

    it('normalizes email by trimming whitespace and lowercasing', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      await register({
        email: '  User@Example.COM  ',
        password: 'correct-horse-battery-staple',
      });

      expect(mockFindByEmail).toHaveBeenCalledWith('user@example.com');
    });

    it('persists the normalized email in the User creation', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      await register({
        email: '  User@Example.COM  ',
        password: 'correct-horse-battery-staple',
      });

      expect(mockCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'user@example.com',
        }),
        expect.anything(),
      );
    });

    it('returns the normalized email in the public User representation', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      const result = await register({
        email: '  User@Example.COM  ',
        password: 'correct-horse-battery-staple',
      });

      expect(result.email).toBe('alice@example.com');
    });

    it('uses the password service to hash the password', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });

      expect(mockHashPassword).toHaveBeenCalledWith('correct-horse-battery-staple');
    });

    it('validates the password before checking email existence (no 409/400 oracle)', async () => {
      const policyError = new AppError(ErrorCodes.AUTH_INVALID_PASSWORD, 400, 'Too long.');
      mockValidatePasswordForSetting.mockImplementationOnce(() => {
        throw policyError;
      });

      await expect(
        register({ email: 'alice@example.com', password: 'b'.repeat(73) }),
      ).rejects.toBe(policyError);
      expect(mockFindByEmail).not.toHaveBeenCalled();
      expect(mockHashPassword).not.toHaveBeenCalled();
    });

    it('never persists the plaintext password', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });

      expect(mockCreateCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          passwordHash: '$2b$12$hashedpasswordvalue',
        }),
        expect.anything(),
      );

      const credentialCall = mockCreateCredential.mock.calls[0][0];
      expect(credentialCall.passwordHash).not.toBe('correct-horse-battery-staple');
    });

    it('passes displayName to the user creation', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        displayName: 'Alice',
      });

      expect(mockCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: 'Alice',
        }),
        expect.anything(),
      );
    });

    it('defaults displayName to null when not provided', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });

      expect(mockCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: null,
        }),
        expect.anything(),
      );
    });

    it('creates User and Credential inside one database transaction', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });

      expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
      expect(mockCreateUser).toHaveBeenCalledTimes(1);
      expect(mockCreateCredential).toHaveBeenCalledTimes(1);
    });

    it('both repositories receive the same transaction-scoped client', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');

      const mockTx = { /* mock transaction client */ };
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn(mockTx);
      });

      await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });

      const userCreateTx = mockCreateUser.mock.calls[0][1];
      const credentialCreateTx = mockCreateCredential.mock.calls[0][1];
      expect(userCreateTx).toBe(mockTx);
      expect(credentialCreateTx).toBe(mockTx);
    });

    it('throws USERS_EMAIL_TAKEN when the email already exists', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);

      await expect(
        register({
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.USERS_EMAIL_TAKEN);
        expect((error as AppError).statusCode).toBe(409);
        expect((error as AppError).message).toBe('A user with this email already exists.');
        return true;
      });
    });

    it('does not hash the password or create records when email already exists', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);

      try {
        await register({
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        });
      } catch {
        // Expected error
      }

      expect(mockHashPassword).not.toHaveBeenCalled();
      expect(mockPrismaTransaction).not.toHaveBeenCalled();
    });

    it('maps Prisma unique constraint violation on email to USERS_EMAIL_TAKEN', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');

      const prismaError = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['email'] },
      });

      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockRejectedValueOnce(prismaError);
        return fn({});
      });

      await expect(
        register({
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.USERS_EMAIL_TAKEN);
        expect((error as AppError).statusCode).toBe(409);
        expect((error as AppError).message).toBe('A user with this email already exists.');
        return true;
      });
    });

    it('rolls back the transaction when credential creation fails', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');

      const dbError = new Error('Database connection lost');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockRejectedValueOnce(dbError);
        return fn({});
      });

      await expect(
        register({
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        }),
      ).rejects.toThrow('Database connection lost');

      expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
      expect(mockCreateUser).toHaveBeenCalledTimes(1);
    });

    it('returns only the public User representation with no internal fields', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      const result = await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });

      const keys = Object.keys(result);
      expect(keys).toEqual(['id', 'email', 'displayName', 'status', 'role', 'createdAt', 'updatedAt']);

      expect(result).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('credential');
    });

    it('does not generate an access token', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      const result = await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });

      expect(result).not.toHaveProperty('accessToken');
      expect(result).not.toHaveProperty('token');
    });

    it('does not set a cookie or create a session', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      const result = await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });

      expect(result).not.toHaveProperty('sessionId');
      expect(result).not.toHaveProperty('refreshToken');
    });

    it('converts timestamps to ISO 8601 UTC strings with millisecond precision', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      const result = await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });

      expect(result.createdAt).toBe('2026-01-15T09:30:00.000Z');
      expect(result.updatedAt).toBe('2026-01-15T09:30:00.000Z');

      expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('generates unique IDs for User and Credential', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });

      const userCreateInput = mockCreateUser.mock.calls[0][0];
      expect(userCreateInput.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      const credentialCreateInput = mockCreateCredential.mock.calls[0][0];
      expect(credentialCreateInput.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      expect(userCreateInput.id).not.toBe(credentialCreateInput.id);
    });

    it('sets user status to active by default', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });

      expect(mockCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'active',
        }),
        expect.anything(),
      );
    });

    it('links credential to the created user via userId', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce(mockUser);
        mockCreateCredential.mockResolvedValueOnce(mockCredential);
        return fn({});
      });

      await register({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });

      const credentialInput = mockCreateCredential.mock.calls[0][0];
      expect(credentialInput.userId).toBe(mockUser.id);
    });
  });

  describe('login', () => {
    const mockUser = {
      id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      email: 'alice@example.com',
      displayName: 'Alice',
      status: 'active',
      role: 'user',
      lockedUntil: null,
      createdAt: new Date('2026-01-15T09:30:00.000Z'),
      updatedAt: new Date('2026-01-15T09:30:00.000Z'),
    };

    const mockCredential = {
      id: 'c_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      userId: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      passwordHash: '$2b$12$hashedpasswordvalue',
      createdAt: new Date('2026-01-15T09:30:00.000Z'),
      updatedAt: new Date('2026-01-15T09:30:00.000Z'),
    };

    const mockApp = {} as FastifyInstance;

    it('successfully logs in and returns access token with public User', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      const result = await login(mockApp, {
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      expect(result.accessToken).toBe('mock-jwt-token');
      expect(result.user).toEqual({
        id: mockUser.id,
        email: 'alice@example.com',
        displayName: 'Alice',
        status: 'active',
        role: 'user',
        createdAt: '2026-01-15T09:30:00.000Z',
        updatedAt: '2026-01-15T09:30:00.000Z',
      });
    });

    it('normalizes email by trimming whitespace and lowercasing', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      await login(mockApp, {
        email: '  Alice@Example.COM  ',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      expect(mockFindByEmail).toHaveBeenCalledWith('alice@example.com');
    });

    it('passes the normalized email to usersService', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      await login(mockApp, {
        email: '  ALICE@example.com  ',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      expect(mockFindByEmail).toHaveBeenCalledTimes(1);
      expect(mockFindByEmail).toHaveBeenCalledWith('alice@example.com');
    });

    it('looks up credential using the User ID', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      await login(mockApp, {
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      expect(mockFindByUserId).toHaveBeenCalledWith(mockUser.id);
    });

    it('calls verifyPassword with the plaintext and stored hash', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      await login(mockApp, {
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      expect(mockVerifyPassword).toHaveBeenCalledWith(
        'correct-horse-battery-staple',
        '$2b$12$hashedpasswordvalue',
      );
    });

    it('verifies unknown emails against the dummy hash (M3.18 F-1 timing equalization)', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);

      await expect(
        login(mockApp, {
          email: 'nobody@example.com',
          password: 'correct-horse-battery-staple',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => error instanceof AppError);

      // One bcrypt is always spent, so the 401 timing cannot distinguish an
      // unknown email from a wrong password.
      expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
      expect(mockVerifyPassword).toHaveBeenCalledWith(
        'correct-horse-battery-staple',
        DUMMY_PASSWORD_HASH,
      );
    });

    it('verifies missing credentials against the dummy hash', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(null);
      mockVerifyPassword.mockResolvedValueOnce(false);

      await expect(
        login(mockApp, {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => error instanceof AppError);

      expect(mockVerifyPassword).toHaveBeenCalledWith(
        'correct-horse-battery-staple',
        DUMMY_PASSWORD_HASH,
      );
    });

    it('never authenticates from the dummy hash alone, even on a true compare', async () => {
      // Even if the presented password matches the dummy preimage, the login
      // additionally requires a real user row and credential.
      mockFindByEmail.mockResolvedValueOnce(null);
      mockVerifyPassword.mockResolvedValueOnce(true);

      await expect(
        login(mockApp, {
          email: 'ghost@example.com',
          password: 'anything-at-all',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
        return true;
      });

      expect(mockIssueRefreshSession).not.toHaveBeenCalled();
      expect(mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('throws AUTH_INVALID_CREDENTIALS with 401 for wrong password', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(false);

      await expect(
        login(mockApp, {
          email: 'alice@example.com',
          password: 'wrong-password',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
        expect((error as AppError).statusCode).toBe(401);
        expect((error as AppError).message).toBe('The email or password is incorrect.');
        return true;
      });
    });

    it('throws AUTH_INVALID_CREDENTIALS with 401 for unknown email', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);

      await expect(
        login(mockApp, {
          email: 'nobody@example.com',
          password: 'correct-horse-battery-staple',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
        expect((error as AppError).statusCode).toBe(401);
        expect((error as AppError).message).toBe('The email or password is incorrect.');
        return true;
      });
    });

    it('throws AUTH_INVALID_CREDENTIALS with 401 for missing credential', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(null);

      await expect(
        login(mockApp, {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
        expect((error as AppError).statusCode).toBe(401);
        expect((error as AppError).message).toBe('The email or password is incorrect.');
        return true;
      });
    });

    it('unknown email and wrong password produce identical error shape', async () => {
      // Test unknown email
      mockFindByEmail.mockResolvedValueOnce(null);
      try {
        await login(mockApp, { email: 'nobody@example.com', password: 'any', clientIp: '203.0.113.7' });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        const errA = error as AppError;

        // Test wrong password
        mockFindByEmail.mockResolvedValueOnce(mockUser);
        mockFindByUserId.mockResolvedValueOnce(mockCredential);
        mockVerifyPassword.mockResolvedValueOnce(false);
        try {
          await login(mockApp, {
            email: 'alice@example.com',
            password: 'wrong',
            clientIp: '203.0.113.7',
          });
          expect.unreachable();
        } catch (error2) {
          expect(error2).toBeInstanceOf(AppError);
          const errB = error2 as AppError;

          expect(errA.code).toBe(errB.code);
          expect(errA.statusCode).toBe(errB.statusCode);
          expect(errA.message).toBe(errB.message);
        }
      }
    });

    it('calls token service only after successful password verification', async () => {
      // Wrong password — token service should NOT be called
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(false);

      try {
        await login(mockApp, {
          email: 'alice@example.com',
          password: 'wrong-password',
          clientIp: '203.0.113.7',
        });
      } catch {
        // Expected
      }

      expect(mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('passes the correct user subject to token service', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      await login(mockApp, {
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      expect(mockCreateAccessToken).toHaveBeenCalledWith(mockApp, {
        sub: mockUser.id,
      });
    });

    it('does not return passwordHash in the result', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      const result = await login(mockApp, {
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('does not return plaintext password in the result', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      const result = await login(mockApp, {
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain('correct-horse-battery-staple');
    });

    it('returns the raw refresh token for cookie delivery without cookie/session-id leakage', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      const result = await login(mockApp, {
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      expect(typeof result.refreshToken).toBe('string');
      expect(result.refreshToken.length).toBeGreaterThan(0);
      expect(result).not.toHaveProperty('cookie');
      expect(result).not.toHaveProperty('sessionId');
    });

    it('issues exactly one refresh session after successful password verification', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      await login(mockApp, {
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      expect(mockIssueRefreshSession).toHaveBeenCalledTimes(1);
      expect(mockIssueRefreshSession).toHaveBeenCalledWith(mockUser.id);
      // Login persists only the refresh session — never users, credentials, or hashes.
      expect(mockCreateUser).not.toHaveBeenCalled();
      expect(mockCreateCredential).not.toHaveBeenCalled();
      expect(mockHashPassword).not.toHaveBeenCalled();
    });

    it('does not issue a refresh session when credentials are invalid', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(false);

      await expect(
        login(mockApp, {
          email: 'alice@example.com',
          password: 'wrong-password',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => error instanceof AppError);

      expect(mockIssueRefreshSession).not.toHaveBeenCalled();
    });

    it('fails login without credentials when session persistence fails', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');
      mockIssueRefreshSession.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(
        login(mockApp, {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toThrow('connection terminated');
    });

    it('accesses User repository only through usersService', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      await login(mockApp, {
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      // If auth.service imported user.repository.js directly, the usersService mock would not have been called
      expect(mockFindByEmail).toHaveBeenCalledTimes(1);
    });

    it('evaluates lockout, then throttling, before credential lookup', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      await login(mockApp, {
        email: '  Alice@Example.COM  ',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      // M3.16 order: user lookup first (lock state lives on the User row),
      // then the lock gate, then throttle enforcement — all before any
      // credential or password work.
      expect(mockFindByEmail).toHaveBeenCalledWith('alice@example.com');
      expect(mockCheckAccountLockout).toHaveBeenCalledTimes(1);
      expect(mockCheckAccountLockout).toHaveBeenCalledWith(mockUser.id, null);
      expect(mockCheckLoginAllowed).toHaveBeenCalledTimes(1);
      expect(mockCheckLoginAllowed).toHaveBeenCalledWith({
        normalizedEmail: 'alice@example.com',
        clientIp: '203.0.113.7',
      });
      const lookupOrder = mockFindByEmail.mock.invocationCallOrder[0];
      const lockOrder = mockCheckAccountLockout.mock.invocationCallOrder[0];
      const checkOrder = mockCheckLoginAllowed.mock.invocationCallOrder[0];
      const credentialOrder = mockFindByUserId.mock.invocationCallOrder[0];
      expect(lookupOrder).toBeLessThan(lockOrder);
      expect(lockOrder).toBeLessThan(checkOrder);
      expect(checkOrder).toBeLessThan(credentialOrder);
    });

    it('propagates the throttled 429 without touching password state', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockCheckLoginAllowed.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS, 429, 'Too many login attempts.'),
      );

      await expect(
        login(mockApp, {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS);
        expect((error as AppError).statusCode).toBe(429);
        return true;
      });

      // The user lookup runs (lock state lives on the row), but nothing
      // password-related is touched once throttling rejects.
      expect(mockFindByEmail).toHaveBeenCalledTimes(1);
      expect(mockCheckAccountLockout).toHaveBeenCalledTimes(1);
      expect(mockFindByUserId).not.toHaveBeenCalled();
      expect(mockVerifyPassword).not.toHaveBeenCalled();
      expect(mockRecordLoginFailure).not.toHaveBeenCalled();
      expect(mockClearAccountThrottle).not.toHaveBeenCalled();
      expect(mockCreateAccessToken).not.toHaveBeenCalled();
      expect(mockIssueRefreshSession).not.toHaveBeenCalled();
    });

    it('rejects a locked account before throttle enforcement or password work', async () => {
      const lockedUser = { ...mockUser, lockedUntil: new Date(Date.now() + 60000) };
      mockFindByEmail.mockResolvedValueOnce(lockedUser);
      mockCheckAccountLockout.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS, 429, 'Too many login attempts.'),
      );

      await expect(
        login(mockApp, {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS);
        expect((error as AppError).statusCode).toBe(429);
        return true;
      });

      expect(mockCheckAccountLockout).toHaveBeenCalledWith(
        lockedUser.id,
        lockedUser.lockedUntil,
      );
      expect(mockCheckLoginAllowed).not.toHaveBeenCalled();
      expect(mockThrottleDelay).not.toHaveBeenCalled();
      expect(mockFindByUserId).not.toHaveBeenCalled();
      expect(mockVerifyPassword).not.toHaveBeenCalled();
      expect(mockRecordLoginFailure).not.toHaveBeenCalled();
      expect(mockIssueRefreshSession).not.toHaveBeenCalled();
    });

    it('blocks session issuance when a lock lands during password verification', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockRevalidateUnlockedForIssuance.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS, 429, 'Too many login attempts.'),
      );

      await expect(
        login(mockApp, {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(429);
        return true;
      });

      expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
      expect(mockClearAccountThrottle).not.toHaveBeenCalled();
      expect(mockCreateAccessToken).not.toHaveBeenCalled();
      expect(mockIssueRefreshSession).not.toHaveBeenCalled();
    });

    it('propagates lock-gate store failure instead of bypassing the lock', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockCheckAccountLockout.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(
        login(mockApp, {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toThrow('connection terminated');

      expect(mockCheckLoginAllowed).not.toHaveBeenCalled();
      expect(mockIssueRefreshSession).not.toHaveBeenCalled();
    });

    it('records the failure with the normalized identity on wrong password', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(false);

      await expect(
        login(mockApp, {
          email: '  Alice@Example.COM  ',
          password: 'wrong-password',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => error instanceof AppError);

      expect(mockRecordLoginFailure).toHaveBeenCalledTimes(1);
      expect(mockRecordLoginFailure).toHaveBeenCalledWith(
        {
          normalizedEmail: 'alice@example.com',
          clientIp: '203.0.113.7',
        },
        'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      );
      expect(mockClearAccountThrottle).not.toHaveBeenCalled();
    });

    it('records the failure identically for unknown emails', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);

      await expect(
        login(mockApp, {
          email: '  Ghost@Example.COM  ',
          password: 'any-password',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => error instanceof AppError);

      expect(mockRecordLoginFailure).toHaveBeenCalledTimes(1);
      expect(mockRecordLoginFailure).toHaveBeenCalledWith(
        {
          normalizedEmail: 'ghost@example.com',
          clientIp: '203.0.113.7',
        },
        null,
      );
    });

    it('propagates throttle-store failure instead of masking it as 401', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(false);
      mockRecordLoginFailure.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(
        login(mockApp, {
          email: 'alice@example.com',
          password: 'wrong-password',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toThrow('connection terminated');
    });

    it('clears account throttle state on successful login', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      await login(mockApp, {
        email: '  Alice@Example.COM  ',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      expect(mockClearAccountThrottle).toHaveBeenCalledTimes(1);
      expect(mockClearAccountThrottle).toHaveBeenCalledWith('alice@example.com');
      expect(mockRecordLoginFailure).not.toHaveBeenCalled();
    });

    it('applies the progressive delay after the lock gate and before password work', async () => {
      mockCheckLoginAllowed.mockResolvedValueOnce({ delayMs: 500 });
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      await login(mockApp, {
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      expect(mockThrottleDelay).toHaveBeenCalledTimes(1);
      expect(mockThrottleDelay).toHaveBeenCalledWith(500);
      // M3.16 order: user lookup, lock gate, throttle check, delay —
      // all before credential lookup and password verification.
      const lookupOrder = mockFindByEmail.mock.invocationCallOrder[0];
      const lockOrder = mockCheckAccountLockout.mock.invocationCallOrder[0];
      const checkOrder = mockCheckLoginAllowed.mock.invocationCallOrder[0];
      const delayOrder = mockThrottleDelay.mock.invocationCallOrder[0];
      const credentialOrder = mockFindByUserId.mock.invocationCallOrder[0];
      const verifyOrder = mockVerifyPassword.mock.invocationCallOrder[0];
      expect(lookupOrder).toBeLessThan(lockOrder);
      expect(lockOrder).toBeLessThan(checkOrder);
      expect(checkOrder).toBeLessThan(delayOrder);
      expect(delayOrder).toBeLessThan(credentialOrder);
      expect(credentialOrder).toBeLessThan(verifyOrder);
    });

    it('skips the delay when the throttle state requires none', async () => {
      mockCheckLoginAllowed.mockResolvedValueOnce({ delayMs: 0 });
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

      await login(mockApp, {
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        clientIp: '203.0.113.7',
      });

      expect(mockThrottleDelay).not.toHaveBeenCalled();
      expect(mockFindByEmail).toHaveBeenCalledTimes(1);
    });

    it('delays failed logins identically for unknown emails', async () => {
      mockCheckLoginAllowed.mockResolvedValueOnce({ delayMs: 250 });
      mockFindByEmail.mockResolvedValueOnce(null);

      await expect(
        login(mockApp, {
          email: 'ghost@example.com',
          password: 'any-password',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toSatisfy((error: unknown) => error instanceof AppError);

      expect(mockThrottleDelay).toHaveBeenCalledTimes(1);
      expect(mockThrottleDelay).toHaveBeenCalledWith(250);
    });

    it('propagates throttle-reset failure instead of issuing a session', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockClearAccountThrottle.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(
        login(mockApp, {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
          clientIp: '203.0.113.7',
        }),
      ).rejects.toThrow('connection terminated');

      expect(mockIssueRefreshSession).not.toHaveBeenCalled();
    });

    it('sends one account-locked notice when THIS failure performs the transition', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(false);
      mockRecordLoginFailure.mockResolvedValueOnce({ transitionedToLocked: true });
      // M11.4: the port carries facts, not rendered content, so the service
      // layer is asserted on what it owns — canonical recipient and the
      // policy-derived duration.
      const sent: Array<{ to: string; lockoutDurationText: string }> = [];
      const mailer = {
        sendAccountLocked: vi.fn(async (email: { to: string; lockoutDurationText: string }) => {
          sent.push(email);
        }),
        sendPasswordResetSucceeded: vi.fn(async () => {}),
      };
      const logger = { error: vi.fn() };

      await expect(
        login(
          mockApp,
          { email: 'alice@example.com', password: 'wrong-password', clientIp: '203.0.113.7' },
          { securityNotificationMailer: mailer, securityNotificationLogger: logger },
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
        expect((error as AppError).statusCode).toBe(401);
        return true;
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('alice@example.com');
      const minutes = Math.round(config.auth.accountLockout.lockoutDurationSeconds / 60);
      expect(sent[0].lockoutDurationText).toBe(`${minutes} minutes`);
      expect(Object.keys(sent[0]).sort()).toEqual(['lockoutDurationText', 'to']);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('sends no notice when the failure does not transition the lock', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(false);
      mockRecordLoginFailure.mockResolvedValueOnce({ transitionedToLocked: false });
      const mailer = {
        sendAccountLocked: vi.fn(async () => {}),
        sendPasswordResetSucceeded: vi.fn(async () => {}),
      };

      await expect(
        login(
          mockApp,
          { email: 'alice@example.com', password: 'wrong-password', clientIp: '203.0.113.7' },
          { securityNotificationMailer: mailer },
        ),
      ).rejects.toSatisfy((error: unknown) => error instanceof AppError);

      expect(mailer.sendAccountLocked).not.toHaveBeenCalled();
    });

    it('sends no notice for unknown emails', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);
      mockRecordLoginFailure.mockResolvedValueOnce(undefined);

      const mailer = {
        sendAccountLocked: vi.fn(async () => {}),
        sendPasswordResetSucceeded: vi.fn(async () => {}),
      };

      await expect(
        login(
          mockApp,
          { email: 'ghost@example.com', password: 'any-password', clientIp: '203.0.113.7' },
          { securityNotificationMailer: mailer },
        ),
      ).rejects.toSatisfy((error: unknown) => error instanceof AppError);

      expect(mailer.sendAccountLocked).not.toHaveBeenCalled();
    });

    it('keeps the 401 and logs safely when the lockout notice fails', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(false);
      mockRecordLoginFailure.mockResolvedValueOnce({ transitionedToLocked: true });
      const secret = 'fake-provider-secret-xyz-999';
      const mailer = {
        sendAccountLocked: vi.fn(async () => {
          throw Object.assign(new Error(`provider rejected with ${secret}`), { name: 'SMTPError' });
        }),
        sendPasswordResetSucceeded: vi.fn(async () => {}),
      };
      const logger = { error: vi.fn() };

      await expect(
        login(
          mockApp,
          { email: 'alice@example.com', password: 'wrong-password', clientIp: '203.0.113.7' },
          { securityNotificationMailer: mailer, securityNotificationLogger: logger },
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(401);
        expect((error as AppError).message).toBe('The email or password is incorrect.');
        return true;
      });

      expect(logger.error).toHaveBeenCalledTimes(1);
      const serialized = JSON.stringify(logger.error.mock.calls[0]);
      expect(serialized).toContain('ACCOUNT_LOCKED');
      expect(serialized).toContain(mockUser.id);
      expect(serialized).not.toContain('alice@example.com');
      expect(serialized).not.toContain(secret);
    });

    it('sends no notice when failure recording itself fails', async () => {
      mockFindByEmail.mockResolvedValueOnce(mockUser);
      mockFindByUserId.mockResolvedValueOnce(mockCredential);
      mockVerifyPassword.mockResolvedValueOnce(false);
      mockRecordLoginFailure.mockRejectedValueOnce(new Error('connection terminated'));
      const mailer = {
        sendAccountLocked: vi.fn(async () => {}),
        sendPasswordResetSucceeded: vi.fn(async () => {}),
      };

      await expect(
        login(
          mockApp,
          { email: 'alice@example.com', password: 'wrong-password', clientIp: '203.0.113.7' },
          { securityNotificationMailer: mailer },
        ),
      ).rejects.toThrow('connection terminated');

      expect(mailer.sendAccountLocked).not.toHaveBeenCalled();
    });

    it('rejects suspended and inactive accounts exactly like wrong passwords (M3.19 FIND-05)', async () => {
      for (const status of ['suspended', 'inactive']) {
        mockFindByEmail.mockResolvedValueOnce({ ...mockUser, status });
        mockFindByUserId.mockResolvedValueOnce(mockCredential);
        mockVerifyPassword.mockResolvedValueOnce(true);
        mockCreateAccessToken.mockReturnValueOnce('mock-jwt-token');

        await expect(
          login(mockApp, {
            email: 'alice@example.com',
            password: 'correct-horse-battery-staple',
            clientIp: '203.0.113.7',
          }),
        ).rejects.toSatisfy((error: unknown) => {
          expect(error).toBeInstanceOf(AppError);
          expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
          expect((error as AppError).statusCode).toBe(401);
          expect((error as AppError).message).toBe('The email or password is incorrect.');
          return true;
        });

        // The failure is recorded identically (bcrypt already spent above),
        // and nothing is issued.
        expect(mockRecordLoginFailure).toHaveBeenCalledWith(
          { normalizedEmail: 'alice@example.com', clientIp: '203.0.113.7' },
          mockUser.id,
        );
        expect(mockCreateAccessToken).not.toHaveBeenCalled();
        expect(mockIssueRefreshSession).not.toHaveBeenCalled();
      }
    });
  });

  describe('module boundary', () => {
    it('uses usersService (not usersRepository) for cross-module user access', async () => {
      // The mock is set up for users.service.js — if auth.service imported
      // user.repository.js directly, mockFindByEmail would not be called.
      mockFindByEmail.mockResolvedValueOnce(null);
      mockHashPassword.mockResolvedValueOnce('$2b$12$hashedpasswordvalue');
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        mockCreateUser.mockResolvedValueOnce({
          id: 'u_test',
          email: 'test@example.com',
          displayName: null,
          status: 'active',
          role: 'user',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        mockCreateCredential.mockResolvedValueOnce({
          id: 'c_test',
          userId: 'u_test',
          passwordHash: '$2b$12$hash',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return fn({});
      });

      await register({
        email: 'test@example.com',
        password: 'correct-horse-battery-staple',
      });

      // If auth.service used usersRepository directly, this mock would not have been called
      expect(mockFindByEmail).toHaveBeenCalledTimes(1);
      expect(mockCreateUser).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCurrentUser', () => {
    const mockUser = {
      id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      email: 'alice@example.com',
      displayName: 'Alice',
      status: 'active',
      role: 'user',
      createdAt: new Date('2026-01-15T09:30:00.000Z'),
      updatedAt: new Date('2026-01-15T09:30:00.000Z'),
    };

    it('returns the public user for an existing user id', async () => {
      mockFindUserById.mockResolvedValueOnce(mockUser);

      const result = await getCurrentUser('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(mockFindUserById).toHaveBeenCalledWith('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');
      expect(result).toEqual({
        ...mockUser,
        createdAt: '2026-01-15T09:30:00.000Z',
        updatedAt: '2026-01-15T09:30:00.000Z',
      });
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('throws 401 AUTH_INVALID_TOKEN when the user no longer exists', async () => {
      mockFindUserById.mockResolvedValueOnce(null);

      const error = await getCurrentUser('u_deleteduser00000000000000000').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(401);
      expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_TOKEN);
    });

    it('propagates unexpected repository errors', async () => {
      mockFindUserById.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(getCurrentUser('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T')).rejects.toThrow(
        'connection terminated',
      );
    });
  });

  describe('refreshAccessToken', () => {
    const mockApp = {} as FastifyInstance;

    it('delegates to the refresh service with the application and raw credential', async () => {
      const rotated = {
        accessToken: 'new-access-jwt',
        refreshToken: 'successor-raw-token',
        refreshExpiresAt: new Date('2026-02-15T09:30:00.000Z'),
      };
      mockServiceRefreshAccessToken.mockResolvedValueOnce(rotated);

      // M8.3: the wrapper forwards the observational sink untouched.
      const options = { securityEventLogger: { info: () => {}, warn: () => {} } };
      const result = await refreshAccessToken(mockApp, 'raw-refresh-token', options);

      expect(mockServiceRefreshAccessToken).toHaveBeenCalledWith(mockApp, 'raw-refresh-token', options);
      expect(result).toEqual(rotated);
    });
  });

  describe('logout', () => {
    it('revokes the session for the presented credential and reports revocation', async () => {
      mockRevokeSessionForRefreshToken.mockResolvedValueOnce(true);

      const result = await logout('raw-refresh-token');

      expect(mockRevokeSessionForRefreshToken).toHaveBeenCalledWith('raw-refresh-token');
      expect(result).toEqual({ revoked: true });
    });

    it('reports no revocation for absent or unknown credentials', async () => {
      mockRevokeSessionForRefreshToken.mockResolvedValueOnce(false);

      const result = await logout('unknown-token');

      expect(result).toEqual({ revoked: false });
    });

    it('propagates database errors instead of reporting logout success', async () => {
      mockRevokeSessionForRefreshToken.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(logout('raw-refresh-token')).rejects.toThrow('connection terminated');
    });
  });

  describe('revokeAllSessions', () => {
    it('delegates to the session domain primitive with the authenticated user ID', async () => {
      mockRevokeAllSessionsForUser.mockResolvedValueOnce(3);

      const result = await revokeAllSessions('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(mockRevokeAllSessionsForUser).toHaveBeenCalledWith('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');
      expect(result).toEqual({ revoked: 3 });
    });

    it('reports zero without error when no live sessions exist', async () => {
      mockRevokeAllSessionsForUser.mockResolvedValueOnce(0);

      const result = await revokeAllSessions('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');

      expect(result).toEqual({ revoked: 0 });
    });

    it('propagates database errors instead of reporting success', async () => {
      mockRevokeAllSessionsForUser.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(revokeAllSessions('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T')).rejects.toThrow(
        'connection terminated',
      );
    });
  });

  describe('requestPasswordReset', () => {
    const activeUser = {
      id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      email: 'alice@example.com',
      displayName: 'Alice',
      status: 'active',
      role: 'user',
      createdAt: new Date('2026-01-15T09:30:00.000Z'),
      updatedAt: new Date('2026-01-15T09:30:00.000Z'),
    };

    it('normalizes the email and issues a token for an active user', async () => {
      mockFindByEmail.mockResolvedValueOnce(activeUser);
      mockIssueResetToken.mockResolvedValueOnce(undefined);

      await requestPasswordReset('  Alice@Example.COM  ', '127.0.0.1');

      expect(mockCheckAndRecordRecoveryAttempt).toHaveBeenCalledWith({
        scope: 'password-reset',
        normalizedEmail: 'alice@example.com',
        clientIp: '127.0.0.1',
      });
      expect(mockFindByEmail).toHaveBeenCalledWith('alice@example.com');
      expect(mockIssueResetToken).toHaveBeenCalledWith('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', 'alice@example.com', undefined);
    });

    it('returns silently without issuing for unknown emails', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);

      await requestPasswordReset('nobody@example.com', '127.0.0.1');

      expect(mockCheckAndRecordRecoveryAttempt).toHaveBeenCalledWith({
        scope: 'password-reset',
        normalizedEmail: 'nobody@example.com',
        clientIp: '127.0.0.1',
      });
      expect(mockIssueResetToken).not.toHaveBeenCalled();
    });

    it('returns silently without issuing for non-active users', async () => {
      mockFindByEmail.mockResolvedValueOnce({ ...activeUser, status: 'suspended' });

      await requestPasswordReset('alice@example.com', '127.0.0.1');

      expect(mockIssueResetToken).not.toHaveBeenCalled();
    });

    it('propagates issuance failures instead of masking them', async () => {
      mockFindByEmail.mockResolvedValueOnce(activeUser);
      mockIssueResetToken.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(requestPasswordReset('alice@example.com', '127.0.0.1')).rejects.toThrow(
        'connection terminated',
      );
    });

    it('checks the recovery throttle before the user lookup', async () => {
      mockCheckAndRecordRecoveryAttempt.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS, 429, 'Too many recovery attempts.'),
      );
      // No findByEmail result is queued: the lookup must never run, and a
      // queued result would leak into later tests via the shared mock.

      await expect(requestPasswordReset('alice@example.com', '127.0.0.1')).rejects.toSatisfy(
        (error: unknown) => error instanceof AppError && error.statusCode === 429,
      );
      expect(mockFindByEmail).not.toHaveBeenCalled();
      expect(mockIssueResetToken).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    const activeUser = {
      id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      email: 'alice@example.com',
      displayName: 'Alice',
      status: 'active',
      role: 'user',
      createdAt: new Date('2026-01-15T09:30:00.000Z'),
      updatedAt: new Date('2026-01-15T09:30:00.000Z'),
    };

    it('hashes the new password and completes the reset for an active user', async () => {
      mockFindActiveResetToken.mockResolvedValueOnce('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');
      mockFindUserById.mockResolvedValueOnce(activeUser);
      mockHashPassword.mockResolvedValueOnce('$2b$12$newhashvalue');
      mockCompleteReset.mockResolvedValueOnce(undefined);

      await resetPassword('valid-raw-token', 'new-strong-password');

      expect(mockHashPassword).toHaveBeenCalledWith('new-strong-password');
      expect(mockCompleteReset).toHaveBeenCalledWith(
        'valid-raw-token',
        'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        '$2b$12$newhashvalue',
      );
    });

    it('clears account lockout and account throttle state on successful reset', async () => {
      mockFindActiveResetToken.mockResolvedValueOnce('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');
      mockFindUserById.mockResolvedValueOnce({
        ...activeUser,
        lockedUntil: new Date(Date.now() + 60000),
      });
      mockHashPassword.mockResolvedValueOnce('$2b$12$newhashvalue');
      mockCompleteReset.mockResolvedValueOnce(undefined);

      await resetPassword('valid-raw-token', 'new-strong-password');

      // Authenticated recovery: the presenter proved control of the
      // recovery channel, so lockout and account-throttle state are reset.
      expect(mockUpdateUser).toHaveBeenCalledWith('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T', {
        lockedUntil: null,
      });
      expect(mockClearAccountThrottle).toHaveBeenCalledWith('alice@example.com');
    });

    it('changes no lockout state when the reset credential is invalid', async () => {
      mockFindActiveResetToken.mockResolvedValueOnce(null);

      await expect(resetPassword('unknown-token', 'new-strong-password')).rejects.toSatisfy(
        (error: unknown) => error instanceof AppError,
      );

      expect(mockCompleteReset).not.toHaveBeenCalled();
      expect(mockUpdateUser).not.toHaveBeenCalled();
      expect(mockClearAccountThrottle).not.toHaveBeenCalled();
    });

    it('rejects unknown tokens with the generic failure', async () => {
      mockFindActiveResetToken.mockResolvedValueOnce(null);

      await expect(resetPassword('unknown-token', 'new-strong-password')).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(AppError);
          expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_TOKEN);
          expect((error as AppError).statusCode).toBe(401);
          return true;
        },
      );
      expect(mockHashPassword).not.toHaveBeenCalled();
      expect(mockCompleteReset).not.toHaveBeenCalled();
    });

    it('rejects deleted and suspended users with the generic failure', async () => {
      mockFindActiveResetToken.mockResolvedValueOnce('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');
      mockFindUserById.mockResolvedValueOnce(null);

      await expect(resetPassword('valid-raw-token', 'new-strong-password')).rejects.toSatisfy(
        (error: unknown) => error instanceof AppError,
      );

      mockFindActiveResetToken.mockResolvedValueOnce('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');
      mockFindUserById.mockResolvedValueOnce({ ...activeUser, status: 'suspended' });

      await expect(resetPassword('valid-raw-token', 'new-strong-password')).rejects.toSatisfy(
        (error: unknown) => error instanceof AppError,
      );
      expect(mockHashPassword).not.toHaveBeenCalled();
      expect(mockCompleteReset).not.toHaveBeenCalled();
    });

    it('sends one password-change notice after a successful reset', async () => {
      mockFindActiveResetToken.mockResolvedValueOnce('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');
      mockFindUserById.mockResolvedValueOnce(activeUser);
      mockHashPassword.mockResolvedValueOnce('$2b$12$newhashvalue');
      mockCompleteReset.mockResolvedValueOnce(undefined);
      const sent: Array<{ to: string }> = [];
      const mailer = {
        sendAccountLocked: vi.fn(async () => {}),
        sendPasswordResetSucceeded: vi.fn(async (email: { to: string }) => {
          sent.push(email);
        }),
      };
      const logger = { error: vi.fn() };

      await resetPassword('valid-raw-token', 'new-strong-password', {
        securityNotificationMailer: mailer,
        securityNotificationLogger: logger,
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('alice@example.com');
      // The notice request carries the recipient and nothing else: no
      // password, session, token, or rendered wording can reach it.
      expect(Object.keys(sent[0])).toEqual(['to']);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('keeps the reset successful and logs safely when the notice fails', async () => {
      mockFindActiveResetToken.mockResolvedValueOnce('u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T');
      mockFindUserById.mockResolvedValueOnce(activeUser);
      mockHashPassword.mockResolvedValueOnce('$2b$12$newhashvalue');
      mockCompleteReset.mockResolvedValueOnce(undefined);
      const secret = 'fake-provider-secret-xyz-555';
      const mailer = {
        sendAccountLocked: vi.fn(async () => {}),
        sendPasswordResetSucceeded: vi.fn(async () => {
          throw Object.assign(new Error(`provider blew up with ${secret}`), {
            name: 'SMTPError',
          });
        }),
      };
      const logger = { error: vi.fn() };

      await resetPassword('valid-raw-token', 'new-strong-password', {
        securityNotificationMailer: mailer,
        securityNotificationLogger: logger,
      });

      expect(logger.error).toHaveBeenCalledTimes(1);
      const serialized = JSON.stringify(logger.error.mock.calls[0]);
      expect(serialized).toContain('PASSWORD_RESET_SUCCEEDED');
      expect(serialized).toContain(activeUser.id);
      expect(serialized).not.toContain('alice@example.com');
      expect(serialized).not.toContain(secret);
    });

    it('sends no notice when the reset credential is invalid', async () => {
      mockFindActiveResetToken.mockResolvedValueOnce(null);
      const mailer = {
        sendAccountLocked: vi.fn(async () => {}),
        sendPasswordResetSucceeded: vi.fn(async () => {}),
      };

      await expect(
        resetPassword('unknown-token', 'new-strong-password', {
          securityNotificationMailer: mailer,
        }),
      ).rejects.toSatisfy((error: unknown) => error instanceof AppError);

      expect(mailer.sendPasswordResetSucceeded).not.toHaveBeenCalled();
    });
  });

  describe('resendVerificationEmail', () => {
    const activeUser = {
      id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      email: 'alice@example.com',
      displayName: 'Alice',
      status: 'active',
      role: 'user',
      emailVerifiedAt: null,
      createdAt: new Date('2026-01-15T09:30:00.000Z'),
      updatedAt: new Date('2026-01-15T09:30:00.000Z'),
    };

    it('normalizes the email and issues a token for an unverified active user', async () => {
      mockFindByEmail.mockResolvedValueOnce(activeUser);
      mockIssueVerifyToken.mockResolvedValueOnce(undefined);

      await resendVerificationEmail('  Alice@Example.COM  ', '127.0.0.1');

      expect(mockCheckAndRecordRecoveryAttempt).toHaveBeenCalledWith({
        scope: 'email-verification',
        normalizedEmail: 'alice@example.com',
        clientIp: '127.0.0.1',
      });
      expect(mockFindByEmail).toHaveBeenCalledWith('alice@example.com');
      expect(mockIssueVerifyToken).toHaveBeenCalledWith(
        'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        'alice@example.com',
        undefined,
      );
    });

    it('returns silently without issuing for unknown emails', async () => {
      mockFindByEmail.mockResolvedValueOnce(null);

      await resendVerificationEmail('nobody@example.com', '127.0.0.1');

      expect(mockCheckAndRecordRecoveryAttempt).toHaveBeenCalledWith({
        scope: 'email-verification',
        normalizedEmail: 'nobody@example.com',
        clientIp: '127.0.0.1',
      });
      expect(mockIssueVerifyToken).not.toHaveBeenCalled();
    });

    it('returns silently without issuing for non-active or already-verified users', async () => {
      mockFindByEmail.mockResolvedValueOnce({ ...activeUser, status: 'suspended' });
      await resendVerificationEmail('alice@example.com', '127.0.0.1');
      expect(mockIssueVerifyToken).not.toHaveBeenCalled();

      mockFindByEmail.mockResolvedValueOnce({ ...activeUser, emailVerifiedAt: new Date() });
      await resendVerificationEmail('alice@example.com', '127.0.0.1');
      expect(mockIssueVerifyToken).not.toHaveBeenCalled();
    });

    it('propagates issuance failures instead of masking them', async () => {
      mockFindByEmail.mockResolvedValueOnce(activeUser);
      mockIssueVerifyToken.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(resendVerificationEmail('alice@example.com', '127.0.0.1')).rejects.toThrow(
        'connection terminated',
      );
    });

    it('checks the recovery throttle before the user lookup', async () => {
      mockCheckAndRecordRecoveryAttempt.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS, 429, 'Too many recovery attempts.'),
      );
      // No findByEmail result is queued: the lookup must never run, and a
      // queued result would leak into later tests via the shared mock.

      await expect(resendVerificationEmail('alice@example.com', '127.0.0.1')).rejects.toSatisfy(
        (error: unknown) => error instanceof AppError && error.statusCode === 429,
      );
      expect(mockFindByEmail).not.toHaveBeenCalled();
      expect(mockIssueVerifyToken).not.toHaveBeenCalled();
    });
  });

  describe('confirmEmailVerification', () => {
    const activeUser = {
      id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      email: 'alice@example.com',
      displayName: 'Alice',
      status: 'active',
      role: 'user',
      emailVerifiedAt: null,
      createdAt: new Date('2026-01-15T09:30:00.000Z'),
      updatedAt: new Date('2026-01-15T09:30:00.000Z'),
    };

    it('consumes the credential and stamps verification for an unverified active user', async () => {
      mockFindActiveVerifyToken.mockResolvedValueOnce({ id: 'e_live', userId: activeUser.id });
      mockFindUserById.mockResolvedValueOnce(activeUser);
      mockFindVerifyByHash.mockResolvedValueOnce({
        id: 'e_live',
        userId: activeUser.id,
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 3600_000),
        consumedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockConsumeVerifyToken.mockResolvedValueOnce(true);
      const mockTx = {};
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
      mockUpdateUser.mockResolvedValueOnce({ ...activeUser, emailVerifiedAt: new Date() });

      await confirmEmailVerification('valid-raw-token');

      expect(mockConsumeVerifyToken).toHaveBeenCalledWith('e_live', mockTx);
      expect(mockUpdateUser).toHaveBeenCalledWith(
        activeUser.id,
        { emailVerifiedAt: expect.any(Date) as Date },
        mockTx,
      );
    });

    it('consumes without touching the timestamp for already-verified users', async () => {
      const verifiedUser = { ...activeUser, emailVerifiedAt: new Date('2026-02-01T00:00:00.000Z') };
      mockFindActiveVerifyToken.mockResolvedValueOnce({ id: 'e_live', userId: activeUser.id });
      mockFindUserById.mockResolvedValueOnce(verifiedUser);
      mockFindVerifyByHash.mockResolvedValueOnce({
        id: 'e_live',
        userId: activeUser.id,
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 3600_000),
        consumedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockConsumeVerifyToken.mockResolvedValueOnce(true);
      mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({}),
      );

      await confirmEmailVerification('valid-raw-token');

      expect(mockConsumeVerifyToken).toHaveBeenCalled();
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it('rejects unknown tokens with the generic failure', async () => {
      mockFindActiveVerifyToken.mockResolvedValueOnce(null);

      await expect(confirmEmailVerification('unknown-token')).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(AppError);
          expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_TOKEN);
          expect((error as AppError).statusCode).toBe(401);
          return true;
        },
      );
      expect(mockPrismaTransaction).not.toHaveBeenCalled();
    });

    it('rejects deleted and suspended users with the generic failure', async () => {
      mockFindActiveVerifyToken.mockResolvedValueOnce({ id: 'e_live', userId: activeUser.id });
      mockFindUserById.mockResolvedValueOnce(null);

      await expect(confirmEmailVerification('valid-raw-token')).rejects.toSatisfy(
        (error: unknown) => error instanceof AppError,
      );

      mockFindActiveVerifyToken.mockResolvedValueOnce({ id: 'e_live', userId: activeUser.id });
      mockFindUserById.mockResolvedValueOnce({ ...activeUser, status: 'suspended' });

      await expect(confirmEmailVerification('valid-raw-token')).rejects.toSatisfy(
        (error: unknown) => error instanceof AppError,
      );
      expect(mockPrismaTransaction).not.toHaveBeenCalled();
    });
  });

  describe('error codes', () => {
    it('only contains implemented error codes — no future placeholders', () => {
      const keys = Object.keys(ErrorCodes);
      expect(keys).toEqual([
        'USERS_EMAIL_TAKEN',
        'USERS_NOT_FOUND',
        'AUTH_INVALID_CREDENTIALS',
        'AUTH_INVALID_TOKEN',
        'AUTH_TOKEN_EXPIRED',
        'AUTH_FORBIDDEN',
        'AUTH_TOO_MANY_ATTEMPTS',
        'AUTH_INVALID_PASSWORD',
        'VALIDATION_FAILED',
        'MALFORMED_JSON',
        'BODY_TOO_LARGE',
        'UNSUPPORTED_MEDIA_TYPE',
        'BAD_REQUEST',
        'CONFLICT',
        'ROLES_NOT_FOUND',
        'NOTES_NOT_FOUND',
      ]);
    });
  });

  describe('exports', () => {
    it('exports authService with the register, login, getCurrentUser, refreshAccessToken, logout, password-reset, verification, and revoke-all methods', () => {
      expect(authService.register).toBe(register);
      expect(authService.login).toBe(login);
      expect(authService.getCurrentUser).toBe(getCurrentUser);
      expect(authService.refreshAccessToken).toBe(refreshAccessToken);
      expect(authService.logout).toBe(logout);
      expect(authService.requestPasswordReset).toBe(requestPasswordReset);
      expect(authService.resetPassword).toBe(resetPassword);
      expect(authService.resendVerificationEmail).toBe(resendVerificationEmail);
      expect(authService.confirmEmailVerification).toBe(confirmEmailVerification);
      expect(authService.revokeAllSessions).toBe(revokeAllSessions);
    });
  });
});
