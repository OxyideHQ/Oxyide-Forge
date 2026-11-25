import { describe, expect, it, vi } from 'vitest';

// Type-only, therefore erased before the hoisted `vi.mock` factories run.
import type { Redis } from 'ioredis';
import type * as ConfigModule from '../config/index.js';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

/**
 * M9.3 — Redis plugin startup policy.
 *
 * The behavior under test is the M91-F13 resolution: an unreachable but
 * *validly configured* Redis must no longer abort startup, because a process
 * that refuses to start cannot report that it is not ready. Invalid
 * configuration is a different matter and is not softened — it is rejected by
 * `src/config/env.schema.ts` before this plugin is ever reached.
 *
 * ioredis is mocked, so no Redis server is required and no socket is opened.
 * The mock deliberately reproduces the two properties that matter: a `connect()`
 * that can reject, and an `error` emitter that must carry a listener.
 *
 * `config` is recursively frozen (M5.2), so it cannot be mutated per test. The
 * `cache` key is therefore served through a proxy over the real config, which
 * keeps every other validated value intact while letting each test select the
 * Redis configuration state explicitly.
 */

let redisUrl: string | undefined;

vi.mock('../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get(target, property, receiver) {
        if (property === 'cache') {
          return redisUrl === undefined ? undefined : { redis: { url: redisUrl } };
        }
        return Reflect.get(target, property, receiver);
      },
    }),
  };
});

const connect = vi.fn<() => Promise<void>>();
const quit = vi.fn<() => Promise<string>>();
const ping = vi.fn<() => Promise<string>>();
const errorListeners: Array<(error: Error) => void> = [];
const on = vi.fn((event: string, listener: (error: Error) => void) => {
  if (event === 'error') {
    errorListeners.push(listener);
  }
  return redisClient;
});

const redisClient = {
  connect,
  quit,
  ping,
  on,
  status: 'ready',
} as unknown as Redis;

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => redisClient),
}));

const { buildApp } = await import('../app/app.js');
const { checkRedisHealth } = await import('../modules/health/dependency-health.js');

const HEALTHY_URL = 'redis://localhost:6379';

/** Toxic by design: every one of these must never reach a response or a log. */
const TOXIC_ERROR =
  'READONLY Authentication failed against redis://forge:hunter2@cache.internal:6380/0';

function reset(): void {
  redisUrl = undefined;
  connect.mockReset().mockResolvedValue(undefined);
  ping.mockReset().mockResolvedValue('PONG');
  errorListeners.length = 0;
}

function captureLogs(): { lines: string[]; stream: { write: (chunk: string) => boolean } } {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write: (chunk: string) => {
        lines.push(chunk);
        return true;
      },
    },
  };
}

