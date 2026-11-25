import Fastify, {
  LogController,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { DestinationStream } from 'pino';
import { config } from '../config/index.js';
import type { MappedError } from '../shared/errors/error-mapper.js';
import {
  buildInstance,
  mapError,
  sendMappedError,
  sendNotFoundProblem,
  SANITIZED_INTERNAL_ERROR,
} from '../shared/errors/error-mapper.js';
import { createLoggerOptions } from '../shared/logging/logger-options.js';
import { authPlugin } from '../plugins/auth.plugin.js';
import { cookiePlugin } from '../plugins/cookie.plugin.js';
import { corsPlugin } from '../plugins/cors.plugin.js';
import { redisPlugin } from '../plugins/redis.plugin.js';
import { requestIdPlugin } from '../plugins/request-id.plugin.js';
import { telemetryPlugin } from '../plugins/telemetry.plugin.js';
import { metricsPlugin } from '../plugins/metrics.plugin.js';
import { prometheusMetrics } from '../shared/metrics/prometheus.js';
import type { Tracer } from '../shared/tracing/tracer.js';
import type { ForgeMetrics } from '../shared/metrics/metrics.js';
import { securityHeadersPlugin } from '../plugins/security-headers.plugin.js';
import { swaggerPlugin } from '../plugins/swagger.plugin.js';
import { createDeprecationRouteHook } from '../shared/api-lifecycle/deprecation.js';
import { registerLifecycleHooks } from './lifecycle.js';
import { registerRoutes } from './routes.js';

/**
 * Registers the V1 global error handler.
 *
 * This is a minimal security boundary, not the deferred centralized error
 * mapper. It guarantees that unexpected server-side errors never leak raw
 * messages, stack traces, Prisma internals, database hosts/ports, filesystem
 * paths, or configuration values to clients. Known client errors (4xx) keep
 * Fastify's documented V1 behavior unchanged. See ADR 005.
 *
 * Classification and body construction live in the centralized mapper
 * (`src/shared/errors/error-mapper.ts`, M6.2): this handler only routes
 * the mapped result (log unexpected, send). Behavior is unchanged.
 *
 * M6.8 — this function is the last thing standing between a thrown value
 * and the wire, so serialization runs inside a guard. A throw escaping
 * here is caught by Fastify, which then serializes the failure itself and
 * emits a native `application/json` body carrying the raw message — the
 * uncontrolled response the centralized boundary exists to prevent. The
 * guard guarantees the wire representation is always canonical Problem
 * Details. It suppresses nothing: the original failure still propagates
 * from its throw site and still produces exactly one operator log line
 * below.
 */
export function registerGlobalErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply): void => {
      const instance = buildInstance(request.id);
      let mapped: MappedError;
      try {
        mapped = mapError(error);
      } catch {
        mapped = SANITIZED_INTERNAL_ERROR;
      }

      if (!mapped.expected) {
        request.log.error({ err: error }, 'Unhandled server error');
      }

      // M6.4: every supported error classifies to a canonical problem
      // (AppError, Prisma, Fastify, or sanitized internal). No native
      // passthrough remains on supported paths.
      try {
        sendMappedError(reply, mapped, instance);
      } catch {
        sendMappedError(reply, SANITIZED_INTERNAL_ERROR, instance);
      }
    },
  );
}

/**
 * Registers the V1 not-found handler.
 *
 * Fastify's default 404 handler interpolates the full request URL
 * (including the query string) into BOTH the response body and an
 * info-level log line — so `GET /?token=secret` would place the secret
 * in logs, past every serializer and redaction path (message-embedding
 * is outside the structured-field boundary). This handler keeps the
 * default response keys with a generic message and logs nothing: the
 * sanitized `request completed` line already records method, path
 * (query stripped), and 404 status. See M5.6 audit §M56-F01.
 *
 * The body uses the canonical Problem Details contract (M6.3), built by
 * the centralized mapper — this handler constructs nothing itself.
 */
export function registerNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply): void => {
    sendNotFoundProblem(reply, buildInstance(request.id));
  });
}

/**
 * Deprecation route hook (M7.7). Module-level so it is created once per
 * application instance rather than per route registration.
 */
const deprecationRouteHooks = createDeprecationRouteHook();

