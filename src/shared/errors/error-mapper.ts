import type { FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';

import { AppError } from './app-error.js';
import { ErrorCodes } from './error-codes.js';

/**
 * Centralized internal error mapping boundary (M6.2; extended M6.4).
 *
 * SOLE responsibility: classify any thrown internal failure into a
 * canonical `MappedError` the global handler can serve WITHOUT further
 * interpretation. All public error bodies originate from the single
 * `sendMappedError` builder below — routes, guards, and plugins throw;
 * they never construct envelopes.
 *
 * Classification (behavior-preserving by contract):
 * - AppError → `app`: code/status/title/detail carried over; `type` URL
 *   built once here; `WWW-Authenticate` attached for the two auth 401
 *   codes (centralizes 3 previously-triplicated header sites);
 *   `expected` iff status < 500 (drives handler logging).
 * - Prisma known errors (M6.4, `instanceof` + code allowlist — never
 *   message/SQL/stack parsing): P2002 → 409 generic conflict (the
 *   register-email path already converges via AppError and is untouched);
 *   P2024 pool/timeout → sanitized 500 (no Retry-After policy exists;
 *   M6.5 owns 503 policy); escaped P2025 → 404 generic absence (coherent
 *   with repository null/false → service 404s). Unknown Prisma classes
 *   and hostile `meta` never cross (unit-proven).
 * - Fastify errors (M6.4, matched by stable `code` — never message
 *   strings): validation/malformed/empty-JSON/body-limit/media-type map
 *   to problem bodies with preserved statuses; any other sub-500
 *   status-carrying error → generic `BAD_REQUEST` problem (status
 *   preserved) so no native envelope survives on supported paths.
 *   Pre-pipeline router errors (FST_ERR_BAD_URL/FST_ERR_MAX_PARAM_LENGTH)
 *   never reach this mapper (proven bypass — documented boundary, not
 *   attempted).
 * - Anything else → `internal`: fixed sanitized 5xx, never expected.
 *   Causes, stacks, and arbitrary properties are NEVER copied — exclusion
 *   by construction (nothing today produces causes; if that changes, this
 *   module is where cause policy will live).
 *
 * Hard boundary (M6.8): `mapError` is TOTAL. Thrown values are untrusted —
 * they may carry throwing getters, `Proxy` traps, circular structure, or
 * prototype pollution, any of which would otherwise escape as an
 * uncontrolled native Fastify envelope carrying the raw message. Two
 * properties make the boundary hold:
 *   1. AppError public fields are validated before they become a public
 *      body: only a registered `ErrorCodes` value, a real HTTP error
 *      status, and non-empty string `title`/`detail` are accepted.
 *      Anything else fails closed to `SANITIZED_INTERNAL_ERROR`.
 *   2. Classification itself cannot throw: `instanceof`, property reads,
 *      and derived-string construction run inside a guard that fails
 *      closed to the same sanitized internal model.
 * Consequence: the only path from a thrown value to the wire is
 * `sendMappedError`, and every value on it is server-controlled.
 *
 * HTTP separation: this module never sends by itself except through
 * `sendMappedError(reply, mapped, instance)`, called ONLY by the global
 * handler. It imports Fastify reply/error TYPES only — zero runtime
 * coupling (the Prisma runtime import serves `instanceof` identity only).
 */

export const WWW_AUTHENTICATE = 'Bearer realm="oxyide", error="invalid_token"';

/**
 * Stable public 403 detail (M6.8).
 *
 * Centralized here for the same reason as the 401 representation below:
 * authorization denial must be a server-authored constant, never a
 * service-supplied explanation string. Denial reasons legitimately name
 * the caller's role, the required permission, the required role, and
 * whether the subject row exists — all of which are internal
 * authorization vocabulary and account-enumeration oracles.
 *
 * The precise reason is still available to operators: the guards emit it
 * through the M4.7 security event (`reason`, `permission`, `role`,
 * `subjectId`) on the server side. Only the public representation is
 * generic. Authorization semantics are unchanged.
 */
export const AUTH_FORBIDDEN_DETAIL = 'You do not have permission to perform this action.';

/**
 * Auth 401 representation, centralized (M6.2): previously built inline in
 * the auth plugin, require-auth, and require-permission guards.
 */
const AUTH_401_HEADERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [ErrorCodes.AUTH_INVALID_TOKEN]: { 'WWW-Authenticate': WWW_AUTHENTICATE },
  [ErrorCodes.AUTH_TOKEN_EXPIRED]: { 'WWW-Authenticate': WWW_AUTHENTICATE },
};

