import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';

// Required before the service import evaluates validated config.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const mockFindByKey = vi.fn();
const mockRecordFailure = vi.fn();
const mockClearByKey = vi.fn();
const mockDeleteExpired = vi.fn();

vi.mock('../repositories/login-throttle.repository.js', () => ({
  loginThrottleRepository: {
    findByKey: mockFindByKey,
    recordFailure: mockRecordFailure,
    clearByKey: mockClearByKey,
    deleteExpired: mockDeleteExpired,
  },
}));

const mockPrismaTransaction = vi.fn();

vi.mock('../../../platform/database/prisma.js', () => ({
  prisma: {
    $transaction: mockPrismaTransaction,
  },
}));

const mockSetAccountLockIfUnlocked = vi.fn();
const mockClearExpiredAccountLock = vi.fn();
const mockFindUserById = vi.fn();

vi.mock('../../users/users.service.js', () => ({
  usersService: {
    setAccountLockIfUnlocked: mockSetAccountLockIfUnlocked,
    clearExpiredAccountLock: mockClearExpiredAccountLock,
    findById: mockFindUserById,
  },
}));

const { config } = await import('../../../config/index.js');
const {
  buildAccountKey,
  buildIpKey,
  calculateBruteForceDelay,
  delay,
  isAccountLocked,
  lockedError,
  checkAccountLockout,
  revalidateUnlockedForIssuance,
  checkLoginAllowed,
  recordLoginFailure,
  clearAccountThrottle,
  loginThrottleService,
} = await import('./login-throttle.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockFindByKey.mockResolvedValue(null);
  mockRecordFailure.mockResolvedValue(undefined);
  mockClearByKey.mockResolvedValue(true);
  mockDeleteExpired.mockResolvedValue(0);
  mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
  mockSetAccountLockIfUnlocked.mockResolvedValue(true);
  mockClearExpiredAccountLock.mockResolvedValue(true);
  mockFindUserById.mockResolvedValue(null);
});

function liveRow(failureCount: number, windowMs: number): {
  key: string;
  failureCount: number;
  windowStartedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
} {
  const now = Date.now();
  return {
    key: 'auth:login:v1:account:test',
    failureCount,
    windowStartedAt: new Date(now - windowMs / 2),
    expiresAt: new Date(now + windowMs / 2),
    createdAt: new Date(now - windowMs / 2),
    updatedAt: new Date(now - windowMs / 2),
  };
}

describe('loginThrottleService keys', () => {
  it('builds deterministic namespaced account keys', () => {
    const first = buildAccountKey('alice@example.com');
    const second = buildAccountKey('alice@example.com');

    expect(first).toBe(second);
    expect(first.startsWith('auth:login:v1:account:')).toBe(true);
    expect(first).toMatch(/^auth:login:v1:account:[0-9a-f]{64}$/);
  });

  it('separates accounts and never embeds the raw email', () => {
    const alice = buildAccountKey('alice@example.com');
    const bob = buildAccountKey('bob@example.com');

    expect(alice).not.toBe(bob);
    expect(alice).not.toContain('alice@example.com');
    expect(bob).not.toContain('bob@example.com');
  });

  it('does not normalize inside the key builder — the caller normalizes once', () => {
    expect(buildAccountKey('Alice@Example.com')).not.toBe(buildAccountKey('alice@example.com'));
  });

  it('builds deterministic namespaced source keys without raw IPs', () => {
    const first = buildIpKey('203.0.113.7');
    const second = buildIpKey('203.0.113.7');

    expect(first).toBe(second);
    expect(first).toMatch(/^auth:login:v1:ip:[0-9a-f]{64}$/);
    expect(first).not.toContain('203.0.113.7');
    expect(first).not.toBe(buildIpKey('203.0.113.8'));
  });

  it('collapses an empty source into one bounded bucket instead of scattering keys', () => {
    expect(buildIpKey('')).toBe(buildIpKey('unresolved'));
  });

  it('keeps the account and source namespaces disjoint', () => {
    expect(buildAccountKey('203.0.113.7')).not.toBe(buildIpKey('203.0.113.7'));
  });
});

