import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  SecurityEventName,
  SecurityDecisionReason,
  logSecurityDecision,
  authorizationLogger,
} = await import('./authorization-logger.js');

function fakeLogger() {
  return { warn: vi.fn(), info: vi.fn() };
}

/**
 * M4.7 — authorization security logging contract tests.
 *
 * Proves the telemetry boundary directly: exact event schema (allowlisted
 * keys only), level selection (deny→warn, allow→info), frozen vocabularies,
 * and that no caller-controlled extra fields can reach log output. Live
 * emission, duplication, and privacy proofs live in the integration suite.
 */
describe('logSecurityDecision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits the exact allowlisted deny schema at warn level', () => {
    const log = fakeLogger();

    logSecurityDecision(log, {
      event: SecurityEventName.AUTHORIZATION_DECISION,
      decision: 'deny',
      reason: SecurityDecisionReason.OWNERSHIP_DENIED,
      subjectId: 'user-1',
      permission: 'users:read',
      resource: 'user',
      targetId: 'user-2',
    });

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      {
        event: 'authorization.decision',
        decision: 'deny',
        reason: 'ownership_denied',
        subjectId: 'user-1',
        permission: 'users:read',
        resource: 'user',
        targetId: 'user-2',
      },
      'authorization decision',
    );
    expect(log.info).not.toHaveBeenCalled();
  });

  it('emits allows at info level with optional fields omitted when absent', () => {
    const log = fakeLogger();

    logSecurityDecision(log, {
      event: SecurityEventName.AUTHORIZATION_DECISION,
      decision: 'allow',
      reason: SecurityDecisionReason.PERMISSION_OVERRIDE,
      subjectId: 'admin-1',
    });

    expect(log.info).toHaveBeenCalledTimes(1);
    const [fields] = log.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(Object.keys(fields).sort()).toEqual(
      ['decision', 'event', 'reason', 'subjectId'].sort(),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('supports the authentication-boundary event with its own name', () => {
    const log = fakeLogger();

    logSecurityDecision(log, {
      event: SecurityEventName.AUTHENTICATION_SUBJECT_INVALID,
      decision: 'deny',
      reason: SecurityDecisionReason.SUBJECT_INVALID,
      subjectId: 'deleted-user',
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'authentication.subject_invalid' }),
      'authorization decision',
    );
  });

  it('classifies any non-allow decision at warn level', () => {
    const log = fakeLogger();

    logSecurityDecision(log, {
      event: SecurityEventName.AUTHORIZATION_DECISION,
      decision: 'unexpected' as unknown as 'deny',
      reason: SecurityDecisionReason.PERMISSION_DENIED,
      subjectId: 'user-1',
    });

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('freezes the event and reason vocabularies', () => {
    expect(Object.isFrozen(SecurityEventName)).toBe(true);
    expect(Object.isFrozen(SecurityDecisionReason)).toBe(true);
  });

  it('exposes the documented helper surface', () => {
    expect(authorizationLogger.logSecurityDecision).toBe(logSecurityDecision);
    expect(authorizationLogger.SecurityEventName).toBe(SecurityEventName);
    expect(authorizationLogger.SecurityDecisionReason).toBe(SecurityDecisionReason);
  });
});
