/**
 * M9.4 — shutdown readiness lifecycle tests.
 *
 * M91-F12: shutdown had no observable beginning, so a readiness request already
 * past Fastify's closing check could still be answered `200` by Forge while the
 * instance was already on its way out.
 *
 * The lifecycle under test:
 *
 *   RUNNING → shutdown begins → Forge-owned window (an in-flight request that
 *   already passed the closing check) answers `503 {}` from
 *   `evaluateReadiness({ draining: true })` → Fastify's own drain short-circuit
 *   takes over for every later request → listener closes → Prisma/Redis cleanup
 *
 * That two-window split is a framework fact, established by reading
 * `node_modules/fastify/lib/route.js`: `close()` marks the instance closing and
 * closes the route tree, and per-request the `closing` check short-circuits
 * *before* the handler chain. So once routes are closed no Forge handler can
 * run at all, and `app.inject()` observes Fastify's drain response rather than
 * ours. Both windows are asserted explicitly below rather than one being
 * quietly ignored.
 *
 * Probes use `app.inject()`, which dispatches through the real router and the
 * real handler chain, so this is the same path a keep-alive probe takes.
 */

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only, therefore erased before the hoisted `vi.mock` factory runs.
import type * as DatabaseModule from '../platform/database/prisma.js';

type QueryRaw = (...args: unknown[]) => Promise<unknown>;

/** 'healthy' delegates to real PostgreSQL; 'reject' simulates an outage. */
let mode: 'healthy' | 'reject' = 'healthy';
let queryRawCalls: unknown[][] = [];
let originalQueryRaw: QueryRaw | undefined;

vi.mock('../platform/database/prisma.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  const client = actual.prisma;
  originalQueryRaw = client.$queryRaw.bind(client) as QueryRaw;

  client.$queryRaw = (async (...args: unknown[]) => {
    queryRawCalls.push(args);
    if (mode === 'reject') {
      throw new Error(
        'P1001: Cannot reach database server at `oxyide_starter`5432`user=forge`password=hunter2',
      );
    }
    return (originalQueryRaw as QueryRaw)(...args);
  }) as typeof client.$queryRaw;

  return { ...actual, prisma: client };
});

const { buildApp } = await import('./app.js');
const { prisma } = await import('../platform/database/prisma.js');
const { evaluateReadiness } = await import('../modules/health/health.service.js');

const READY = '/health/ready';
const LIVE = '/health/live';

/** Fastify's drain body, pinned so a framework change cannot pass unnoticed. */
const FASTIFY_DRAIN_BODY = {
  error: 'Service Unavailable',
  message: 'Service Unavailable',
  statusCode: 503,
};

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
});

beforeEach(() => {
  mode = 'healthy';
  queryRawCalls = [];
});

afterEach(() => {
  mode = 'healthy';
});

describe('M9.4 lifecycle: running', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ loggerStream: process.stderr });
  });

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  it('starts not draining and reports ready with a healthy database', async () => {
    expect(app.shutdownPhase.draining).toBe(false);

    const response = await app.inject({ method: 'GET', url: READY });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it('decorates the shutdown phase exactly once per instance', async () => {
    expect(app.hasDecorator('shutdownPhase')).toBe(true);
    expect(app.shutdownPhase).toEqual({ draining: false });
  });

  it('keeps per-instance phase isolation across two applications', async () => {
    // Two instances must not share phase state, or closing one would mark the
    // other as draining.
    const second = await buildApp({ loggerStream: process.stderr });

    await app.close();

    expect(second.shutdownPhase.draining).toBe(false);
    expect((await second.inject({ method: 'GET', url: READY })).statusCode).toBe(200);

    await second.close();
  });

  it('reports not ready when PostgreSQL is unavailable while running', async () => {
    mode = 'reject';

    const response = await app.inject({ method: 'GET', url: READY });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({});
    expect(app.shutdownPhase.draining).toBe(false);
  });

  it('keeps liveness healthy and independent while running', async () => {
    const live = await app.inject({ method: 'GET', url: LIVE });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({});
  });
});

