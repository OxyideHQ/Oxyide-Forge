import { AppError } from '../errors/app-error.js';
import { ErrorCodes } from '../errors/error-codes.js';

/**
 * Canonical pagination primitive (M7.3): page/limit offset pagination.
 *
 * Cross-cutting parsing/normalization shared by all future list
 * endpoints — hence `src/shared`, alongside errors/logging. Imports only
 * `shared/errors` (ENF-005: never business modules, never persistence,
 * never HTTP). No dependency, no framework, no database access.
 *
 * Boundary (enforced):
 *
 *   HTTP query (strings)
 *     ↓  AJV lexical gate (`paginationQuerySchema`: integer or
 *        digit-string per field; arrays/objects/booleans/blanks rejected)
 *   `parsePagination` (semantic gate: ranges + safe-integer arithmetic;
 *     throws AppError 400 on violation — frozen M6 path, no new code)
 *     ↓  `{ page, limit, offset }` — always concrete, never raw strings
 *   service → repository (typed) → Prisma `skip: offset, take: limit`
 *
 * Cursor pagination is deliberately NOT provided: V1 exposes page/limit
 * only. Client-controlled sorting is M7.4 — paginated queries MUST use
 * server-defined ordering (documented requirement, not code).
 */

/** First page. Pages are 1-based; there is no page 0. */
export const DEFAULT_PAGE = 1;

/** Minimum page and limit. Zero, negatives, and fractions are rejected. */
export const MIN_PAGE = 1;
export const MIN_LIMIT = 1;

/** Default page size when `limit` is omitted. */
export const DEFAULT_LIMIT = 20;

/**
 * Maximum page size (M7.3 §15). Centralized: routes must not define
 * their own ceiling. A client can never push more than this into Prisma.
 */
export const MAX_LIMIT = 100;

/** Lexical shape of one pagination field: integer or digit-string. */
const paginationFieldSchema = {
  anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^[0-9]+$' }],
} as const;

/**
 * Reusable query properties for composition into route query schemas,
 * e.g. `querystring: { type: 'object', properties: {
 * ...paginationQueryProperties, sort: ... } }` (M7.4 owns `sort`).
 */
export const paginationQueryProperties = {
  page: paginationFieldSchema,
  limit: paginationFieldSchema,
} as const;

/**
 * Standalone query schema for routes accepting only pagination.
 * Unknown fields are rejected — they must never silently become behavior.
 */
export const paginationQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: paginationQueryProperties,
} as const;

/**
 * Normalized pagination: the only form services and repositories accept.
 * `offset` is precomputed so repositories never do query arithmetic.
 */
export type NormalizedPagination = {
  page: number;
  limit: number;
  offset: number;
};

function invalidPagination(detail: string): AppError {
  // Static details only: the offending value is never reflected, so
  // attacker input cannot round-trip into a public `detail`.
  return new AppError(ErrorCodes.VALIDATION_FAILED, 400, detail, { title: 'Bad Request' });
}

function parseField(value: unknown, name: 'page' | 'limit'): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw invalidPagination(`Invalid pagination: ${name} must be an integer.`);
    }
    return value;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw invalidPagination(`Invalid pagination: ${name} is out of range.`);
    }
    return parsed;
  }
  throw invalidPagination(`Invalid pagination: ${name} must be an integer.`);
}

/**
 * Validates raw query input into normalized pagination (M7.3 §8).
 *
 * Accepts the parsed query object (values are strings off the wire, or
 * numbers where the caller already converted). Missing fields become
 * defaults; anything else violating the contract throws a 400 AppError.
 * Repositories must never receive `req.query` or raw strings — only the
 * result of this function.
 */
export function parsePagination(query: unknown): NormalizedPagination {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw invalidPagination('Invalid pagination: query must be an object.');
  }
  const record = query as { page?: unknown; limit?: unknown };

  const page = parseField(record.page, 'page') ?? DEFAULT_PAGE;
  if (page < MIN_PAGE) {
    throw invalidPagination(`Invalid pagination: page must be at least ${MIN_PAGE}.`);
  }

  const limit = parseField(record.limit, 'limit') ?? DEFAULT_LIMIT;
  if (limit < MIN_LIMIT || limit > MAX_LIMIT) {
    throw invalidPagination(
      `Invalid pagination: limit must be between ${MIN_LIMIT} and ${MAX_LIMIT}.`,
    );
  }

  // Overflow guard (M7.3 §9/§14): any page is acceptable only while its
  // offset stays exactly representable. Huge pages fail closed here
  // instead of reaching Prisma as Infinity or a rounded integer.
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw invalidPagination('Invalid pagination: page is out of range.');
  }

  return { page, limit, offset };
}

/**
 * Standard pagination metadata for collection responses (M7.3 §10).
 * `totalPages` is 0 when `total` is 0 — pure arithmetic, no special case.
 */
export type PaginationMetadata = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

/**
 * Canonical paginated collection envelope (M7.3 §10).
 * Distinct from §8's future cursor `pageInfo`: this is the implemented
 * offset contract. `T` is the route's public item DTO — never a Prisma
 * model (M7.2 boundary carries over).
 */
export type PaginatedResponse<T> = {
  items: T[];
  pagination: PaginationMetadata;
};

/**
 * JSON Schema for the `pagination` metadata object (M7.2 principles:
 * explicit fields, no passthrough). Item schemas compose at the route:
 * `{ ...paginatedEnvelopeShape(itemSchema) }` is intentionally NOT
 * provided as a factory — each route declares its envelope explicitly so
 * OpenAPI generation (M7.6) sees a static schema per endpoint.
 */
export const PAGINATION_METADATA_JSON_SCHEMA = {
  type: 'object',
  required: ['page', 'limit', 'total', 'totalPages'],
  additionalProperties: false,
  properties: {
    page: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1 },
    total: { type: 'integer', minimum: 0 },
    totalPages: { type: 'integer', minimum: 0 },
  },
} as const;

/**
 * Builds a paginated envelope from a page of public DTOs and the total
 * count (M7.3 §10). `total` comes from the repository count query —
 * trusted internal input, but still guarded: a negative or non-integer
 * total is a programming bug and fails loud rather than publishing a
 * nonsense contract.
 */
export function buildPaginatedResponse<T>(
  items: T[],
  params: { page: number; limit: number; total: number },
): PaginatedResponse<T> {
  if (!Number.isInteger(params.total) || params.total < 0) {
    throw new Error('buildPaginatedResponse: total must be a non-negative integer.');
  }
  const totalPages = params.total === 0 ? 0 : Math.ceil(params.total / params.limit);
  return {
    items,
    pagination: { page: params.page, limit: params.limit, total: params.total, totalPages },
  };
}