describe('calculateBruteForceDelay', () => {
  it('returns 0 for failureCount below escalationStart', () => {
    // The first ever attempt must never be delayed, so a legitimate user
    // with no prior failures is unaffected.
    expect(calculateBruteForceDelay(0)).toBe(0);
    for (let failureCount = 0; failureCount < config.auth.bruteForce.escalationStart; failureCount++) {
      expect(calculateBruteForceDelay(failureCount)).toBe(0);
    }
  });

  it('returns baseDelayMs at the first escalation level', () => {
    expect(calculateBruteForceDelay(config.auth.bruteForce.escalationStart)).toBe(
      config.auth.bruteForce.baseDelayMs,
    );
  });

  it('doubles the delay at each escalation level', () => {
    const base = config.auth.bruteForce.baseDelayMs;
    const start = config.auth.bruteForce.escalationStart;
    expect(calculateBruteForceDelay(start)).toBe(base);
    expect(calculateBruteForceDelay(start + 1)).toBe(base * 2);
    expect(calculateBruteForceDelay(start + 2)).toBe(base * 4);
    expect(calculateBruteForceDelay(start + 3)).toBe(base * 8);
  });

  it('escalates monotonically across the whole reachable range', () => {
    // Never decrease as failureCount grows, and never exceed the bound.
    let previous = 0;
    for (
      let failureCount = 0;
      failureCount < config.auth.loginThrottle.accountThreshold + 3;
      failureCount += 1
    ) {
      const delay = calculateBruteForceDelay(failureCount);
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeLessThanOrEqual(config.auth.bruteForce.maxDelayMs);
      previous = delay;
    }
  });

  it('caps the delay at maxDelayMs', () => {
    const max = config.auth.bruteForce.maxDelayMs;
    expect(calculateBruteForceDelay(100)).toBe(max);
    expect(calculateBruteForceDelay(1000)).toBe(max);
  });

  it('handles absurdly large failureCount without overflow', () => {
    const result = calculateBruteForceDelay(Number.MAX_SAFE_INTEGER);
    expect(result).toBe(config.auth.bruteForce.maxDelayMs);
    expect(Number.isFinite(result)).toBe(true);
  });

  it('handles negative failureCount', () => {
    expect(calculateBruteForceDelay(-1)).toBe(0);
    expect(calculateBruteForceDelay(-100)).toBe(0);
  });

  it('returns 0 for non-finite failureCount instead of NaN or Infinity', () => {
    expect(calculateBruteForceDelay(Number.NaN)).toBe(0);
    expect(calculateBruteForceDelay(Number.POSITIVE_INFINITY)).toBe(0);
    expect(calculateBruteForceDelay(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('floors fractional failureCount without rounding up the delay', () => {
    const start = config.auth.bruteForce.escalationStart;
    expect(calculateBruteForceDelay(start + 0.9)).toBe(calculateBruteForceDelay(start));
  });

  it('never returns a negative, NaN, or non-finite delay for any input', () => {
    const inputs = [-1e9, -1, 0, 1, 2, 3, 4, 5, 50, 1e6, 1e15, Number.MAX_SAFE_INTEGER];
    for (const input of inputs) {
      const result = calculateBruteForceDelay(input);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(config.auth.bruteForce.maxDelayMs);
    }
  });

  it('makes the configured maximum delay reachable before the M3.14 threshold', () => {
    // The M3.14 account threshold rejects at ACCOUNT_THRESHOLD failures, so
    // the largest failureCount that still reaches delay calculation is
    // ACCOUNT_THRESHOLD - 1. The configured cap must be reachable there,
    // otherwise maxDelayMs is dead policy.
    const reachableMax = config.auth.loginThrottle.accountThreshold - 1;
    expect(calculateBruteForceDelay(reachableMax)).toBe(config.auth.bruteForce.maxDelayMs);
  });

  it('is deterministic', () => {
    expect(calculateBruteForceDelay(3)).toBe(calculateBruteForceDelay(3));
  });
});

describe('delay', () => {
  it('resolves after the specified milliseconds', async () => {
    const start = Date.now();
    await delay(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('resolves immediately for 0 milliseconds', async () => {
    const start = Date.now();
    await delay(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe('checkLoginAllowed', () => {
  const identity = { normalizedEmail: 'alice@example.com', clientIp: '203.0.113.7' };

  it('allows login when no throttle state exists', async () => {
    await expect(checkLoginAllowed(identity)).resolves.toEqual({ delayMs: 0 });
    expect(mockFindByKey).toHaveBeenCalledTimes(2);
  });

  it('allows login below both thresholds', async () => {
    mockFindByKey
      .mockResolvedValueOnce(liveRow(config.auth.loginThrottle.accountThreshold - 1, 900000))
      .mockResolvedValueOnce(liveRow(config.auth.loginThrottle.ipThreshold - 1, 900000));

    const result = await checkLoginAllowed(identity);
    // accountThreshold - 1 failures is still below the M3.14 threshold, so
    // the request is allowed — and it receives the maximum backoff delay.
    expect(result.delayMs).toBe(config.auth.bruteForce.maxDelayMs);
  });

  it('returns a progressive delay when account failures have started escalating', async () => {
    const accountFailures = config.auth.bruteForce.escalationStart + 1;
    mockFindByKey
      .mockResolvedValueOnce(liveRow(accountFailures, 900000))
      .mockResolvedValueOnce(null);

    const result = await checkLoginAllowed(identity);
    expect(result.delayMs).toBeGreaterThan(0);
    expect(result.delayMs).toBeLessThanOrEqual(config.auth.bruteForce.maxDelayMs);
  });

  it('returns 0 delay when account window is expired even with high historical count', async () => {
    const expired = {
      ...liveRow(config.auth.loginThrottle.accountThreshold + 10, 900000),
      expiresAt: new Date(Date.now() - 1000),
    };
    mockFindByKey.mockResolvedValueOnce(expired).mockResolvedValueOnce(null);

    await expect(checkLoginAllowed(identity)).resolves.toEqual({ delayMs: 0 });
  });

  it('rejects with 429 AUTH_TOO_MANY_ATTEMPTS at the account threshold', async () => {
    mockFindByKey
      .mockResolvedValueOnce(liveRow(config.auth.loginThrottle.accountThreshold, 900000))
      .mockResolvedValueOnce(null);

    await expect(checkLoginAllowed(identity)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS);
      expect((error as AppError).statusCode).toBe(429);
      return true;
    });
  });

  it('rejects with the identical 429 when only the source threshold is reached', async () => {
    const ipRow = liveRow(config.auth.loginThrottle.ipThreshold, 900000);
    mockFindByKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ipRow)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ipRow);

    const first = await checkLoginAllowed({ ...identity }).catch((error: unknown) => error);
    const second = await checkLoginAllowed({ ...identity, normalizedEmail: 'other@example.com' }).catch(
      (error: unknown) => error,
    );

    for (const outcome of [first, second]) {
      expect(outcome).toBeInstanceOf(AppError);
      expect((outcome as AppError).code).toBe(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS);
      expect((outcome as AppError).statusCode).toBe(429);
      expect((outcome as AppError).message).toBe((first as AppError).message);
    }
  });

  it('reads both dimensions concurrently without user lookups', async () => {
    await checkLoginAllowed(identity);

    expect(mockFindByKey).toHaveBeenCalledTimes(2);
    const keys = mockFindByKey.mock.calls.map((call) => call[0] as string);
    expect(keys[0].startsWith('auth:login:v1:account:')).toBe(true);
    expect(keys[1].startsWith('auth:login:v1:ip:')).toBe(true);
  });

  it('propagates throttle-store failures instead of failing open', async () => {
    mockFindByKey.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(checkLoginAllowed(identity)).rejects.toThrow('connection terminated');
  });

  it('derives the delay from the account dimension only, never the source dimension', async () => {
    // A heavily-abused source must not silently escalate the account delay:
    // that would let an attacker penalize arbitrary victims by spraying from
    // one IP. The source dimension has its own M3.14 threshold instead.
    const accountFailures = config.auth.bruteForce.escalationStart;
    mockFindByKey
      .mockResolvedValueOnce(liveRow(accountFailures, 900000))
      .mockResolvedValueOnce(liveRow(config.auth.loginThrottle.ipThreshold - 1, 900000));

    const result = await checkLoginAllowed(identity);
    expect(result.delayMs).toBe(calculateBruteForceDelay(accountFailures));
  });

  it('returns the same delay for the same failureCount regardless of identity', async () => {
    // Enumeration-resistance invariant: the delay is a pure function of the
    // pre-lookup failureCount, so an unknown email and a known email with a
    // wrong password are indistinguishable at equal failureCount.
    const failures = 3;
    const delays: number[] = [];
    for (const email of ['ghost@example.com', 'alice@example.com', 'carol@example.com']) {
      mockFindByKey
        .mockResolvedValueOnce(liveRow(failures, 900000))
        .mockResolvedValueOnce(null);
      const result = await checkLoginAllowed({ normalizedEmail: email, clientIp: '203.0.113.7' });
      delays.push(result.delayMs);
    }

    expect(delays[0]).toBe(delays[1]);
    expect(delays[1]).toBe(delays[2]);
    expect(delays[0]).toBe(calculateBruteForceDelay(failures));
  });
});

describe('recordLoginFailure', () => {
  const identity = { normalizedEmail: 'alice@example.com', clientIp: '203.0.113.7' };

  it('records both dimensions and runs expiration cleanup for unknown emails', async () => {
    await recordLoginFailure(identity, null);

    expect(mockPrismaTransaction).not.toHaveBeenCalled();
    expect(mockRecordFailure).toHaveBeenCalledTimes(2);
    const [accountCall, ipCall] = mockRecordFailure.mock.calls;
    expect((accountCall[0] as { key: string }).key).toBe(buildAccountKey('alice@example.com'));
    expect((ipCall[0] as { key: string }).key).toBe(buildIpKey('203.0.113.7'));
    expect((accountCall[0] as { failureCount: number }).failureCount).toBe(1);
    expect((ipCall[0] as { failureCount: number }).failureCount).toBe(1);
    expect(mockDeleteExpired).toHaveBeenCalledTimes(1);
    expect(mockSetAccountLockIfUnlocked).not.toHaveBeenCalled();
  });

  it('records the account dimension inside a transaction for known accounts', async () => {
    mockRecordFailure.mockImplementation(async (input: { key: string }) => ({
      key: input.key,
      failureCount: 2,
      windowStartedAt: new Date(),
      expiresAt: new Date(Date.now() + 900000),
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    await recordLoginFailure(identity, 'u_alice');

    expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
    // Below the lockout threshold no lock transition is attempted.
    expect(mockSetAccountLockIfUnlocked).not.toHaveBeenCalled();
    // The IP dimension and cleanup stay outside the transaction.
    expect(mockDeleteExpired).toHaveBeenCalledTimes(1);
  });

  it('transitions to lockout atomically when the threshold is crossed', async () => {
    const threshold = config.auth.accountLockout.failureThreshold;
    mockRecordFailure.mockImplementation(async (input: { key: string }) => ({
      key: input.key,
      failureCount: threshold,
      windowStartedAt: new Date(),
      expiresAt: new Date(Date.now() + 900000),
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    await recordLoginFailure(identity, 'u_alice');

    expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
    expect(mockSetAccountLockIfUnlocked).toHaveBeenCalledTimes(1);
    const [userId, lockedUntil, tx] = mockSetAccountLockIfUnlocked.mock.calls[0];
    expect(userId).toBe('u_alice');
    expect(lockedUntil).toBeInstanceOf(Date);
    const expectedMs = config.auth.accountLockout.lockoutDurationSeconds * 1000;
    expect((lockedUntil as Date).getTime()).toBeGreaterThan(Date.now() + expectedMs - 5000);
    expect((lockedUntil as Date).getTime()).toBeLessThanOrEqual(Date.now() + expectedMs);
    // The lock transition shares the caller's transaction client.
    expect(tx).toBeDefined();
  });

  it('bounds each window by the configured policy', async () => {
    const before = Date.now();
    await recordLoginFailure(identity, null);

    const [accountCall, ipCall] = mockRecordFailure.mock.calls;
    const accountExpiry = (accountCall[0] as { expiresAt: Date }).expiresAt.getTime();
    const ipExpiry = (ipCall[0] as { expiresAt: Date }).expiresAt.getTime();
    expect(accountExpiry - before).toBeLessThanOrEqual(
      config.auth.loginThrottle.accountWindowSeconds * 1000,
    );
    expect(ipExpiry - before).toBeLessThanOrEqual(config.auth.loginThrottle.ipWindowSeconds * 1000);
    expect(accountExpiry).toBeGreaterThan(before);
    expect(ipExpiry).toBeGreaterThan(before);
  });

  it('propagates store failures instead of masking them', async () => {
    mockRecordFailure.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(recordLoginFailure(identity, null)).rejects.toThrow('connection terminated');
  });

  it('rolls back the increment when the lock transition fails', async () => {
    const threshold = config.auth.accountLockout.failureThreshold;
    mockRecordFailure.mockResolvedValue({
      key: 'k',
      failureCount: threshold,
      windowStartedAt: new Date(),
      expiresAt: new Date(Date.now() + 900000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockPrismaTransaction.mockImplementationOnce(async () => {
      throw new Error('connection terminated');
    });

    await expect(recordLoginFailure(identity, 'u_alice')).rejects.toThrow(
      'connection terminated',
    );
  });

  it('reports no transition for unknown emails', async () => {
    await expect(recordLoginFailure(identity, null)).resolves.toEqual({
      transitionedToLocked: false,
    });
  });

  it('reports no transition below the lockout threshold', async () => {
    mockRecordFailure.mockImplementation(async (input: { key: string }) => ({
      key: input.key,
      failureCount: config.auth.accountLockout.failureThreshold - 1,
      windowStartedAt: new Date(),
      expiresAt: new Date(Date.now() + 900000),
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    await expect(recordLoginFailure(identity, 'u_alice')).resolves.toEqual({
      transitionedToLocked: false,
    });
    expect(mockSetAccountLockIfUnlocked).not.toHaveBeenCalled();
  });

  it('reports the transition when THIS caller locks the account', async () => {
    const threshold = config.auth.accountLockout.failureThreshold;
    mockRecordFailure.mockImplementation(async (input: { key: string }) => ({
      key: input.key,
      failureCount: threshold,
      windowStartedAt: new Date(),
      expiresAt: new Date(Date.now() + 900000),
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockSetAccountLockIfUnlocked.mockResolvedValueOnce(true);

    await expect(recordLoginFailure(identity, 'u_alice')).resolves.toEqual({
      transitionedToLocked: true,
    });
  });

  it('reports no transition when the lock already exists (converged crosser)', async () => {
    const threshold = config.auth.accountLockout.failureThreshold;
    mockRecordFailure.mockImplementation(async (input: { key: string }) => ({
      key: input.key,
      failureCount: threshold + 3,
      windowStartedAt: new Date(),
      expiresAt: new Date(Date.now() + 900000),
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockSetAccountLockIfUnlocked.mockResolvedValueOnce(false);

    await expect(recordLoginFailure(identity, 'u_alice')).resolves.toEqual({
      transitionedToLocked: false,
    });
  });
});

describe('isAccountLocked', () => {
  it('treats a NULL marker as unlocked', () => {
    expect(isAccountLocked(null, new Date())).toBe(false);
  });

  it('treats a future marker as locked', () => {
    expect(isAccountLocked(new Date(Date.now() + 60000), new Date())).toBe(true);
  });

  it('treats a past marker as expired, not locked', () => {
    expect(isAccountLocked(new Date(Date.now() - 1000), new Date())).toBe(false);
  });

  it('treats a marker exactly at now as expired (consistent with expiresAt <= now)', () => {
    const now = new Date();
    expect(isAccountLocked(new Date(now.getTime()), now)).toBe(false);
  });

  it('is deterministic for the same inputs', () => {
    const marker = new Date(Date.now() + 60000);
    const now = new Date();
    expect(isAccountLocked(marker, now)).toBe(isAccountLocked(marker, now));
  });
});

describe('lockedError', () => {
  it('reuses the existing 429 throttle contract with no new code', () => {
    const error = lockedError();
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS);
    expect(error.statusCode).toBe(429);
    expect(error.message).toBe('Too many login attempts. Please try again later.');
  });
});

describe('checkAccountLockout', () => {
  it('passes unlocked accounts through without touching state', async () => {
    await expect(checkAccountLockout('u_alice', null)).resolves.toBeUndefined();
    expect(mockClearExpiredAccountLock).not.toHaveBeenCalled();
    expect(mockFindUserById).not.toHaveBeenCalled();
  });

  it('rejects a live lock immediately with the generic 429', async () => {
    await expect(
      checkAccountLockout('u_alice', new Date(Date.now() + 60000)),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS);
      expect((error as AppError).statusCode).toBe(429);
      return true;
    });
    expect(mockClearExpiredAccountLock).not.toHaveBeenCalled();
    expect(mockFindUserById).not.toHaveBeenCalled();
  });

  it('recovers an expired lock with one conditional clear', async () => {
    await expect(
      checkAccountLockout('u_alice', new Date(Date.now() - 1000)),
    ).resolves.toBeUndefined();
    expect(mockClearExpiredAccountLock).toHaveBeenCalledTimes(1);
    expect(mockClearExpiredAccountLock).toHaveBeenCalledWith(
      'u_alice',
      expect.any(Date),
    );
    expect(mockFindUserById).not.toHaveBeenCalled();
  });

  it('never erases a fresh lock when the clear loses the race', async () => {
    mockClearExpiredAccountLock.mockResolvedValueOnce(false);
    mockFindUserById.mockResolvedValueOnce({
      id: 'u_alice',
      lockedUntil: new Date(Date.now() + 60000),
    });

    await expect(
      checkAccountLockout('u_alice', new Date(Date.now() - 1000)),
    ).rejects.toSatisfy((error: unknown) => error instanceof AppError);
    expect(mockFindUserById).toHaveBeenCalledWith('u_alice');
  });

  it('proceeds when the lost race reveals no live lock', async () => {
    mockClearExpiredAccountLock.mockResolvedValueOnce(false);
    mockFindUserById.mockResolvedValueOnce({ id: 'u_alice', lockedUntil: null });

    await expect(
      checkAccountLockout('u_alice', new Date(Date.now() - 1000)),
    ).resolves.toBeUndefined();
  });

  it('fails closed when the re-read finds a deleted account', async () => {
    mockClearExpiredAccountLock.mockResolvedValueOnce(false);
    mockFindUserById.mockResolvedValueOnce(null);

    await expect(
      checkAccountLockout('u_alice', new Date(Date.now() - 1000)),
    ).rejects.toSatisfy((error: unknown) => error instanceof AppError);
  });

  it('propagates store failures instead of bypassing the lock', async () => {
    mockClearExpiredAccountLock.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(checkAccountLockout('u_alice', new Date(Date.now() - 1000))).rejects.toThrow(
      'connection terminated',
    );
  });
});

describe('revalidateUnlockedForIssuance', () => {
  it('passes when the account is unlocked', async () => {
    mockFindUserById.mockResolvedValueOnce({ id: 'u_alice', lockedUntil: null });

    await expect(revalidateUnlockedForIssuance('u_alice')).resolves.toBeUndefined();
    expect(mockClearExpiredAccountLock).not.toHaveBeenCalled();
  });

  it('blocks issuance when a lock landed during password verification', async () => {
    mockFindUserById.mockResolvedValueOnce({
      id: 'u_alice',
      lockedUntil: new Date(Date.now() + 60000),
    });

    await expect(revalidateUnlockedForIssuance('u_alice')).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.AUTH_TOO_MANY_ATTEMPTS);
        return true;
      },
    );
    expect(mockClearExpiredAccountLock).not.toHaveBeenCalled();
  });

  it('blocks issuance when the account vanished mid-flight', async () => {
    mockFindUserById.mockResolvedValueOnce(null);

    await expect(revalidateUnlockedForIssuance('u_alice')).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError,
    );
  });

  it('recovers an expired lock before issuance', async () => {
    mockFindUserById.mockResolvedValueOnce({
      id: 'u_alice',
      lockedUntil: new Date(Date.now() - 1000),
    });

    await expect(revalidateUnlockedForIssuance('u_alice')).resolves.toBeUndefined();
    expect(mockClearExpiredAccountLock).toHaveBeenCalledTimes(1);
  });

  it('blocks issuance when recovery loses the race to a fresh lock', async () => {
    mockFindUserById.mockResolvedValueOnce({
      id: 'u_alice',
      lockedUntil: new Date(Date.now() - 1000),
    });
    mockClearExpiredAccountLock.mockResolvedValueOnce(false);
    mockFindUserById.mockResolvedValueOnce({
      id: 'u_alice',
      lockedUntil: new Date(Date.now() + 60000),
    });

    await expect(revalidateUnlockedForIssuance('u_alice')).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError,
    );
  });
});

describe('clearAccountThrottle', () => {
  it('clears only the account dimension, leaving source state to expire', async () => {
    await clearAccountThrottle('alice@example.com');

    expect(mockClearByKey).toHaveBeenCalledTimes(1);
    expect(mockClearByKey).toHaveBeenCalledWith(buildAccountKey('alice@example.com'));
  });

  it('propagates store failures instead of issuing a session on unclear state', async () => {
    mockClearByKey.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(clearAccountThrottle('alice@example.com')).rejects.toThrow(
      'connection terminated',
    );
  });
});

describe('loginThrottleService contract', () => {
  it('exposes the documented service surface', () => {
    expect(loginThrottleService.buildAccountKey).toBe(buildAccountKey);
    expect(loginThrottleService.buildIpKey).toBe(buildIpKey);
    expect(loginThrottleService.calculateBruteForceDelay).toBe(calculateBruteForceDelay);
    expect(loginThrottleService.delay).toBe(delay);
    expect(loginThrottleService.isAccountLocked).toBe(isAccountLocked);
    expect(loginThrottleService.lockedError).toBe(lockedError);
    expect(loginThrottleService.checkAccountLockout).toBe(checkAccountLockout);
    expect(loginThrottleService.revalidateUnlockedForIssuance).toBe(
      revalidateUnlockedForIssuance,
    );
    expect(loginThrottleService.checkLoginAllowed).toBe(checkLoginAllowed);
    expect(loginThrottleService.recordLoginFailure).toBe(recordLoginFailure);
    expect(loginThrottleService.clearAccountThrottle).toBe(clearAccountThrottle);
  });
});
