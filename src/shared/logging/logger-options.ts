import type { DestinationStream, LoggerOptions } from 'pino';

import { REDACT_PATHS, REDACTION_CENSOR } from './redaction-paths.js';

/**
 * Canonical logger options (M5.6) — the single pipeline boundary.
 *
 * Consumed by BOTH logger constructions (`src/app/app.ts` for the
 * application pipeline, `src/main.ts` for the startup fallback), so no
 * log line can leave the process unredacted. Redaction is compiled in,
 * never env-tunable, never disableable: there is no flag, no override,
 * no missing-value downgrade.
 *
 * Three layers, in order of strength:
 * 1. Serializers decide what ENTERS the pipeline (allowlisted shapes).
 *    Values that must never be logged are still never logged.
 * 2. `redact` censored paths catch secret fields that reach a logged
 *    object directly (fail-safe net, not the primary control).
 * 3. `base: undefined` keeps pid/hostname out (pre-existing).
 *
 * Every serializer is a total function: optional chaining and typeof
 * guards on every access, no throw paths, safe on undefined/null/
 * primitives and unexpected shapes. Pino itself is circular-safe.
 */

/**
 * Request serializer: method + path + source identity only.
 *
 * - Query string stripped: list endpoints read query parameters (page /
 *   limit / sort / filter), and query values may carry secrets or
 *   attacker-controlled bulk — so `?token=`-style values and filter
 *   payloads can never enter logs through the URL.
 * - Headers excluded entirely: no Authorization/Cookie/user-agent bulk.
 * - `remoteAddress` (socket-derived) retained: source identity is required
 *   for abuse investigation (documented PII keep).
 * - Correlation needs no request object: Fastify binds reqId automatically.
 */
export function serializeRequest(req: unknown): Record<string, unknown> {
  if (typeof req !== 'object' || req === null) {
    return {};
  }
  const source = req as { method?: unknown; url?: unknown; ip?: unknown };
  const out: Record<string, unknown> = {};
  if (typeof source.method === 'string') {
    out.method = source.method;
  }
  if (typeof source.url === 'string') {
    out.url = source.url.split('?')[0];
  }
  if (typeof source.ip === 'string') {
    out.remoteAddress = source.ip;
  }
  return out;
}

/**
 * Response serializer: status code only (Fastify default shape, pinned).
 * Response bodies and headers (incl. Set-Cookie) never enter logs.
 */
export function serializeResponse(res: unknown): Record<string, unknown> {
  if (typeof res !== 'object' || res === null) {
    return {};
  }
  const statusCode = (res as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? { statusCode } : {};
}

/**
 * Error serializer: allowlisted shape only.
 *
 * Pino's default err serializer copies ALL enumerable custom properties,
 * so a future `throw` carrying config/request/body would leak through
 * today's `{err}` call sites (M5.1-F04). This serializer keeps exactly
 * `type`/`message`/`stack` plus `code` when it is a string or number
 * (error codes are safe by construction: SCREAMING_SNAKE or Prisma
 * P-codes) and drops everything else. Non-Error values pass through for
 * Pino to handle.
 */
export function serializeError(err: unknown): unknown {
  if (!(err instanceof Error)) {
    // Primitives are safe to pass through: there is nothing to enumerate.
    if (err === null || typeof err !== 'object') {
      return err;
    }
    // M6.8 — a thrown object need not be an Error. Handing an arbitrary
    // object to Pino also hands it to fast-redact, which walks the value to
    // apply the censored paths — and that walk READS every property. A
    // throwing getter or a `Proxy` trap therefore throws inside the logging
    // call. In the global error handler that throw escapes serialization
    // entirely and Fastify answers with its own native envelope, which
    // carries the raw message: a public leak created by a log statement.
    // Objects are reduced to a fixed marker here so the pipeline stays
    // total. Operators lose nothing real: every application error is an
    // Error and takes the branch below.
    return { type: 'NonError', message: 'non-Error thrown value' };
  }
  const out: Record<string, unknown> = { type: err.name, message: err.message };
  if (typeof err.stack === 'string') {
    out.stack = err.stack;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') {
    out.code = code;
  }
  return out;
}

/**
 * Builds the complete logger options for one Pino pipeline.
 * `level` is an explicit parameter (never read from config here) so the
 * startup fallback in `main.ts` stays usable even when configuration
 * parsing itself has failed. `stream` is optional operational plumbing
 * (log aggregation/file transports, deterministic test capture) — it
 * changes WHERE lines go, never WHAT they contain; serializers and
 * redaction apply identically to every destination.
 */
export function createLoggerOptions(level = 'info', stream?: DestinationStream): LoggerOptions {
  return {
    level,
    base: undefined,
    serializers: {
      req: serializeRequest,
      res: serializeResponse,
      err: serializeError,
    },
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACTION_CENSOR,
    },
    ...(stream === undefined ? {} : { stream }),
  };
}
