import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { extractTraceContext } from '../shared/tracing/trace-context.js';
import { noopTracer, type Tracer } from '../shared/tracing/tracer.js';
import { noopMetrics, type ForgeMetrics } from '../shared/metrics/metrics.js';

export type TelemetryPluginOptions = {
  tracer?: Tracer;
  metrics?: ForgeMetrics;
};

/**
 * Optional observability integration boundary (M8.4).
 *
 * Two hooks, both NoOp-cheap by default:
 * - `onRequest` attaches the validated inbound W3C trace context (or
 *   `null`) as `request.traceContext`. The header value itself is never
 *   logged and never trusted beyond opaque correlation.
 * - `onResponse` records the three fixed HTTP instruments with bounded
 *   labels only: `method` (server-observed verb), `route` (Fastify's
 *   route template — one of the frozen paths — or the literal
 *   `'unknown'` bucket for unmatched URLs, never the raw URL), and
 *   `status` (numeric status string). Recording is guarded: a throwing
 *   customer implementation can never fail, delay, or alter a response.
 *
 * Deliberately absent: spans (no Forge-level consumer exists — customer
 * adapters span from `request.traceContext`), traceId in log lines or
 * security events (frozen M8.1/M8.3 shapes), and any exporter/backend.
 */
const telemetryPluginCallback: FastifyPluginAsync<TelemetryPluginOptions> = async (
  app: FastifyInstance,
  options: TelemetryPluginOptions = {},
): Promise<void> => {
  const tracer = options.tracer ?? noopTracer;
  const metrics = options.metrics ?? noopMetrics;
  app.decorate('telemetry', { tracer, metrics });
  app.decorateRequest('traceContext', null);

  app.addHook('onRequest', async (request: FastifyRequest): Promise<void> => {
    request.traceContext = extractTraceContext(request.headers);
  });

  app.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    try {
      const route = request.routeOptions?.url ?? 'unknown';
      const method = request.method;
      const status = String(reply.statusCode);
      metrics.httpRequestsTotal.increment({ method, route, status });
      const elapsedSeconds = reply.elapsedTime / 1000;
      if (Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0) {
        metrics.httpRequestDurationSeconds.observe(elapsedSeconds, { method, route });
      }
      if (reply.statusCode >= 500) {
        metrics.httpErrorsTotal.increment({ method, route, status });
      }
    } catch {
      // Observability must never break requests (M8.4 §14).
    }
    done();
  });
};

export const telemetryPlugin = fp(telemetryPluginCallback, {
  fastify: '5.x',
  name: 'telemetry-plugin',
});
