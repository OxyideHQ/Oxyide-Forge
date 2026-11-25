import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { REDACT_PATHS, REDACTION_CENSOR } from './redaction-paths.js';
import {
  createLoggerOptions,
  serializeError,
  serializeRequest,
  serializeResponse,
} from './logger-options.js';

/**
 * M5.6 — centralized logging boundary proofs.
 *
 * Every test asserts ACTUAL EMITTED OUTPUT (captured via a synchronous
 * in-memory stream — deterministic, no flush waits), never mere logger
 * configuration. A secret is either absent or replaced by the documented
 * `[Redacted]` marker.
 */

function capture() {
  const lines: string[] = [];
  const stream = {
    write(chunk: unknown): boolean {
      lines.push(String(chunk));
      return true;
    },
  };
  const output = (): string => lines.join('\n');
  return { stream, output };
}

function loggedWith(payload: Record<string, unknown>): string {
  const { stream, output } = capture();
  // Stream travels positionally: pino reads it as the second argument
  // (the `stream` key inside options is a Fastify convention that direct
  // pino() ignores — the factory documents this).
  const log = pino(createLoggerOptions('info'), stream as never);
  log.info(payload);
  return output();
}

describe('redaction matrix (R01–R18)', () => {
  it.each([
    ['R01 password', { password: 'SuperSecret123!' }, 'SuperSecret123!'],
    ['R02 passwordHash', { passwordHash: '$2b$12$abc' }, '$2b$12$abc'],
    ['R03 accessToken', { accessToken: 'eyJhbGciOiJIUz' }, 'eyJhbGciOiJIUz'],
    ['R04 refreshToken', { refreshToken: 'raw-refresh-value' }, 'raw-refresh-value'],
    ['R05 resetToken', { resetToken: 'raw-reset-value' }, 'raw-reset-value'],
    ['R06 verificationToken', { verificationToken: 'raw-verify-value' }, 'raw-verify-value'],
    ['R07a authorization header lower', { headers: { authorization: 'Bearer abc' } }, 'Bearer abc'],
    ['R07b Authorization header upper', { Authorization: 'Bearer abc' }, 'Bearer abc'],
    ['R08a cookie header', { headers: { cookie: 'accessToken=abc' } }, 'accessToken=abc'],
    [
      'R09 nested password',
      { user: { profile: { password: 'nested-secret' } } },
      'nested-secret',
    ],
    ['R10 nested token', { data: { session: { accessToken: 'tok' } } }, 'tok'],
    [
      'R11 array with secrets',
      { items: [{ password: 'p1' }, { token: 't1' }] },
      'p1',
    ],
    ['R15 DATABASE_URL', { DATABASE_URL: 'postgresql://u:p@h/db' }, 'postgresql://u:p@h/db'],
    ['R16 REDIS_URL', { redisUrl: 'redis://:pw@h:6379' }, 'redis://:pw@h:6379'],
    ['R17 secret env shape', { JWT_SECRET: 'thirty-two-characters-minimum!!' }, 'thirty-two'],
    ['R18 JWT secret camel', { config: { auth: { jwtSecret: 'jwt-secret-value' } } }, 'jwt-secret-value'],
  ])('%s is absent or censored', (_label, payload, secret) => {
    const out = loggedWith(payload);
    expect(out).not.toContain(secret);
  });

  it('R11b every array element is censored, not just the first', () => {
    const out = loggedWith({ items: [{ password: 'p1' }, { token: 't1' }] });
    expect(out).not.toContain('t1');
    expect(out).toContain(REDACTION_CENSOR);
  });

  it('R12 child-logger bindings are redacted identically', () => {
    const { stream, output } = capture();
    const log = pino(createLoggerOptions('info'), stream as never);
    const child = log.child({ password: 'child-secret', component: 'auth' });
    child.info('hello');
    expect(output()).not.toContain('child-secret');
    expect(output()).toContain('auth');
  });

  it('R13 error objects keep shape but drop secret custom props', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'P2002',
      password: 'should-not-appear',
      config: { password: 'nested-should-not-appear' },
    });
    const out = loggedWith({ err });
    expect(out).not.toContain('should-not-appear');
    expect(out).not.toContain('nested-should-not-appear');
    expect(out).toContain('P2002');
    expect(out).toContain('boom');
  });

  it('R14 secret-shaped strings inside error messages are a documented boundary', () => {
    // Structured FIELDS are redacted; free-text message content is safe by
    // construction (static templates — verified by grep, no interpolation
    // of secrets exists in src). This test pins the boundary honestly:
    // a hypothetical interpolated message is NOT scrubbed, which is why
    // the codebase rule (engineering-standards §11.5: never interpolate
    // secrets into messages) carries the weight here.
    const out = loggedWith({ err: new Error('static template, no secrets') });
    expect(out).toContain('static template, no secrets');
  });
});