export const INTERNAL_ERROR_BODY = {
  type: 'https://docs.oxyide.com/errors/internal-error',
  title: 'Internal Server Error',
  status: 500,
  detail: 'An unexpected error occurred. Please try again later.',
  code: 'INTERNAL_ERROR',
} as const;

/**
 * The single fail-closed model for any internal failure (M6.8).
 *
 * Exported so the global handler's backstop cannot re-declare the shape:
 * one owner, one literal. Always `expected: false`, so every path that
 * produces it still emits exactly one authoritative error log line.
 */
export const SANITIZED_INTERNAL_ERROR: MappedError = {
  kind: 'internal',
  statusCode: 500,
  expected: false,
};

/**
 * Public status integrity (M6.8).
 *
 * An error response must carry an HTTP error status. A non-integer, 1xx,
 * 2xx, 3xx, or ≥600 value is a programming fault: it would either make
 * `reply.status()` throw (Fastify then serializes the raw message in a
 * native envelope) or hand a success/redirect status an error body. Both
 * fail closed to `SANITIZED_INTERNAL_ERROR`.
 */
function isPublicErrorStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599;
}

/**
 * Public text integrity (M6.8): `title` and `detail` are strings or they
 * are not public text. A non-string (or empty) value means the thrower
 * bypassed the typed constructor, so the whole AppError is untrustworthy
 * as a public representation and fails closed.
 */
function isPublicText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Public code integrity (M6.8): only a code declared in the `ErrorCodes`
 * registry becomes a public `code` — and therefore a public `type` URI.
 * Registry values are server-controlled literals, so `type` can never be
 * built from request data, a traversal sequence, or a foreign namespace.
 */
function isRegisteredErrorCode(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(ErrorCodes, value);
}

/** Canonical public content type for API errors (M6.3, RFC 7807). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * Canonical public error body (M6.3).
 *
 * Exactly these six fields — no more, no less (exact-shape tested):
 * RFC 7807 `type`/`title`/`status`/`detail`/`instance` plus the Oxyide
 * `code` extension. `instance` correlates with server logs via the
 * Fastify request ID (`/requests/<id>`, opaque counter — no PII);
 * there is intentionally NO separate `requestId` field (M6.6 owns
 * request-ID propagation; one correlation mechanism, not two).
 */
export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  instance: string;
};

const NOT_FOUND_BODY = {
  type: 'https://docs.oxyide.com/errors/not-found',
  title: 'Not Found',
  status: 404,
  detail: 'Route not found',
  code: 'NOT_FOUND',
} as const;

export type MappedError =
  | {
      kind: 'app';
      statusCode: number;
      code: string;
      type: string;
      title: string;
      detail: string;
      headers: Record<string, string>;
      expected: boolean;
    }
  | {
      kind: 'internal';
      statusCode: 500;
      expected: false;
    };

function problemType(code: string): string {
  return `https://docs.oxyide.com/errors/${code.toLowerCase().replace(/_/g, '-')}`;
}

/**
 * Reads a usable public error status off an arbitrary thrown value
 * (M6.8). Returns `undefined` unless the value carries a genuine HTTP
 * error status, so a hostile `statusCode`/`status` (99, 302, 99999, NaN,
 * a string, a non-integer) can never reach `reply.status()`.
 */
function resolveStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const record = error as { statusCode?: unknown; status?: unknown };
  if (isPublicErrorStatus(record.statusCode)) {
    return record.statusCode;
  }
  return isPublicErrorStatus(record.status) ? record.status : undefined;
}

function appProblem(
  statusCode: number,
  code: string,
  title: string,
  detail: string,
  headers: Record<string, string> = {},
): MappedError {
  return {
    kind: 'app',
    statusCode,
    code,
    type: problemType(code),
    title,
    detail,
    headers,
    expected: statusCode < 500,
  };
}

