import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { config } from '../config/index.js';
import { createRedisClient, disconnectRedis } from '../platform/cache/redis.js';

/**
 * Redis plugin — infrastructure-only.
 * Creates and connects a Redis client during application startup.
 * Disconnects during application shutdown.
 * Exposes the Redis client through Fastify decoration.
 * Does not contain business logic.
 * Does not query the database.
 * Does not handle application-level caching.
 *
 * M9.3 — optional-dependency failure policy (amends ADR-003 §"Redis connection
 * failure during startup prevents application from starting"):
 *
 * A failed Redis connection no longer aborts startup. ADR-003 originally chose
 * fail-fast on the rationale that Redis would back sessions, refresh tokens and
 * distributed rate limiting. **No application code consumes Redis today** — no
 * module imports the cache service or `app.redis` — so that rationale rests on
 * consumers that do not exist yet, while the cost of fail-fast is severe: a
 * cache outage becomes a total application outage in which `/health/ready`
 * cannot report anything at all, because the process that would report it never
 * starts. That defeats the purpose of a readiness probe.
 *
 * The new policy keeps Redis strictly optional while making its state
 * observable:
 *
 * - Unconfigured (`config.cache` undefined) → plugin skips, `app.redis` is
 *   undefined, readiness ignores Redis entirely.
 * - Configured and reachable → connected at startup, `app.redis` decorated.
 * - Configured but unreachable → **startup continues**, the client is still
 *   decorated so readiness can probe it and recovery needs no restart, and
 *   `/health/ready` reports `503` while `/health/live` stays `200`.
 *
 * Invalid configuration is NOT softened: `REDIS_URL` is validated by
 * `src/config/env.schema.ts`, so a malformed value fails configuration loading
 * and aborts startup with a clear message. Only an unreachable *valid* server
 * is tolerated. An optional dependency that fails must never silently become
 * "not configured" — readiness distinguishes the two.
 */
const redisPluginCallback: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  if (!config.cache) {
    app.log.warn('Redis not configured (REDIS_URL not set) — skipping Redis plugin');
    return;
  }

  const client = createRedisClient(config.cache.redis.url);

  // Mandatory before any connection attempt: ioredis emits `error` on every
  // failed connection and retry, and an EventEmitter `error` with no listener
  // is thrown as an uncaught exception — which would kill the process. Since
  // M9.3 makes a Redis outage non-fatal by design, this listener is what
  // actually keeps the application observable. Without it, "Redis down" would
  // still mean "process dead". Logged at debug to bound volume: ioredis retries
  // and would otherwise emit one line per attempt, while the operator-facing
  // signal is the single readiness warn line.
  client.on('error', () => {
    app.log.debug('Redis client error');
  });

  try {
    await client.connect();
    app.log.info('Redis connected');
  } catch {
    // Deliberately not rethrown, and deliberately not disconnected: the client
    // is kept (and decorated) so readiness can probe it, so ioredis can finish
    // its own reconnect, and so recovery needs no application restart. The
    // underlying error is intentionally not logged — a Redis driver error can
    // contain the connection URL, host, port, or credentials.
    app.log.warn(
      'Redis connection failed at startup — continuing without Redis; readiness will report it as unhealthy',
    );
  }

  app.decorate('redis', client);

  app.addHook('onClose', async () => {
    await disconnectRedis(client);
    app.log.info('Redis disconnected');
  });
};

export const redisPlugin = fp(redisPluginCallback, {
  fastify: '5.x',
  name: 'redis-plugin',
});
