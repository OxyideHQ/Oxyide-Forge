import type { Redis } from 'ioredis';

import { prisma } from '../../platform/database/prisma.js';

/**
 * Dependency health model (M9.2).
 *
 * The frozen M9.1 contract requires `/health/ready` to answer "can this
 * instance serve traffic?" using the status code as the entire signal: the
 * probe body is exactly `{}` and never carries dependency detail, because the
 * endpoint is unauthenticated and the M8.2/M8.3 privacy boundary forbids
 * infrastructure detail leaking through an operational surface.
 *
 * That makes this type the only place dependency state exists. It is
 * deliberately minimal and deliberately HTTP-free:
 *
 * - `name` comes from a closed tuple, so a dependency label can never be
 *   derived from configuration, the environment, or request input.
 * - `status` is a three-valued closed union (`healthy | unhealthy |
 *   not_configured`). There is no error field, no message, no cause, and no
 *   duration. A driver error can therefore not be carried upward even by
 *   accident, and the value is deterministic: the same dependency state always
 *   produces the same value.
 * - Durations were considered and rejected — they are nondeterministic, and
 *   nothing consumes them.
 *
 * This is not a registry, a framework, or an extension point. It is one frozen
 * union (extended deliberately in M9.3 with the optional `redis` member) and
 * one function per dependency, and it exists because the M9.1 readiness
 * contract requires it. M9.1 froze that an absent optional dependency never
 * makes an instance un-ready, which `not_configured` preserves honestly
 * instead of flattening it into `healthy`.
 */

/** Closed dependency vocabulary. Adding a name is a reviewed contract change. */
export const DEPENDENCY_NAMES = ['postgresql', 'redis'] as const;

export type DependencyName = (typeof DEPENDENCY_NAMES)[number];

/**
 * - `healthy` — reachable and usable.
 * - `unhealthy` — configured but currently unusable.
 * - `not_configured` — the optional dependency was never configured.
 *
 * `not_configured` exists so an absent optional dependency is reported
 * honestly instead of being flattened into `healthy`. Collapsing the two would
 * make a configured-but-broken Redis indistinguishable from no Redis at all in
 * logs and tests, which is precisely the confusion M9.3 was raised to remove.
 * Only optional dependencies may report it; a required dependency that cannot
 * report `healthy` is never ready.
 */
export type DependencyStatus = 'healthy' | 'unhealthy' | 'not_configured';

export interface DependencyHealth {
  readonly name: DependencyName;
  readonly status: DependencyStatus;
}

/**
 * Reports whether PostgreSQL is currently usable by this application.
 *
 * Implementation notes:
 *
 * - **A real round-trip, not `$connect()`.** `prisma.$connect()` short-circuits
 *   when the pool already holds a connection, so it would report `healthy`
 *   after the database had died. Readiness must observe the server, not the
 *   client's belief about it (M91-F07).
 * - **`SELECT 1` is a constant literal.** It is the only statement in `src/`
 *   that is raw SQL, and it is deliberately so: a connectivity probe cannot
 *   use an application query (that would make readiness depend on business
 *   schema and could read user data), and Prisma exposes no non-raw primitive
 *   that performs a server round-trip. The template literal carries **no
 *   interpolation**, so there is no injection surface and no request-derived
 *   value reaches the statement (M91-F08).
 * - **It touches no table**, so it mutates nothing, needs no schema permission
 *   beyond connectivity, and cannot be blocked by a missing relation.
 * - **It never throws.** Every failure — unreachable host, authentication
 *   failure, pool exhaustion, statement timeout, driver error — is mapped to
 *   `unhealthy`. Callers may rely on totality, which is what lets the readiness
 *   aggregation stay a plain `Promise.all`.
 * - **No connection is created or retained by this call.** It borrows the
 *   single existing `prisma` singleton, so repeated and concurrent probes add
 *   no clients, no pools, and no cleanup obligations (ARCH-ENF-003).
 *
 * Probe latency is bounded by the operator's `DATABASE_URL` `connect_timeout`
 * and `pool_timeout`, which this project already validates and owns. No
 * application-level timeout is introduced here, because inventing one would
 * create a second, conflicting timeout mechanism (M91-F06).
 */
export async function checkPostgresHealth(): Promise<DependencyHealth> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { name: 'postgresql', status: 'healthy' };
  } catch {
    // The error is intentionally discarded and never logged, returned, or
    // attached: a Prisma or driver error can contain the connection string,
    // host, port, user, or SQL text. The operator learns that readiness failed
    // from the route's bounded log line; the reason stays in PostgreSQL's and
    // the platform's own diagnostics.
    return { name: 'postgresql', status: 'unhealthy' };
  }
}

/**
 * Reports whether the optional Redis dependency is currently usable.
 *
 * The client is supplied by the caller rather than created here, so the
 * application keeps exactly one Redis client (the one `redisPlugin` owns and
 * decorates) and no second connection system is introduced. A missing client
 * means Redis was never configured, which is reported as `not_configured`.
 *
 * `PING` is the check, for the same reasons `SELECT 1` is the PostgreSQL one:
 * it is a single constant command that observes the server, needs no key, reads
 * and writes no application data, and cannot be blocked by key permissions. It
 * is also a genuine round-trip rather than a cached status — `client.status`
 * would keep reporting the last known state.
 *
 * Because ioredis reconnects on its own, a Redis that returns after an outage
 * starts answering `PING` again with no application restart. `lazyConnect`
 * means the first `ping()` connects on demand, so this also works when the
 * startup connect never succeeded.
 *
 * Total, like `checkPostgresHealth`: a `PING` rejection — unreachable host,
 * auth failure, timeout, driver error — becomes `unhealthy` and the error is
 * discarded rather than propagated, because it can carry the connection URL,
 * host, port, or credentials.
 */
export async function checkRedisHealth(context: {
  readonly redis?: Redis;
}): Promise<DependencyHealth> {
  if (context.redis === undefined) {
    return { name: 'redis', status: 'not_configured' };
  }

  try {
    await context.redis.ping();
    return { name: 'redis', status: 'healthy' };
  } catch {
    return { name: 'redis', status: 'unhealthy' };
  }
}
