import { describe, expect, it } from 'vitest';

import {
  AuthSecurityEventName,
  emitAuthSecurityEvent,
  noopSecurityEventLog,
  type AuthSecurityEventInput,
  type SecurityEventLog,
} from './auth-security-events.js';

function recordingLog(): SecurityEventLog & { calls: Array<{ level: string; fields: object }> } {
  const calls: Array<{ level: string; fields: object }> = [];
  return {
    calls,
    info: (fields) => {
      calls.push({ level: 'info', fields });
    },
    warn: (fields) => {
      calls.push({ level: 'warn', fields });
    },
  };
}

/**
 * M8.3 — auth security-event boundary proofs (no pipeline).
 *
 * The emitter builds exact allowlisted payloads and chooses the level
 * from the outcome. Vocabulary stability is pinned: new events are a
 * deliberate contract addition, never an accident.
 */
describe('auth security event vocabulary', () => {
  it('freezes the closed event names', () => {
    expect(AuthSecurityEventName).toEqual({
      LOGIN_SUCCESS: 'auth.login.success',
      LOGIN_FAILURE: 'auth.login.failure',
      ACCOUNT_LOCKED: 'auth.account.locked',
      REFRESH_REPLAY: 'auth.refresh.replay',
      SESSION_REVOKED: 'auth.session.revoked',
      SESSIONS_REVOKED_ALL: 'auth.sessions.revoked_all',
      PASSWORD_RESET_REQUESTED: 'auth.password_reset.requested',
      PASSWORD_RESET_COMPLETED: 'auth.password_reset.completed',
      EMAIL_VERIFICATION_REQUESTED: 'auth.email_verification.requested',
      EMAIL_VERIFICATION_COMPLETED: 'auth.email_verification.completed',
    });
  });

  it('emits exactly the allowlisted fields — nothing can be attached', () => {
    const log = recordingLog();
    emitAuthSecurityEvent(log, {
      event: AuthSecurityEventName.LOGIN_SUCCESS,
      outcome: 'success',
      subjectId: 'user-1',
    });
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]).toEqual({
      level: 'info',
      fields: { event: 'auth.login.success', outcome: 'success', subjectId: 'user-1' },
    });
  });

  it('omits absent optionals rather than emitting undefined keys', () => {
    const log = recordingLog();
    emitAuthSecurityEvent(log, {
      event: AuthSecurityEventName.PASSWORD_RESET_REQUESTED,
      outcome: 'requested',
    });
    expect(log.calls[0].fields).toEqual({
      event: 'auth.password_reset.requested',
      outcome: 'requested',
    });
  });

  it('levels success info and every other outcome warn', () => {
    const cases: Array<{ input: AuthSecurityEventInput; level: string }> = [
      {
        input: { event: AuthSecurityEventName.LOGIN_SUCCESS, outcome: 'success' },
        level: 'info',
      },
      {
        input: { event: AuthSecurityEventName.LOGIN_FAILURE, outcome: 'failure', reason: 'invalid_credentials' },
        level: 'warn',
      },
      {
        input: { event: AuthSecurityEventName.ACCOUNT_LOCKED, outcome: 'locked' },
        level: 'warn',
      },
      {
        input: { event: AuthSecurityEventName.REFRESH_REPLAY, outcome: 'replay_detected' },
        level: 'warn',
      },
    ];
    for (const { input, level } of cases) {
      const log = recordingLog();
      emitAuthSecurityEvent(log, input);
      expect(log.calls[0].level).toBe(level);
    }
  });

  it('noop sink never throws and never calls out', () => {
    expect(() =>
      emitAuthSecurityEvent(noopSecurityEventLog, {
        event: AuthSecurityEventName.LOGIN_SUCCESS,
        outcome: 'success',
        subjectId: 'user-1',
      }),
    ).not.toThrow();
  });
});
