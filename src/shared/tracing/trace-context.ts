/**
 * W3C Trace Context extraction boundary (M8.4).
 *
 * Reads the inbound `traceparent` header, if present, and validates it
 * strictly. This is a correlation-metadata boundary, never a security
 * boundary: the result is opaque, carries no identity, influences no
 * decision, and can never overwrite the canonical M6 request ID.
 *
 * Accepted: exactly version `00` in the form
 * `00-<32 lowercase hex>-<16 lowercase hex>-<2 lowercase hex>`, with
 * non-zero trace and span IDs (W3C §traceparent). Everything else —
 * unknown versions (forward-compat fallback), `ff`, all-zero IDs,
 * uppercase, truncation, oversized values, arrays, non-strings — yields
 * `null`: absent trace context, never an error, never a bypass.
 *
 * Total function: no throw paths. `tracestate` is intentionally not parsed
 * (vendor-specific; Forge has no consumer for it).
 */
export const TRACEPARENT_HEADER = 'traceparent';

/** Maximum accepted header length: the exact v00 shape, nothing longer. */
const MAX_TRACEPARENT_LENGTH = 55;

const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const ZERO_TRACE_ID = '00000000000000000000000000000000';
const ZERO_SPAN_ID = '0000000000000000';

/**
 * Request-scoped distributed-trace correlation. Opaque and independent
 * from authentication, user identity, and database IDs. Complements the
 * M6 request ID; never replaces it.
 */
export type TraceContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
};

/**
 * Extracts and validates the inbound W3C trace context from normalized
 * request headers (lowercase names, as Fastify provides them). Returns
 * `null` for absent, malformed, hostile, or unsupported input.
 */
export function extractTraceContext(headers: unknown): TraceContext | null {
  if (typeof headers !== 'object' || headers === null) {
    return null;
  }
  const raw = (headers as Record<string, unknown>)[TRACEPARENT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TRACEPARENT_LENGTH) {
    return null;
  }
  const match = TRACEPARENT_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const version = match[1];
  const traceId = match[2];
  const spanId = match[3];
  const flags = match[4];
  if (version === 'ff' || version !== '00') {
    return null;
  }
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    return null;
  }
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}
