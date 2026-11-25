import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const mockCheckLoginAllowed = vi.fn();
const mockRecordLoginFailure = vi.fn();
const mockClearAccountThrottle = vi.fn();
const mockThrottleDelay = vi.fn();
const mockCheckAccountLockout = vi.fn();
const mockRevalidateUnlockedForIssuance = vi.fn();

vi.mock('../modules/auth/services/login-throttle.service.js', () => ({
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

vi.mock('../modules/auth/services/recovery-throttle.service.js', () => ({
  recoveryThrottleService: {
    checkAndRecordRecoveryAttempt: mockCheckAndRecordRecoveryAttempt,
  },
}));

const mockFindByEmail = vi.fn();
const mockFindUserById = vi.fn();

vi.mock('../modules/users/users.service.js', () => ({
  usersService: {
    findByEmail: mockFindByEmail,
    findById: mockFindUserById,
    create: vi.fn(),
    update: vi.fn(),
  },
}));

const { login, requestPasswordReset } = await import(
  '../modules/auth/services/auth.service.js'
);

/**
 * M5.7 — fail-safe catalog (unit, mocked stores).
 *
 * Documents and proves what every abuse/security control does when its
 * underlying store fails: propagate (sanitized 5xx upstream), NEVER
 * bypass the control and NEVER mask the outage as a normal
 * authentication outcome (no false success, no false 204, no
 * oracle-changing 401). Live suites prove the happy paths; this catalog
 * pins the failure contract in one place. Covers M57-INV-020.
 */
describe('fail-safe catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    'login throttle-store failure fails closed (never bypasses, never 401-masks)',
    async () => {
      mockCheckLoginAllowed.mockRejectedValueOnce(new Error('connection terminated'));
      mockFindByEmail.mockResolvedValueOnce(null);

      // The raw store error propagates to the sanitized 5xx contract: the
      // outage is neither bypassed (no token issued) nor masked as a
      // generic 401 authentication failure. (The user lookup runs before
      // the throttle check by design — read-only and oracle-free.)
      await expect(
        login({} as never, {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
          clientIp: '127.0.0.1',
        }),
      ).rejects.toThrow('connection terminated');
    },
  );

  it(
    'login failure-recording outage fails closed (never silent success)',
    async () => {
      mockCheckLoginAllowed.mockResolvedValueOnce({ delayMs: 0 });
      mockFindByEmail.mockResolvedValueOnce(null);
      mockRecordLoginFailure.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(
        login({} as never, {
          email: 'unknown@example.com',
          password: 'wrong-password-xyz',
          clientIp: '127.0.0.1',
        }),
      ).rejects.toThrow('connection terminated');
    },
  );

  it(
    'recovery throttle-store failure fails closed (never silent 204)',
    async () => {
      mockCheckAndRecordRecoveryAttempt.mockRejectedValueOnce(
        new Error('connection terminated'),
      );

      await expect(
        requestPasswordReset('alice@example.com', '127.0.0.1'),
      ).rejects.toThrow('connection terminated');
      expect(mockFindByEmail).not.toHaveBeenCalled();
    },
  );

  it(
    'credential-store failure fails closed (never authenticates, never 401-masks outage)',
    async () => {
      mockCheckLoginAllowed.mockResolvedValueOnce({ delayMs: 0 });
      mockCheckAccountLockout.mockResolvedValueOnce(undefined);
      mockFindByEmail.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(
        login({} as never, {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
          clientIp: '127.0.0.1',
        }),
      ).rejects.toThrow('connection terminated');
    },
  );

  it(
    'user-lookup failure in recovery fails closed (never silent 204)',
    async () => {
      mockCheckAndRecordRecoveryAttempt.mockResolvedValueOnce(undefined);
      mockFindByEmail.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(
        requestPasswordReset('alice@example.com', '127.0.0.1'),
      ).rejects.toThrow('connection terminated');
    },
  );
});
