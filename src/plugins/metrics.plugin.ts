import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import type { PrometheusMetrics } from '../shared/metrics/prometheus.js';

export type MetricsPluginOptions = {
  /** Renders the current metrics in Prometheus text exposition format. */
  exporter: PrometheusMetrics;
};

/** Prometheus text exposition format v0.0.4. */
const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Prometheus-compatible /metrics endpoint (M14.3).
 *
 * Registered only when `METRICS_ENABLED` is on. Serves the bounded HTTP
 * instruments recorded by the telemetry plugin (same `PrometheusMetrics`
 * adapter is passed as the telemetry metrics backend, so there is a single
 * producer). The route is `hide`-flagged like `/openapi.json`, so it never
 * enters the public OpenAPI document, and it carries the usual empty-body
 * operational contract: no secrets, no raw paths, only bounded label values.
 */
const metricsPluginCallback: FastifyPluginAsync<MetricsPluginOptions> = async (
  app: FastifyInstance,
  options: MetricsPluginOptions,
): Promise<void> => {
  app.get(
    '/metrics',
    {
      schema: {
        hide: true, // operational endpoint — not part of the public API surface
        tags: ['Operational'],
        summary: 'Prometheus metrics',
        description:
          'Prometheus text exposition of bounded HTTP request, error, and duration metrics. Labels are limited to method, route template, and status code.',
        operationId: 'metrics',
        security: [],
      },
    },
    async (_request, reply) => reply.type(METRICS_CONTENT_TYPE).send(options.exporter.render()),
  );
};

export const metricsPlugin = fp(metricsPluginCallback);