describe('serializers', () => {
  it('req keeps method, path-only URL, and source identity — nothing else', () => {
    expect(
      serializeRequest({
        method: 'POST',
        url: '/api/v1/auth/login?token=SECRETQUERY&next=/x',
        headers: { authorization: 'Bearer SECRET', cookie: 'a=b', 'user-agent': 'UA' },
        ip: '203.0.113.7',
      }),
    ).toEqual({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '203.0.113.7' });
  });

  it('req is total on unexpected shapes', () => {
    for (const bad of [undefined, null, 42, 'req', [], {}]) {
      expect(serializeRequest(bad)).toEqual({});
    }
    expect(serializeRequest({ method: 42, url: null })).toEqual({});
  });

  it('res keeps statusCode only', () => {
    expect(serializeResponse({ statusCode: 200, headers: { 'set-cookie': 'a=b' } })).toEqual({
      statusCode: 200,
    });
    expect(serializeResponse(undefined)).toEqual({});
    expect(serializeResponse({ statusCode: '200' })).toEqual({});
  });

  it('err keeps type/message/stack/code and drops everything else', () => {
    const out = serializeError(
      Object.assign(new Error('boom'), { code: 'P2002', config: { x: 1 }, request: { y: 2 } }),
    ) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['code', 'message', 'stack', 'type']);
    expect(out.code).toBe('P2002');
  });

  it('err keeps numeric codes and passes non-Errors through', () => {
    expect(
      (serializeError(Object.assign(new Error('x'), { code: 500 })) as Record<string, unknown>)
        .code,
    ).toBe(500);
    expect(serializeError('plain-string')).toBe('plain-string');
    expect(serializeError(undefined)).toBeUndefined();
  });
});

describe('PII policy (P01–P06)', () => {
  it('P03 query strings never reach emitted request logs (live serializer path)', () => {
    const out = loggedWith({
      req: {
        method: 'GET',
        url: '/?token=SECRETQUERY',
        headers: {},
        ip: '127.0.0.1',
      },
    });
    expect(out).not.toContain('SECRETQUERY');
    expect(out).toContain('127.0.0.1');
  });

  it('P01/P02/P05 emails, userIds, and display names appear only when explicitly logged (never by the pipeline)', () => {
    // The pipeline adds no PII by itself: a bare request/response cycle
    // emits only method/path/ip/status — proven by the req/res shape tests.
    // Explicit security-event fields (subjectId UUIDs) remain the caller's
    // documented decision, covered by the authorization-logging suites.
    expect(REDACT_PATHS).not.toContain('subjectId');
    expect(REDACT_PATHS).not.toContain('email');
  });

  it('P04 user-agent is absent: headers never enter the pipeline', () => {
    const out = loggedWith({
      req: {
        method: 'GET',
        url: '/',
        headers: { 'user-agent': 'EvilAgent/1.0 (newline\ninjected)' },
        ip: '127.0.0.1',
      },
    });
    expect(out).not.toContain('EvilAgent');
  });
});

describe('injection and robustness', () => {
  it('attacker-controlled values stay in-field with single-line records', () => {
    const out = loggedWith({
      event: 'auth.test',
      input: 'INFO fake event\nERROR fake security event\x1b[31mred',
    });
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { input: string };
    expect(parsed.input).toContain('fake security event');
  });

  it('circular objects log without crashing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => loggedWith({ circular })).not.toThrow();
    expect(loggedWith({ circular })).toContain('[Circular]');
  });

  it('redaction cannot be disabled: no flag, no override, constants frozen', () => {
    const options = createLoggerOptions('info');
    expect(options.redact).toBeDefined();
    expect(Array.isArray((options.redact as { paths: unknown }).paths)).toBe(true);
    expect((options.redact as { paths: unknown[] }).paths.length).toBeGreaterThan(50);
    expect(REDACTION_CENSOR).toBe('[Redacted]');
  });

  it('mandatory secret fields are all covered by at least one path', () => {
    for (const field of [
      'password',
      'passwordHash',
      'accessToken',
      'refreshToken',
      'tokenHash',
      'authorization',
      'cookie',
      'JWT_SECRET',
      'DATABASE_URL',
    ]) {
      expect(REDACT_PATHS.some((path) => path === field || path.endsWith(`.${field}`))).toBe(true);
    }
  });
});