describe('M9.4 lifecycle: shutdown begins (M91-F12)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mode = 'healthy';
    app = await buildApp({ loggerStream: process.stderr });
  });

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  it('flips the phase in preClose, before the listener closes', async () => {
    // `app.inject()` is refused once close() has completed, so the drain window
    // can only be observed while it is still in flight. Probing once proves the
    // window is open (`closing === true` is set immediately before `preClose`
    // runs), and by then `preClose` has definitely executed — so this is a
    // deterministic ordering proof rather than a timing race.
    expect(app.shutdownPhase.draining).toBe(false);

    const closing = app.close();
    const inWindow = await app.inject({ method: 'GET', url: READY });

    expect(inWindow.statusCode).toBe(503);
    expect(app.shutdownPhase.draining).toBe(true);

    await closing;
    expect(app.shutdownPhase.draining).toBe(true);
  });

  it('pins the framework drain contract: 503 with Fastify body on every route', async () => {
    const closing = app.close();

    // Documented consequence, asserted rather than hidden: the drain
    // short-circuit precedes the handler chain, so `/health/live` is also 503
    // here and unrelated routes are too. This is Fastify's load-shedding fast
    // path; see app.ts `return503OnClosing` and finding M94-F02.
    // Issued concurrently because the window closes as soon as close() settles.
    const [live, unrelated] = await Promise.all([
      app.inject({ method: 'GET', url: LIVE }),
      app.inject({ method: 'GET', url: '/api/v1/roles' }),
    ]);

    expect(live.statusCode).toBe(503);
    expect(live.json()).toEqual(FASTIFY_DRAIN_BODY);
    expect(unrelated.statusCode).toBe(503);
    expect(unrelated.json()).toEqual(FASTIFY_DRAIN_BODY);

    await closing;
  });

  it('withdraws traffic: both probes are refused once routes are closed', async () => {
    const closing = app.close();

    // Framework-owned drain response. Readiness must not report ready — that
    // is the substance of M91-F12 — and the body is Fastify's, asserted
    // exactly so a framework change cannot pass unnoticed.
    const ready = await app.inject({ method: 'GET', url: READY });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual(FASTIFY_DRAIN_BODY);

    await closing;
  });

  it('completes shutdown and cleans up', async () => {
    await app.close();

    // close() resolving is the completion signal: Fastify closed, then
    // disconnectPrisma() ran in the shutdown handler. No leak, no hang.
    expect(app.shutdownPhase.draining).toBe(true);
  });

  it('tolerates a repeated close without throwing', async () => {
    await app.close();

    // A duplicate signal path must not fail shutdown.
    await expect(app.close()).resolves.toBeUndefined();
    expect(app.shutdownPhase.draining).toBe(true);
  });

  it('answers concurrent probes consistently during shutdown', async () => {
    const closing = app.close();

    const results = await Promise.all(
      Array.from({ length: 12 }, () => app.inject({ method: 'GET', url: READY })),
    );

    // No request crosses lifecycle state incorrectly: not one may report ready.
    for (const response of results) {
      expect(response.statusCode).toBe(503);
    }

    await closing;
  });

  it('exposes no lifecycle or dependency detail in the drain response', async () => {
    const closing = app.close();

    const response = await app.inject({ method: 'GET', url: READY });
    expect(response.statusCode).toBe(503);

    for (const forbidden of [
      'draining',
      'shutdown',
      'prisma',
      'postgres',
      'hunter2',
      '5432',
      'DATABASE_URL',
    ]) {
      expect(response.body, `drain response leaked ${forbidden}`).not.toContain(forbidden);
    }

    await closing;
  });

  it('emits no security event for a draining readiness failure', async () => {
    const lines: string[] = [];
    const application = await buildApp({
      loggerStream: {
        write: (chunk: string) => {
          lines.push(chunk);
          return true;
        },
      },
    });

    const closing = application.close();
    await application.inject({ method: 'GET', url: READY });
    await closing;

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
});

describe('M9.4 lifecycle: the Forge-owned window', () => {
  /**
   * A request that already passed Fastify's closing check still reaches Forge's
   * handler. That is the only window Forge controls, and without
   * `shutdownPhase.draining` a healthy database would let it answer 200 — the
   * exact M91-F12 defect. It cannot be provoked through `inject` (which always
   * takes the short-circuit path once routes close), so it is asserted directly
   * at the decision boundary that owns it.
   */
  it('reports not ready without consulting dependencies', async () => {
    queryRawCalls = [];
    const report = await evaluateReadiness({ draining: true });

    expect(report).toEqual({ ready: false, dependencies: [], draining: true });
    // Presence assertion: a draining instance must not spend a database
    // round-trip, and must not report ready on the strength of healthy deps.
    expect(queryRawCalls).toHaveLength(0);
  });

  it('stays not ready even with a healthy database', async () => {
    const report = await evaluateReadiness({ draining: true });
    expect(report.ready).toBe(false);
  });

  it('stays not ready when a dependency is also down', async () => {
    mode = 'reject';
    const report = await evaluateReadiness({ draining: true });

    expect(report.ready).toBe(false);
    expect(queryRawCalls).toHaveLength(0);
  });

  it('reports draining: false and consults dependencies when not draining', async () => {
    queryRawCalls = [];
    const report = await evaluateReadiness({});

    expect(report.draining).toBe(false);
    expect(report.ready).toBe(true);
    expect(queryRawCalls.length).toBeGreaterThan(0);
  });

  it('defaults to not draining when the flag is absent', async () => {
    const report = await evaluateReadiness();
    expect(report.draining).toBe(false);
  });

  it('keeps the PostgreSQL/Redis matrix intact when not draining', async () => {
    mode = 'healthy';

    // Redis absent (no client passed) + healthy PostgreSQL -> ready.
    expect((await evaluateReadiness({})).ready).toBe(true);

    // Redis configured but unreachable -> not ready.
    const failing = {
      ping: async (): Promise<string> => {
        throw new Error('connect ECONNREFUSED');
      },
    };
    const withFailingRedis = await evaluateReadiness({ redis: failing as never });
    expect(withFailingRedis.ready).toBe(false);
    expect(withFailingRedis.draining).toBe(false);

    // Redis configured and healthy -> ready.
    const working = { ping: async (): Promise<string> => 'PONG' };
    expect((await evaluateReadiness({ redis: working as never })).ready).toBe(true);
  });

  it('is unaffected by draining when PostgreSQL is genuinely down', async () => {
    mode = 'reject';
    const report = await evaluateReadiness({ draining: true });
    expect(report.ready).toBe(false);
  });
});
