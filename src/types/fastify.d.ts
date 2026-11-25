import type { Redis } from 'ioredis';
import type { AuthContext } from './auth-context.js';
import type { ShutdownPhase } from './shutdown-phase.js';
import type { TraceContext } from '../shared/tracing/trace-context.js';
import type { Tracer } from '../shared/tracing/tracer.js';
import type { ForgeMetrics } from '../shared/metrics/metrics.js';

declare module 'fastify' {
  interface FastifyInstance {
    // Verifies the request credential and attaches request.auth.
    // Throws AppError on any failure (M6.2: the centralized mapper builds
    // the public body); never replies directly.
    authenticate: (request: FastifyRequest) => Promise<void>;
    redis?: Redis;
    /**
     * Observable shutdown phase (M9.4). `draining` becomes true in the
     * `preClose` hook — while the listener still answers requests — so
     * readiness can withdraw traffic before the socket disappears. Per
     * instance, never global, never per-request (M8-F03 intact).
     */
    shutdownPhase: ShutdownPhase;
    // Optional observability integrations (M8.4): customer-supplied tracer
    // and metrics, NoOp by default. Decorated by the telemetry plugin.
    telemetry?: { tracer: Tracer; metrics: ForgeMetrics };
  }

  interface FastifyRequest {
    auth?: AuthContext;
    // Validated inbound W3C trace context, or null (M8.4). Opaque
    // correlation metadata only: complements the canonical M6 request ID,
    // never replaces it, influences no decision.
    traceContext?: TraceContext | null;
  }
}
