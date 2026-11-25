import type { FastifyInstance } from 'fastify';

import { evaluateReadiness } from './health.service.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health/live',
    {
      schema: {
        tags: ['Health'],
        summary: 'Liveness probe',
        description:
          'Process-availability probe for orchestrators. Unauthenticated, dependency-free, always 200 with an empty object while the process serves traffic.',
        operationId: 'healthLive',
        security: [],
      },
    },
    async () => ({}),
  );
  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['Health'],
        summary: 'Readiness probe',
        description:
          'Traffic-serving readiness probe. Unauthenticated. Returns 200 with an empty object when the instance is accepting traffic, and 503 with an empty object otherwise: a required dependency is unusable, a configured optional dependency is unhealthy, or shutdown is in progress. PostgreSQL is the only required dependency; the cache is optional and is probed only when configured. The body is always empty by design: the status code is the entire signal, so no dependency state, version, host, or error detail is ever exposed. Use /health/live to decide whether to restart the process; it never depends on a dependency and stays 200 while traffic drains.',
        operationId: 'healthReady',
        security: [],
      },
    },
    async (request, reply) => {
      // The application-owned Redis client (undefined when never configured)
      // and the observable shutdown phase. Both are passed in so this module
      // stays free of framework types, the application keeps exactly one Redis
      // client, and readiness stays decided in exactly one place.
      const report = await evaluateReadiness({
        redis: request.server.redis,
        draining: request.server.shutdownPhase.draining,
      });

      if (!report.ready) {
        // M9.2: the un-ready state is logged with bounded, closed-vocabulary
        // fields on the existing request-scoped pipeline. Dependency names
        // come from a frozen union, never from configuration or request
        // input, so this line cannot carry unbounded or attacker-influenced
        // data. The underlying Prisma/driver error is deliberately absent — it
        // can contain the connection string, host, port, user, or SQL text,
        // and it is never logged here. No new logging mechanism, no new
        // telemetry contract, and no security event: a database outage is an
        // operational condition, not a security one.
        //
        // Volume note: this fires once per un-ready probe, so a persistent
        // outage produces one warn line per orchestrator probe interval. That
        // is accepted deliberately. Suppressing it would mean remembering the
        // previous state, i.e. mutable per-process health state, which the
        // frozen M8 request-context contract forbids.
        request.log.warn(
          {
            draining: report.draining,
            dependencies: report.dependencies
              .filter((dependency) => dependency.status === 'unhealthy')
              .map((dependency) => dependency.name),
          },
          'Readiness check failed',
        );

        return reply.status(503).send({});
      }

      return reply.status(200).send({});
    },
  );
}