describe('redisPlugin startup policy (M9.3)', () => {
  describe('Redis not configured', () => {
    it('starts normally and decorates no client', async () => {
      reset();
      const app = await buildApp();

      expect(app.hasDecorator('redis')).toBe(false);
      expect(connect).not.toHaveBeenCalled();

      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({});

      await app.close();
    });

    it('does not affect readiness at all', async () => {
      reset();
      const app = await buildApp();

      await app.inject({ method: 'GET', url: '/health/ready' });
      // Presence assertion: an unconfigured optional dependency must not be
      // probed, and must not be reported as unhealthy.
      expect(ping).not.toHaveBeenCalled();

      await app.close();
    });

    it('reports not_configured, distinct from healthy and unhealthy', async () => {
      reset();

      await expect(checkRedisHealth({})).resolves.toEqual({
        name: 'redis',
        status: 'not_configured',
      });
    });
  });

  describe('Redis configured and healthy', () => {
    it('connects once, decorates the client, and stays ready', async () => {
      reset();
      redisUrl = HEALTHY_URL;
      const app = await buildApp();

      expect(connect).toHaveBeenCalledTimes(1);
      expect(app.hasDecorator('redis')).toBe(true);

      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({});

      await app.close();
    });

    it('creates exactly one Redis client', async () => {
      reset();
      redisUrl = HEALTHY_URL;
      const { Redis } = await import('ioredis');
      (Redis as unknown as { mockClear: () => void }).mockClear();

      const app = await buildApp();
      expect(Redis).toHaveBeenCalledTimes(1);

      await app.close();
    });
  });

  describe('Redis configured but unavailable (M91-F13)', () => {
    it('does not abort startup', async () => {
      reset();
      redisUrl = HEALTHY_URL;
      connect.mockRejectedValue(new Error('connect ECONNREFUSED'));

      // The whole point of M9.3: buildApp resolves instead of throwing, so the
      // process becomes observable and readiness can report the outage.
      const app = await buildApp();

      expect(app.hasDecorator('redis')).toBe(true);
      await app.close();
    });

    it('does not silently become not_configured', async () => {
      // Presence assertion. The client stays decorated even though the startup
      // connect failed, which is exactly what distinguishes "configured but
      // broken" from "never configured" (milestone §7).
      reset();
      redisUrl = HEALTHY_URL;
      connect.mockRejectedValue(new Error('connect ECONNREFUSED'));
      ping.mockRejectedValue(new Error(TOXIC_ERROR));

      const app = await buildApp();
      expect(app.hasDecorator('redis')).toBe(true);

      await expect(checkRedisHealth({ redis: app.redis })).resolves.toEqual({
        name: 'redis',
        status: 'unhealthy',
      });

      await app.close();
    });

    it('remains observable and reports NOT READY on /health/ready', async () => {
      reset();
      redisUrl = HEALTHY_URL;
      connect.mockRejectedValue(new Error('connect ECONNREFUSED'));
      ping.mockRejectedValue(new Error(TOXIC_ERROR));

      const app = await buildApp();

      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({});

      await app.close();
    });

    it('keeps liveness healthy while readiness is not ready', async () => {
      reset();
      redisUrl = HEALTHY_URL;
      connect.mockRejectedValue(new Error('connect ECONNREFUSED'));
      ping.mockRejectedValue(new Error(TOXIC_ERROR));

      const app = await buildApp();

      const live = await app.inject({ method: 'GET', url: '/health/live' });
      const ready = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({});
      expect(ready.statusCode).toBe(503);

      await app.close();
    });

    it('registers an error listener so an ioredis error cannot crash the process', async () => {
      // An EventEmitter `error` with no listener is thrown as an uncaught
      // exception. ioredis emits `error` on every failed connect and retry, so
      // without this listener "Redis down" would still kill the process and
      // defeat the entire M9.3 policy.
      reset();
      redisUrl = HEALTHY_URL;
      connect.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const app = await buildApp();

      expect(on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(errorListeners.length).toBeGreaterThan(0);
      // And the listener must actually be invocable — an inert registration
      // would satisfy the assertion above while still crashing on emit.
      expect(() => {
        for (const listener of errorListeners) {
          listener(new Error(TOXIC_ERROR));
        }
      }).not.toThrow();

      await app.close();
    });

    it('recovers without an application restart', async () => {
      reset();
      redisUrl = HEALTHY_URL;
      connect.mockRejectedValue(new Error('connect ECONNREFUSED'));
      ping.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const app = await buildApp();
      expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);

      // Redis comes back. The same running process must observe it.
      ping.mockResolvedValue('PONG');

      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({});

      await app.close();
    });

    it('exposes no Redis error detail in the response or the logs', async () => {
      reset();
      redisUrl = HEALTHY_URL;
      connect.mockRejectedValue(new Error(TOXIC_ERROR));
      ping.mockRejectedValue(new Error(TOXIC_ERROR));
      const { lines, stream } = captureLogs();

      const app = await buildApp({ loggerStream: stream });
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      await app.close();

      expect(response.statusCode).toBe(503);
      expect(response.body).toBe('{}');

      const emitted = lines.join('');
      for (const secret of [
        'hunter2',
        'cache.internal',
        'REDIS_URL',
        'READONLY',
        'ECONNREFUSED',
      ]) {
        expect(emitted, `log leaked ${secret}`).not.toContain(secret);
      }
      // Port-context check (M10.2): a bare '6380' substring also matches
      // nondeterministic numeric log fields — epoch-millisecond `time` values
      // and float `responseTime` values — which caused one observed spurious
      // failure of the sibling readiness gate. A genuine port leak always
      // carries URL context (`:6380/` or `:6380"`), which no timestamp or
      // timing can produce.
      expect(emitted).not.toMatch(/:6380[/"]/);
      // The bounded, closed-vocabulary field is what operators get instead.
      expect(emitted).toContain('redis');
    });

    it('emits no security event for an ordinary Redis outage', async () => {
      reset();
      redisUrl = HEALTHY_URL;
      connect.mockRejectedValue(new Error('connect ECONNREFUSED'));
      ping.mockRejectedValue(new Error(TOXIC_ERROR));
      const { lines, stream } = captureLogs();

      const app = await buildApp({ loggerStream: stream });
      await app.inject({ method: 'GET', url: '/health/ready' });
      await app.close();

      const emitted = lines.join('');
      for (const forbidden of [
        'auth.login',
        'auth.session',
        'auth.account',
        'auth.refresh',
        'auth.password_reset',
        'auth.email_verification',
        'authorization.decision',
      ]) {
        expect(emitted, `security event ${forbidden} emitted`).not.toContain(forbidden);
      }
    });

    it('handles concurrent readiness probes without cross-contamination', async () => {
      reset();
      redisUrl = HEALTHY_URL;
      connect.mockRejectedValue(new Error('connect ECONNREFUSED'));
      ping.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const app = await buildApp();

      const results = await Promise.all(
        Array.from({ length: 12 }, (_unused, index) =>
          app.inject({ method: 'GET', url: index % 3 === 0 ? '/health/live' : '/health/ready' }),
        ),
      );

      results.forEach((response, index) => {
        const expected = index % 3 === 0 ? 200 : 503;
        expect(response.statusCode, `request ${index}`).toBe(expected);
      });
      // Exactly one PING per readiness probe: no accumulation across requests.
      expect(ping).toHaveBeenCalledTimes(8);

      await app.close();
    });
  });

  describe('invalid configuration', () => {
    it('is refused by validated config, and never conflated with an unreachable one', async () => {
      // The individual config cases (valid redis://, valid rediss://, absent,
      // trimmed, wrong protocol, empty) are already proven in
      // src/config/index.test.ts and are deliberately not duplicated here.
      //
      // What is new in M9.3 is the *distinction* the milestone cares about: an
      // INVALID url aborts startup, while an unreachable but VALID url does
      // not. Parsed through the real schema so the plugin is never reached with
      // a value the configuration layer would have rejected.
      const { envSchema } = await import('../config/env.schema.js');
      const parseWith = (redisUrl: string | undefined): boolean =>
        envSchema.safeParse({
          ...process.env,
          ...(redisUrl === undefined ? {} : { REDIS_URL: redisUrl }),
        }).success;

      expect(parseWith('redis://localhost:6379')).toBe(true);
      expect(parseWith('rediss://localhost:6380')).toBe(true);
      expect(parseWith(undefined)).toBe(true);
      expect(parseWith('http://localhost:6379')).toBe(false);
      expect(parseWith('not-a-url')).toBe(false);
      expect(parseWith('   ')).toBe(false);
    });
  });
});
