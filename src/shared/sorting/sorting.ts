import { AppError } from '../errors/app-error.js';
import { ErrorCodes } from '../errors/error-codes.js';

/**
 * Canonical sorting primitive (M7.4): allowlisted `?sort` query sorting.
 *
 * Cross-cutting parsing/normalization for future list endpoints — hence
 * `src/shared`, alongside pagination. Imports only `shared/errors`
 * (ENF-005: never business modules, persistence, or HTTP). No Prisma
 * import: the primitive describes sorting *intent*; repositories own the
 * translation to persistence syntax. No dependency, no framework.
 *
 * Canonical contract (`docs/api-conventions.md` §10):
 * `?sort=<field>[:<direction>][,...]` — 1–3 entries, direction `asc`
 * (default per entry) or `desc`, lowercase only. Unknown fields,
 * malformed entries, and duplicates are rejected with 400.
 *
 * Boundary (enforced):
 *
 *   HTTP query (strings)
 *     ↓  AJV lexical gate (`sortQuerySchema`: string scalar, unknown
 *        keys and arrays rejected)
 *   `parseSort` (semantic gate: entry shape, allowlist membership,
 *     direction validity; throws AppError 400 — frozen M6 path)
 *     ↓  `NormalizedSort` — external names resolved to server-mapped
 *        columns; tie-breaker appended (deduped)
 *   service → repository (typed) → Prisma `orderBy` (repository-owned
 *     2-line translation; pattern documented, no consumer yet)
 *
 * What NEVER happens: client strings reaching `orderBy`. The server owns
 * the external→column mapping; `Map` storage makes even `__proto__`
 * lookups structurally impossible.
 */

/** Sort directions. Lowercase only — `ASC`, `1`, `ascending` are rejected. */
export type SortDirection = 'asc' | 'desc';

/** Maximum client sort entries per request (api-conventions §10.2). */
export const MAX_SORT_FIELDS = 3;

/** Bound for the raw `sort` string: identifier-list shaped input only. */
export const MAX_SORT_LENGTH = 128;

/**
 * External-name → internal-column mapping, defined per endpoint.
 * External and internal names are intentionally separate vocabularies:
 * renaming a column must never be observable as a client contract change
 * unless the endpoint owner also renames the external name.
 */
export type SortFieldMap = Readonly<Record<string, string>>;

/** Server-owned deterministic tie-breaker (never client-controlled). */
export type SortTieBreaker = {
  readonly column: string;
  readonly direction: SortDirection;
};

/** One validated sort criterion, in client-requested order. */
export type SortCriterion = {
  /** External field name as requested (allowlisted). */
  readonly field: string;
  readonly direction: SortDirection;
  /** Server-mapped column for this field. */
  readonly column: string;
};

/**
 * Normalized sorting: the only form services and repositories accept.
 * `sorts` preserves client order (1–3 entries); `tieBreaker` guarantees
 * deterministic page boundaries. Contains no Prisma syntax by design.
 */
export type NormalizedSort = {
  readonly sorts: ReadonlyArray<SortCriterion>;
  readonly tieBreaker: SortTieBreaker;
};

/**
 * Endpoint-owned sort configuration, built once per sortable listing.
 * `defaultField`/`defaultDirection` define the stable default used when
 * the client sends no `sort` (api-conventions §10.2); `tieBreaker` is
 * mandatory so no endpoint can paginate nondeterministically by omission.
 */
export type SortConfig = {
  readonly fields: ReadonlyMap<string, string>;
  readonly defaultField: string;
  readonly defaultDirection: SortDirection;
  readonly tieBreaker: SortTieBreaker;
};

/**
 * Defines an endpoint's sortable contract. Fails fast on programmer
 * error (empty map, unknown default, empty column) — these are
 * definition-time bugs, never client input, so they throw plain Errors.
 */
export function defineSortConfig(input: {
  readonly fields: SortFieldMap;
  readonly defaultField: string;
  readonly defaultDirection: SortDirection;
  readonly tieBreaker: SortTieBreaker;
}): SortConfig {
  const entries = Object.entries(input.fields);
  if (entries.length === 0) {
    throw new Error('defineSortConfig: fields must allowlist at least one sortable field.');
  }
  for (const [name, column] of entries) {
    if (name.length === 0 || column.length === 0) {
      throw new Error('defineSortConfig: field names and columns must be non-empty.');
    }
  }
  if (!Object.hasOwn(input.fields, input.defaultField)) {
    throw new Error('defineSortConfig: defaultField must be an allowlisted field.');
  }
  if (input.defaultDirection !== 'asc' && input.defaultDirection !== 'desc') {
    throw new Error('defineSortConfig: defaultDirection must be "asc" or "desc".');
  }
  if (input.tieBreaker.column.length === 0) {
    throw new Error('defineSortConfig: tieBreaker.column must be non-empty.');
  }
  if (input.tieBreaker.direction !== 'asc' && input.tieBreaker.direction !== 'desc') {
    throw new Error('defineSortConfig: tieBreaker.direction must be "asc" or "desc".');
  }
  return {
    fields: new Map(entries),
    defaultField: input.defaultField,
    defaultDirection: input.defaultDirection,
    tieBreaker: { column: input.tieBreaker.column, direction: input.tieBreaker.direction },
  };
}

