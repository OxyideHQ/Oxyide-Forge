import type { TraceContext } from './trace-context.js';

/**
 * Forge-owned tracing abstraction (M8.4): the optional OpenTelemetry
 * integration boundary.
 *
 * Application and business code must depend ONLY on these two interfaces —
 * never on an OpenTelemetry SDK, tracer provider, exporter, or transport.
 * There is deliberately no OpenTelemetry dependency in `package.json`:
 * the default `noopTracer` below is the production behavior until a
 * customer supplies an adapter implementing this interface (documented
 * adapter point; customer-owned SDK, backend, and sampling).
 *
 * Rules for every implementation, including customer adapters:
 * - Spans are request-scoped and must never cross requests.
 * - `setAttribute` keys/values must never carry secrets, PII, tokens,
 *   headers, cookies, bodies, or query values (M8.2 binding).
 * - A throwing tracer must never break a request — callers guard.
 */
export type SpanAttributeValue = string | number | boolean;

export type Span = {
  end(): void;
  setAttribute(key: string, value: SpanAttributeValue): void;
};

export type Tracer = {
  startSpan(name: string, context?: TraceContext | null): Span;
};

const noopSpan: Span = {
  end: () => {},
  setAttribute: () => {},
};

/** Default tracer: fully functional application with zero telemetry. */
export const noopTracer: Tracer = {
  startSpan: () => noopSpan,
};
