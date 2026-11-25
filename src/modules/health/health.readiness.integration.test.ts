/**
 * M9.2 — PostgreSQL readiness integration tests.
 *
 * Proves the frozen M9.1 readiness contract end to end through the real
 * Fastify application: the healthy path against real PostgreSQL, the failure
 * path against a simulated outage, liveness independence, the safety
 * properties, and concurrency.
 *
 * Failure simulation works by shadowing `$queryRaw` on the SHARED singleton
 * (not by constructing a second client and not by pointing the application at
 * a different database). In healthy mode the call is delegated straight to the
 * real implementation, so the passing tests exercise a genuine round-trip
 * against real PostgreSQL rather than a stub. ARCH-ENF-003 independently
 * enforces that exactly one `PrismaClient` is constructed in production.
 *
 * Requires a running PostgreSQL instance at DATABASE_URL; the suite fails fast
 * rather than silently passing.
 */

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only, therefore erased before the hoisted `vi.mock` factory runs.
import type * as DatabaseModule from '../../platform/database/prisma.js';
import type { Redis } from 'ioredis';

type QueryRaw = (...args: unknown[]) => Promise<unknown>;

/** 'healthy' delegates to real PostgreSQL; 'reject' simulates an outage. */
let mode: 'healthy' | 'reject' = 'healthy';
/** Every argument list the readiness check passed to `$queryRaw`. */
let queryRawCalls: unknown[][] = [];
let originalQueryRaw: QueryRaw | undefined;

vi.mock('../../platform/database/prisma.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  const client = actual.prisma;
  originalQueryRaw = client.$queryRaw.bind(client) as QueryRaw;

  // Shadowed on the shared singleton so identity is preserved: a test can
  // assert readiness uses THE application client, not a private one.
  client.$queryRaw = (async (...args: unknown[]) => {
    queryRawCalls.push(args);
    if (mode === 'reject') {
      // Deliberately toxic: a real Prisma/driver failure carries the host,
      // port, user and sometimes the statement. Nothing may leak it.
      throw new Error(
        'P1001: Cannot reach database server at `oxyide_starter`5432`user=forge`password=hunter2',
      );
    }
    return (originalQueryRaw as QueryRaw)(...args);
  }) as typeof client.$queryRaw;

  return { ...actual, prisma: client };
});

const { buildApp } = await import('../../app/app.js');
const { prisma } = await import('../../platform/database/prisma.js');

let app: FastifyInstance;

const READY = '/health/ready';
const LIVE = '/health/live';

/** Values that must never appear in a probe response or a log line. */
const FORBIDDEN_IN_RESPONSE = [
  'P1001',
  'prisma',
  'Prisma',
  'postgres',
  'PostgreSQL',
  'oxyide_starter',
  'hunter2',
  'forge',
  '5432',
  'password',
  'DATABASE_URL',
  'SELECT',
  'select',
  'stack',
  'at ',
  'Error',
  'error',
];

beforeAll(async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run integration tests with NODE_ENV=production.');
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    throw new Error(
      'PostgreSQL unavailable: integration tests require a running database at DATABASE_URL.',
    );
  }

  app = await buildApp({ loggerStream: process.stderr });
});

afterAll(async () => {
  if (originalQueryRaw !== undefined) {
    prisma.$queryRaw = originalQueryRaw as typeof prisma.$queryRaw;
  }
  await app.close();
});

beforeEach(() => {
  mode = 'healthy';
  queryRawCalls = [];
});

afterEach(() => {
  mode = 'healthy';
});

describe('M9.2 readiness: PostgreSQL healthy', () => {
  it('reports ready with an empty body through a real database round-trip', async () => {
    const response = await app.inject({ method: 'GET', url: READY });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
    // A real query happened — the passing path is not a stub.
    expect(queryRawCalls.length).toBeGreaterThan(0);
  });

  it('stays ready across repeated probes', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: READY });
      expect(response.statusCode, `attempt ${attempt}`).toBe(200);
      expect(response.json()).toEqual({});
    }
    // Exactly one lightweight round-trip per probe: no accumulation, no
    // per-request pool growth, no repeated probing within a request.
    expect(queryRawCalls).toHaveLength(5);
  });
});