export async function buildApp(options?: {
  /**
   * Optional log destination override (operational plumbing: file or
   * aggregation transports, deterministic test capture). Changes WHERE
   * lines go, never WHAT they contain — serializers and redaction apply
   * identically. Absent means the default process output.
   */
  loggerStream?: DestinationStream;
  /**
   * Optional observability integrations (M8.4). Customer-supplied tracer
   * and metrics; both default to NoOp, so the application runs normally
   * with no telemetry backend. Never required, never read from config.
   */
  tracer?: Tracer;
  metrics?: ForgeMetrics;
}): Promise<FastifyInstance> {
  const app = Fastify({
    // Centralized secure-logging boundary (M5.6): sanitized serializers
    // plus non-disableable redaction, shared with the startup fallback.
    // See src/shared/logging/logger-options.ts.
    logger: createLoggerOptions(config.logLevel, options?.loggerStream),
    // Request lifecycle logging (M8.1): Fastify's `incoming request` /
    // `request completed` info lines are an intentional operational signal
    // (method, query-stripped path, status, duration, reqId — shapes pinned
    // by the serializers above). Stated explicitly through the supported
    // `logController` API (the top-level flag is deprecated upstream) so a
    // framework-default change can never silently remove these lines;
    // behavior is unchanged.
    logController: new LogController({ disableRequestLogging: false }),
    // Graceful-drain responses (M9.4). When `close()` begins, Fastify marks the
    // instance closing and closes the route tree, then short-circuits every
    // request with a bare `503 {"error":"Service Unavailable",...}` BEFORE the
    // handler chain runs. That is the framework's load-shedding fast path, and
    // it is correct here: an instance on its way out must not start new work,
    // and a load balancer must be told to redirect elsewhere.
    //
    // Pinned explicitly rather than inherited, for the same reason
    // `disableRequestLogging` is pinned above: a framework default change must
    // never silently alter drain semantics. Set to `false`, a draining instance
    // would instead 404 every route (the route tree is already closed), which
    // is strictly worse — 503 is semantically correct for "not serving".
    //
    // Consequence accepted and documented rather than hidden: during the short
    // drain window the response is Fastify-owned, so it is a `503` with
    // Fastify's body on *every* route, including `/health/live`, and its shape
    // is not Forge's frozen `{}`. No Forge handler can run in that window.
    // What Forge controls is the window *before* it — an in-flight request that
    // already passed the closing check — which is exactly what
    // `shutdownPhase.draining` (src/app/lifecycle.ts) exists to answer.
    return503OnClosing: true,
    // Explicit transport caps (M5.3): both values match the previous
    // implicit Fastify defaults, so legitimate traffic is unaffected while
    // oversized inputs reject before any handler runs — bodies with 413,
    // oversized route params with 414 at routing time (before
    // authentication, schemas, or handlers). `maxParamLength` lives under
    // `routerOptions`: Fastify 5 still accepts it top-level but emits
    // FSTDEP022 there (removed in fastify@6). Endpoint `:id` / `:name`
    // schemas intentionally carry no maxLength: the transport cap is the
    // single uniform bound for every route.
    bodyLimit: config.http.bodyLimitBytes,
    routerOptions: {
      maxParamLength: config.http.maxParamLength,
    },
    ajv: {
      customOptions: {
        // Fastify 5 defaults to removeAdditional: true, which silently strips
        // unknown properties instead of rejecting them. Setting this to false
        // ensures additionalProperties: false in schemas returns 400.
        removeAdditional: false,
        // Fastify 5 defaults to coerceTypes: true, which silently coerces
        // numbers to strings (e.g., 12345 → "12345") for type: 'string' schemas.
        // Setting this to false ensures strict type validation for request bodies.
        coerceTypes: false,
      },
    },
  });

  registerGlobalErrorHandler(app);
  registerNotFoundHandler(app);
  registerLifecycleHooks(app);
  // API deprecation signalling (M7.7): installs an onSend hook **only** on
  // routes that declare `schema.deprecation`. Active routes are untouched,
  // so there is no global middleware and no per-response cost today.
  app.addHook('onRoute', deprecationRouteHooks.onRoute);
  await app.register(securityHeadersPlugin);
  // API documentation (M7.6): registered before routes so generation
  // observes every route. Honors config.docs — registers nothing when
  // OpenAPI is disabled; Swagger UI only when both flags allow.
  await app.register(swaggerPlugin);
  await app.register(requestIdPlugin);
  // Optional observability boundary (M8.4): trace-context extraction plus
  // bounded HTTP instruments, NoOp unless the caller supplies integrations.
  // Registered before routes so hooks and decorations cover every route.
  // M14.3: when METRICS_ENABLED, a single Prometheus adapter is both the
  // telemetry metrics backend (the only producer) and the /metrics renderer,
  // so counts cannot be double-recorded.
  const metricsExporter = config.metrics.enabled ? prometheusMetrics() : undefined;
  await app.register(telemetryPlugin, {
    tracer: options?.tracer,
    metrics: options?.metrics ?? metricsExporter?.metrics,
  });
  if (metricsExporter !== undefined) {
    await app.register(metricsPlugin, { exporter: metricsExporter });
  }
  await app.register(corsPlugin);
  await app.register(cookiePlugin);
  await app.register(authPlugin);
  await app.register(redisPlugin);
  await app.register(registerRoutes);

  return app;
}