/**
 * Prisma known-error classification (M6.4).
 *
 * Identity is `instanceof` + code allowlist only. `meta`, messages, SQL,
 * and stacks are never read. Returns `null` when the error is not a
 * recognized Prisma known-request error (caller falls through).
 */
function mapPrismaError(error: unknown): MappedError | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return null;
  }

  if (error.code === 'P2002') {
    // Unique-constraint violation escaping to the boundary (the register
    // email path already converges via AppError and is untouched): generic
    // conflict with no model/table/constraint/value disclosure.
    return appProblem(
      409,
      ErrorCodes.CONFLICT,
      'Conflict',
      'A resource with the same unique value already exists.',
    );
  }

  if (error.code === 'P2024') {
    // Pool/timeout infrastructure failure → sanitized 500. Deliberately
    // NOT 503: no Retry-After policy exists and M6.5 owns 503 policy.
    // Operators distinguish via server logs (full error persists there).
    return SANITIZED_INTERNAL_ERROR;
  }

  if (error.code === 'P2025') {
    // Record-required-but-absent escaping the repository null/false idiom:
    // coherent with service-level 404s (same code/shape family).
    return appProblem(
      404,
      'NOT_FOUND',
      'Not Found',
      'The requested resource was not found.',
    );
  }

  return null;
}

/**
 * Fastify error classification (M6.4).
 *
 * Matched by stable `code` only — never by message strings. Only
 * explicitly approved static details reach the public body; the
 * validation class preserves the framework message, which is proven
 * value-free (deterministic AJV templates over the closed schema
 * vocabulary — hostile values never reflected, adversarially tested).
 * Pre-pipeline router errors never arrive here (proven bypass).
 */
function mapFastifyError(error: unknown): MappedError | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const record = error as { code?: unknown };
  if (typeof record.code !== 'string') {
    return null;
  }

  switch (record.code) {
    case 'FST_ERR_VALIDATION': {
      const message =
        error instanceof Error && typeof error.message === 'string' && error.message.length > 0
          ? error.message
          : 'The request failed validation.';
      return appProblem(400, ErrorCodes.VALIDATION_FAILED, 'Bad Request', message);
    }
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return appProblem(400, ErrorCodes.MALFORMED_JSON, 'Bad Request', 'The request body is not valid JSON.');
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return appProblem(413, ErrorCodes.BODY_TOO_LARGE, 'Payload Too Large', 'The request body is too large.');
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return appProblem(
        415,
        ErrorCodes.UNSUPPORTED_MEDIA_TYPE,
        'Unsupported Media Type',
        'Unsupported Media Type. Use application/json.',
      );
    default:
      return null;
  }
}

/**
 * The single authoritative classification (M6.8 totality enforced by
 * `mapError` below). Every branch returns a value whose fields are either
 * registry literals, validated primitives, or static text.
 */
function classifyError(error: unknown): MappedError {
  if (error instanceof AppError) {
    // Public-field gate: an AppError is only a trustworthy public
    // representation when its code, status, title, and detail all pass
    // validation. A thrower that bypassed the typed constructor (JS caller,
    // mutated field, subclass) fails closed instead of publishing
    // unvalidated values.
    if (
      !isRegisteredErrorCode(error.code) ||
      !isPublicErrorStatus(error.statusCode) ||
      !isPublicText(error.title) ||
      !isPublicText(error.detail)
    ) {
      return SANITIZED_INTERNAL_ERROR;
    }
    return {
      kind: 'app',
      statusCode: error.statusCode,
      code: error.code,
      type: problemType(error.code),
      title: error.title,
      detail: error.detail,
      headers: { ...(AUTH_401_HEADERS[error.code] ?? {}) },
      expected: error.statusCode < 500,
    };
  }

  const prismaMapped = mapPrismaError(error);
  if (prismaMapped !== null) {
    return prismaMapped;
  }

  const fastifyMapped = mapFastifyError(error);
  if (fastifyMapped !== null) {
    return fastifyMapped;
  }

  if (typeof error === 'object' && error !== null) {
    // Closed-world fallback: any other status-carrying error keeps a valid
    // error status with a generic problem body (no native envelope survives
    // on supported paths); anything else is sanitized internal.
    const statusCode = resolveStatusCode(error);
    if (statusCode !== undefined && statusCode < 500) {
      return appProblem(statusCode, ErrorCodes.BAD_REQUEST, 'Bad Request', 'The request could not be processed.');
    }
  }

  return SANITIZED_INTERNAL_ERROR;
}