describe('M9.2 readiness: PostgreSQL unavailable', () => {
  beforeEach(() => {
    mode = 'reject';
  });

  it('reports not ready with 503 and the frozen empty body', async () => {
    const response = await app.inject({ method: 'GET', url: READY });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({});
  });

  it('exposes no infrastructure detail in the failure response', async () => {
    const response = await app.inject({ method: 'GET', url: READY });
    const raw = response.body;

    for (const forbidden of FORBIDDEN_IN_RESPONSE) {
      expect(raw, `response leaked ${forbidden}`).not.toContain(forbidden);
    }
    // The body is exactly an empty JSON object, nothing else.
    expect(raw).toBe('{}');
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('recovers to ready once the dependency returns, with no restart', async () => {
    const failed = await app.inject({ method: 'GET', url: READY });
    expect(failed.statusCode).toBe(503);

    mode = 'healthy';

    const recovered = await app.inject({ method: 'GET', url: READY });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({});
  });

  it('does not crash the process and stays responsive on other routes', async () => {
    await app.inject({ method: 'GET', url: READY });

    // Liveness, the not-found handler, and a protected route must all still
    // behave: an outage is not a crash and not a global failure.
    expect((await app.inject({ method: 'GET', url: LIVE })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
  });

  it('keeps repeated failing probes stable and cheap', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: READY });
      expect(response.statusCode, `attempt ${attempt}`).toBe(503);
    }
    expect(queryRawCalls).toHaveLength(5);
  });
});