/**
 * Reusable query properties for composition into route query schemas,
 * e.g. `querystring: { type: 'object', properties: {
 * ...paginationQueryProperties, ...sortQueryProperties } }`.
 * Future `direction`-style params must not be added beside `sort`:
 * one canonical contract (§10), not competing syntaxes.
 */
export const sortQueryProperties = {
  sort: { type: 'string', minLength: 1, maxLength: MAX_SORT_LENGTH },
} as const;

/**
 * Standalone query schema for routes accepting only sorting.
 * Unknown fields are rejected — they must never silently become behavior.
 */
export const sortQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: sortQueryProperties,
} as const;

function invalidSort(detail: string): AppError {
  // Static details only: the offending value is never reflected, so
  // attacker input cannot round-trip into a public `detail`.
  return new AppError(ErrorCodes.VALIDATION_FAILED, 400, detail, { title: 'Bad Request' });
}

function parseEntry(entry: string, fields: ReadonlyMap<string, string>): SortCriterion {
  // Exactly `field` or `field:direction`. A trailing colon with an empty
  // direction (`email:`) is malformed — omission means no colon at all.
  const parts = entry.split(':');
  if (parts.length > 2 || parts[0].length === 0 || (parts.length === 2 && parts[1].length === 0)) {
    throw invalidSort('Invalid sorting: entries must be "field" or "field:direction".');
  }
  const column = fields.get(parts[0]);
  if (column === undefined) {
    throw invalidSort('Invalid sorting: unsupported sort field.');
  }
  let direction: SortDirection = 'asc';
  if (parts.length === 2) {
    if (parts[1] !== 'asc' && parts[1] !== 'desc') {
      throw invalidSort('Invalid sorting: direction must be "asc" or "desc".');
    }
    direction = parts[1];
  }
  return { field: parts[0], direction, column };
}

/**
 * Validates raw query input into normalized sorting (M7.4 §5–§8).
 *
 * Accepts the parsed query object. `sort` absent → the endpoint's stable
 * default; present → 1–3 comma-separated entries in client order.
 * Violations throw a 400 AppError. Repositories must never receive
 * `req.query` or raw strings — only the result of this function, translated
 * to persistence syntax at the repository boundary.
 */
export function parseSort(query: unknown, config: SortConfig): NormalizedSort {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw invalidSort('Invalid sorting: query must be an object.');
  }
  const record = query as { sort?: unknown };
  if (record.sort === undefined) {
    const column = config.fields.get(config.defaultField) as string;
    return {
      sorts: [{ field: config.defaultField, direction: config.defaultDirection, column }],
      tieBreaker: config.tieBreaker,
    };
  }
  if (typeof record.sort !== 'string') {
    throw invalidSort('Invalid sorting: sort must be a string.');
  }
  const entries = record.sort.split(',');
  if (entries.length > MAX_SORT_FIELDS) {
    throw invalidSort(`Invalid sorting: at most ${MAX_SORT_FIELDS} sort fields per request.`);
  }
  const sorts = entries.map((entry) => parseEntry(entry, config.fields));
  const seen = new Set(sorts.map((criterion) => criterion.field));
  if (seen.size !== sorts.length) {
    throw invalidSort('Invalid sorting: duplicate sort fields.');
  }
  return { sorts, tieBreaker: config.tieBreaker };
}

/**
 * Final ordered entries for persistence translation: client sorts in
 * requested order, then the tie-breaker — unless a client sort already
 * orders by the tie-breaker column, in which case appending it would
 * publish a dead second entry (deduped here, documented, tested).
 *
 * Returns plain `{column, direction}` pairs, NOT Prisma syntax: the
 * repository owns the final translation, e.g.
 * `orderBy: sortOrderEntries(sort).map((entry) => ({ [entry.column]:
 * entry.direction }))` — computed keys over allowlisted columns only.
 */
export function sortOrderEntries(
  sort: NormalizedSort,
): Array<{ column: string; direction: SortDirection }> {
  const entries = sort.sorts.map((criterion) => ({
    column: criterion.column,
    direction: criterion.direction,
  }));
  if (!entries.some((entry) => entry.column === sort.tieBreaker.column)) {
    entries.push({ column: sort.tieBreaker.column, direction: sort.tieBreaker.direction });
  }
  return entries;
}