/**
 * The public boundary entry point (M6.8): TOTAL by construction.
 *
 * A thrown value may be anything — including objects whose property reads
 * or `instanceof` checks throw (throwing getters, `Proxy` traps). If
 * classification escaped such a value, Fastify would serialize the raw
 * failure itself, emitting a native `application/json` envelope that
 * carries the internal message — exactly the leak this boundary exists to
 * prevent. Failing closed here keeps every response on the single
 * sanitized Problem Details path.
 */
export function mapError(error: unknown): MappedError {
  try {
    return classifyError(error);
  } catch {
    return SANITIZED_INTERNAL_ERROR;
  }
}

/**
 * Builds an occurrence identifier from a Fastify request ID (M6.3).
 * Pure reuse of the existing ID (no generation, no new trust semantics):
 * opaque counter IDs carry no PII. Falls back to `/requests/unknown`
 * defensively; Fastify always sets a string ID in practice.
 */
export function buildInstance(requestId: unknown): string {
  if (typeof requestId === 'string' && requestId.length > 0) {
    return `/requests/${requestId}`;
  }
  return '/requests/unknown';
}

/**
 * Builds the canonical six-field body (M6.3). Field-by-field
 * construction — never a spread — so unapproved fields cannot slip in.
 */
export function buildProblemBody(
  body: { type: string; title: string; status: number; detail: string; code: string },
  instance: string,
): ProblemBody {
  return {
    type: body.type,
    title: body.title,
    status: body.status,
    detail: body.detail,
    code: body.code,
    instance,
  };
}

/**
 * The single public-error-body construction site (M6.2).
 * Called ONLY by the global error handler. Produces the CURRENT public
 * contract byte-for-byte (M6.3 owns any envelope redesign).
 */
export function sendMappedError(reply: FastifyReply, mapped: MappedError, instance: string): void {
  // `type`/`title`/`detail`/`code` are emitted as a single JSON string, so
  // hostile characters (newlines, quotes, control bytes, unicode) stay
  // inside the field and cannot break out of the document or forge a
  // second field. Nothing here spreads, clones, or stringifies the thrown
  // value.
  if (mapped.kind === 'app') {
    for (const [name, value] of Object.entries(mapped.headers)) {
      reply.header(name, value);
    }
    reply.header('Content-Type', PROBLEM_CONTENT_TYPE);
    reply.status(mapped.statusCode).send(
      buildProblemBody(
        {
          type: mapped.type,
          title: mapped.title,
          status: mapped.statusCode,
          detail: mapped.detail,
          code: mapped.code,
        },
        instance,
      ),
    );
    return;
  }

  if (mapped.kind === 'internal') {
    reply.header('Content-Type', PROBLEM_CONTENT_TYPE);
    reply.status(500).send(buildProblemBody({ ...INTERNAL_ERROR_BODY }, instance));
  }
}

/**
 * Canonical 404 body for unknown routes (M6.3).
 * Same six-field contract, same content type. The `NOT_FOUND` code lives
 * here as a literal (not in ErrorCodes): no domain code is thrown for
 * routing misses, mirroring the INTERNAL_ERROR precedent.
 */
export function sendNotFoundProblem(reply: FastifyReply, instance: string): void {
  reply.header('Content-Type', PROBLEM_CONTENT_TYPE);
  reply.status(404).send(buildProblemBody({ ...NOT_FOUND_BODY }, instance));
}

export const errorMapper = {
  mapError,
  sendMappedError,
  sendNotFoundProblem,
  buildProblemBody,
  buildInstance,
  WWW_AUTHENTICATE,
  INTERNAL_ERROR_BODY,
  SANITIZED_INTERNAL_ERROR,
  PROBLEM_CONTENT_TYPE,
};
