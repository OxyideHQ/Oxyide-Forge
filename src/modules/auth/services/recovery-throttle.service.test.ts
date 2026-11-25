import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';

// Required before the service import evaluates validated config.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const mockRecordFailure = vi.fn();
const mockDeleteExpired = vi.fn();

vi.mock('../repositories/login-throttle.repository.js', () => ({
  loginThrottleRepository: {
    findByKey: vi.fn(),
    recordFailure: mockRecordFailure,
    clearByKey: vi.fn(),
    deleteExpired: mockDeleteExpired,
  },
}));

const { config } = await import('../../../config/index.js');
const {
  buildAccountKey,
  buildIpKey,
  checkAndRecordRecoveryAttempt,
  recoveryThrottleService,
} = await import('./recovery-throttle.service.js');

function row(failureCount: number) {
  return {
    key: 'k',
    failureCount,
    windowStartedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordFailure.mockResolvedValue(row(1));
  mockDeleteExpired.mockResolvedValue(0);
});

describe('recovery throttle keys', () => {
  it('separates password-reset and email-verification scopes', () => {
    expect(buildAccountKey('password-reset', 'a@example.com')).not.toBe(
      buildAccountKey('email-verification', 'a@example.com'),
    );
    expect(buildIpKey('password-reset', '127.0.0.1')).not.toBe(
      buildIpKey('email-verification', '127.0.0.1'),
    );
  });

  it('separates account and IP dimensions', () => {
    expect(buildAccountKey('password-reset', 'a@example.com')).not.toBe(
      buildIpKey('password-reset', 'a@example.com'),
    );
  });

  it('never embeds raw emails or IPs in keys', () => {
    const account = buildAccountKey('password-reset', 'Victim@Example.COM');
    const ip = buildIpKey('password-reset', '203.0.113.7');
    expect(account).not.toContain('Victim');
    expect(account).not.toContain('example.com');
    expect(ip).not.toContain('203.0.113.7');
  });

  it('collapses empty IPs into one unresolved bucket', () => {
    expect(buildIpKey('password-reset', '')).toBe(buildIpKey('password-reset', ''));
  });

  it('is deterministic per input', () => {
    expect(buildAccountKey('password-reset', 'a@example.com')).toBe(
      buildAccountKey('password-reset', 'a@example.com'),
    );
  });
});

describe('checkAndRecordRecoveryAttempt', () => {
  it('records both dimensions before evaluating (increment-first)', async () => {
    await checkAndRecordRecoveryAttempt({
      scope: 'password-reset',
      normalizedEmail: 'alice@example.com',
      clientIp: '127.0.0.1',
    });

    expect(mockRecordFailure).toHaveBeenCalledTimes(2);
    const keys = mockRecordFailure.mock.calls.map((call) => (call[0] as { key: string }).key);
    expect(keys[0]).toBe(buildAccountKey('password-reset', 'alice@example.com'));
    expect(keys[1]).toBe(buildIpKey('password-reset', '127.0.0.1'));
    expect(mockDeleteExpired).toHaveBeenCalledTimes(1);
  });

  it('allows attempts at exactly the account threshold', async () => {
    mockRecordFailure
      .mockResolvedValueOnce(row(config.auth.recoveryThrottle.accountThreshold))
      .mockResolvedValueOnce(row(1));

    await expect(
      checkAndRecordRecoveryAttempt({
        scope: 'password-reset',
        normalizedEmail: 'alice@example.com',
        clientIp: '127.0.0.1',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects with 429 when the account dimension exceeds its threshold', async () => {
    mockRecordFailure
      .mockResolvedValueOnce(row(config.auth.recoveryThrottle.accountThreshold + 1))
      .mockResolvedValueOnce(row(1));

    await expect(
      checkAndRecordRecoveryAttempt({
        scope: 'password-reset',
        normalizedEmail: 'alice@example.com',
        clientIp: '127.0.0.1',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS);
      expect((error as AppError).statusCode).toBe(429);
      return true;
    });
  });

  it('rejects with 429 when the IP dimension exceeds its threshold', async () => {
    mockRecordFailure
      .mockResolvedValueOnce(row(1))
      .mockResolvedValueOnce(row(config.auth.recoveryThrottle.ipThreshold + 1));

    await expect(
      checkAndRecordRecoveryAttempt({
        scope: 'email-verification',
        normalizedEmail: 'alice@example.com',
        clientIp: '127.0.0.1',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS);
      expect((error as AppError).statusCode).toBe(429);
      return true;
    });
  });

  it('propagates store failures instead of bypassing the control', async () => {
    mockRecordFailure.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(
      checkAndRecordRecoveryAttempt({
        scope: 'password-reset',
        normalizedEmail: 'alice@example.com',
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow('connection terminated');
  });

  it('exposes the service contract', () => {
    expect(recoveryThrottleService.checkAndRecordRecoveryAttempt).toBe(checkAndRecordRecoveryAttempt);
    expect(recoveryThrottleService.buildAccountKey).toBe(buildAccountKey);
    expect(recoveryThrottleService.buildIpKey).toBe(buildIpKey);
  });
});