describe('M9.2 liveness independence', () => {
  beforeEach(() => {
    mode = 'reject';
  });

  it('stays healthy while PostgreSQL is down', async () => {
    const response = await app.inject({ method: 'GET', url: LIVE });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it('never executes the dependency check', async () => {
    await app.inject({ method: 'GET', url: LIVE });

    // Presence assertion, not absence: the frozen M9.1 contract (M9-F01) is
    // that liveness must never touch a dependency. If a future change routes
    // liveness through the readiness service, this fails.
    expect(queryRawCalls).toHaveLength(0);
  });

  it('diverges from readiness at the same instant', async () => {
    const [live, ready] = await Promise.all([
      app.inject({ method: 'GET', url: LIVE }),
      app.inject({ method: 'GET', url: READY }),
    ]);

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
  });
});

describe('M9.2 safety properties', () => {
  it('uses the shared application PrismaClient', async () => {
    await app.inject({ method: 'GET', url: READY });

    // The readiness check runs against the singleton the rest of the
    // application uses, so no second client, pool, or credential exists.
    const module = await import('../../platform/database/prisma.js');
    expect(module.prisma).toBe(prisma);
  });

  it('issues one constant read-only statement and no mutation', async () => {
    await app.inject({ method: 'GET', url: READY });

    expect(queryRawCalls).toHaveLength(1);
    const [statement] = queryRawCalls[0] ?? [];
    // A tagged template with no interpolation: the statement is a compile-time
    // constant, so no request-derived value can reach the database.
    expect(String(statement)).toContain('SELECT 1');
    expect(queryRawCalls[0]).toHaveLength(1);

    const sql = String(statement).toUpperCase();
    for (const forbidden of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE']) {
      expect(sql, `probe statement contains ${forbidden}`).not.toContain(forbidden);
    }
    // No relation is named, so the probe needs no schema permission and
    // cannot be blocked by a missing or renamed table.
    expect(sql).not.toContain('"');
  });

  it('never runs migrations', async () => {
    await app.inject({ method: 'GET', url: READY });

    // Migrations are a deploy-time concern (src/../prisma), never a probe
    // concern. The readiness path imports nothing from there.
    const healthModule = await import('../../modules/health/health.service.js');
    expect(healthModule.evaluateReadiness).toBeTypeOf('function');
    expect(String(healthModule.evaluateReadiness)).not.toMatch(/migrate|db push|reset/i);
  });

  it('does not emit security events for a dependency outage', async () => {
    mode = 'reject';

    const lines: string[] = [];
    const capturing = await buildApp({
      loggerStream: {
        write: (chunk: string) => {
          lines.push(chunk);
          return true;
        },
      },
    });

    await capturing.inject({ method: 'GET', url: READY });
    await capturing.close();

    const emitted = lines.join('');
    expect(emitted).toContain('Readiness check failed');
    // A database outage is operational, not a security event: the M8.3
    // vocabulary must not appear.
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
    // Bounded, closed-vocabulary log fields; no driver detail.
    expect(emitted).toContain('postgresql');
    expect(emitted).not.toContain('P1001');
    expect(emitted).not.toContain('hunter2');
    expect(emitted).not.toContain('oxyide_starter');
    // Port-context check (M10.2): a bare '5432' substring also matches
    // nondeterministic numeric log fields — epoch-millisecond `time` values
    // (e.g. ...263804) and float `responseTime` values (e.g. 1.82...6380...) —
    // which made this gate flaky (one observed spurious failure). The injected
    // failure carries the port backtick-wrapped (`5432`), a shape no timestamp
    // or timing can produce, so the canary keeps its power without the flake.
    expect(emitted).not.toContain('`5432`');
  });
});

describe('M9.2 concurrency', () => {
  it('answers simultaneous readiness probes consistently', async () => {
    mode = 'reject';

    const responses = await Promise.all(
      Array.from({ length: 12 }, () => app.inject({ method: 'GET', url: READY })),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({});
    }
    expect(queryRawCalls).toHaveLength(12);
  });

  it('answers simultaneous probes consistently when healthy', async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => app.inject({ method: 'GET', url: READY })),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({});
    }
  });

  it('does not cross-contaminate liveness and readiness under load', async () => {
    mode = 'reject';

    const results = await Promise.all(
      Array.from({ length: 16 }, (_unused, index) =>
        app.inject({ method: 'GET', url: index % 2 === 0 ? LIVE : READY }),
      ),
    );

    results.forEach((response, index) => {
      const expected = index % 2 === 0 ? 200 : 503;
      expect(response.statusCode, `request ${index}`).toBe(expected);
    });
  });

  it('recovers cleanly after a concurrent outage burst', async () => {
    mode = 'reject';
    await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: 'GET', url: READY })));

    mode = 'healthy';
    const recovered = await Promise.all(
      Array.from({ length: 6 }, () => app.inject({ method: 'GET', url: READY })),
    );

    for (const response of recovered) {
      expect(response.statusCode).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// M9.3 — optional Redis readiness: the full dependency matrix
// ---------------------------------------------------------------------------

/**
 * A stand-in for the single application-owned Redis client. It is decorated
 * onto a dedicated app instance so the route reads it exactly as it reads the
 * real `redisPlugin` decoration — no second client, no production seam.
 *
 * The cast is confined to this one helper on purpose: `Redis` is a ~450-member
 * third-party interface, and a test double for a readiness probe needs exactly
 * one of them (`ping`). The same pattern already exists in
 * `src/platform/cache/redis.test.ts` for the same reason. Production code
 * contains no such cast.
 */
function fakeRedis(behaviour: 'healthy' | 'unhealthy'): Redis {
  const client = {
    ping: async (): Promise<string> => {
      if (behaviour === 'unhealthy') {
        throw new Error(
          'READONLY Authentication failed against redis://forge:hunter2@cache.internal:6380/0',
        );
      }
      return 'PONG';
    },
  };

  return client as unknown as Redis;
}

describe('M9.3 readiness matrix (PostgreSQL required, Redis optional)', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.map((application) => application.close()));
    apps.length = 0;
  });

  async function appWithRedis(behaviour?: 'healthy' | 'unhealthy'): Promise<FastifyInstance> {
    const application = await buildApp({ loggerStream: process.stderr });
    if (behaviour !== undefined) {
      // Decorated before the instance is ready, mirroring redisPlugin.
      application.decorate('redis', fakeRedis(behaviour));
    }
    apps.push(application);
    return application;
  }

  it('case 1: PostgreSQL healthy + Redis not configured -> 200', async () => {
    mode = 'healthy';
    const application = await appWithRedis();

    expect(application.hasDecorator('redis')).toBe(false);
    const response = await application.inject({ method: 'GET', url: READY });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it('case 2: PostgreSQL healthy + Redis healthy -> 200', async () => {
    mode = 'healthy';
    const application = await appWithRedis('healthy');

    const response = await application.inject({ method: 'GET', url: READY });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it('case 3: PostgreSQL healthy + Redis unhealthy -> 503', async () => {
    mode = 'healthy';
    const application = await appWithRedis('unhealthy');

    const response = await application.inject({ method: 'GET', url: READY });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({});
  });

  it('case 4: PostgreSQL unhealthy + Redis healthy -> 503', async () => {
    mode = 'reject';
    const application = await appWithRedis('healthy');

    const response = await application.inject({ method: 'GET', url: READY });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({});
  });

  it('case 5: PostgreSQL unhealthy + Redis not configured -> 503', async () => {
    mode = 'reject';
    const application = await appWithRedis();

    const response = await application.inject({ method: 'GET', url: READY });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({});
  });

  it('case 5b: PostgreSQL unhealthy + Redis unhealthy -> 503', async () => {
    mode = 'reject';
    const application = await appWithRedis('unhealthy');

    expect((await application.inject({ method: 'GET', url: READY })).statusCode).toBe(503);
  });

  it('never lets an unhealthy Redis affect liveness', async () => {
    mode = 'healthy';
    const application = await appWithRedis('unhealthy');

    expect((await application.inject({ method: 'GET', url: LIVE })).statusCode).toBe(200);
    expect((await application.inject({ method: 'GET', url: READY })).statusCode).toBe(503);
  });

  it('keeps PostgreSQL mandatory: no Redis state can make it ready', async () => {
    mode = 'reject';

    for (const behaviour of [undefined, 'healthy', 'unhealthy'] as const) {
      const application = await appWithRedis(behaviour);
      const response = await application.inject({ method: 'GET', url: READY });
      expect(response.statusCode, `redis ${String(behaviour)}`).toBe(503);
    }
  });

  it('reports the failing dependency without exposing Redis detail', async () => {
    mode = 'healthy';
    const lines: string[] = [];
    const application = await buildApp({
      loggerStream: {
        write: (chunk: string) => {
          lines.push(chunk);
          return true;
        },
      },
    });
    application.decorate('redis', fakeRedis('unhealthy'));
    apps.push(application);

    const response = await application.inject({ method: 'GET', url: READY });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{}');

    const emitted = lines.join('');
    expect(emitted).toContain('redis');
    // The Redis URL *value*, its credentials, host and port must never appear.
    // Note the deliberate omission of a bare `REDIS_URL` check: the variable's
    // NAME appears by design in the plugin's static operator message ("Redis
    // not configured (REDIS_URL not set)"), which is safe and pre-existing.
    // What redaction protects — and what this asserts — is the value, and
    // `config.cache.redis.url` is already a compiled-in redact path.
    for (const secret of ['hunter2', 'cache.internal', 'redis://forge', 'READONLY']) {
      expect(emitted, `log leaked ${secret}`).not.toContain(secret);
    }
    // Port-context check (M10.2): a bare '6380' substring also matches
    // nondeterministic numeric log fields — epoch-millisecond `time` values
    // such as ...263804 and float `responseTime` values such as 1.82638... —
    // which caused one observed spurious failure of this gate. A genuine port
    // leak always carries URL context (`:6380/` or `:6380"`), which no
    // timestamp (epoch ms never starts with 6380) or timing (a 6380+ ms
    // responseTime would be followed by `.`, not `/` or `"`) can produce.
    expect(emitted).not.toMatch(/:6380[/"]/);
  });

  it('recovers from a Redis outage without a restart', async () => {
    mode = 'healthy';
    let behaviour: 'healthy' | 'unhealthy' = 'unhealthy';
    const application = await buildApp({ loggerStream: process.stderr });
    // Same single-cast test-double rationale as `fakeRedis` above; the client is
    // mutated in place so recovery is observed on the SAME running process.
    const client = fakeRedis('unhealthy');
    application.decorate('redis', client);
    apps.push(application);
    Object.defineProperty(client, 'ping', {
      value: async (): Promise<string> => {
        if (behaviour === 'unhealthy') {
          throw new Error('connect ECONNREFUSED');
        }
        return 'PONG';
      },
    });

    expect((await application.inject({ method: 'GET', url: READY })).statusCode).toBe(503);

    behaviour = 'healthy';

    const recovered = await application.inject({ method: 'GET', url: READY });
    expect(recovered.statusCode).toBe(200);
  });

  it('keeps concurrent mixed-dependency probes isolated', async () => {
    mode = 'healthy';
    const application = await appWithRedis('unhealthy');

    const results = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        application.inject({ method: 'GET', url: index % 2 === 0 ? LIVE : READY }),
      ),
    );

    results.forEach((response, index) => {
      expect(response.statusCode, `request ${index}`).toBe(index % 2 === 0 ? 200 : 503);
    });
  });
});
