import { AppError } from '../errors/app-error.js';
import { ErrorCodes } from '../errors/error-codes.js';

/**
 * Canonical filtering primitive (M7.5): allowlisted `filter[field_op]`
 * query filtering.
 *
 * Cross-cutting parsing/normalization for future list endpoints — hence
 * `src/shared`, alongside pagination/sorting. Imports only
 * `shared/errors` (ENF-005: never business modules, persistence, or
 * HTTP). No Prisma import: the primitive returns filter *intent*;
 * repositories own the translation to `where` clauses. No dependency,
 * no framework, no database access.
 *
 * Canonical contract (`docs/api-conventions.md` §9):
 * `filter[status]=active`, `filter[status_ne]=suspended`,
 * `filter[status_in]=active,suspended`, `filter[createdAt_gte]=<ISO>`.
 * Supported operators are deliberately few (see `ALLOWED_OPERATORS`);
 * relations, boolean combinators, regex, JSON paths, and raw SQL do not
 * exist in this contract and are rejected as unknown fields/operators.
 *
 * Transport note: Fastify's default query parser does NOT nest brackets —
 * `filter[status]=active` arrives as the literal key `"filter[status]"`.
 * The normalizer expands these keys itself (rather than a global custom
 * query parser or a new dependency), so framework behavior for every
 * other parameter is byte-identical. AJV gates the key shape;
 * `parseFilter` performs suffix/allowlist/type validation.
 *
 * Boundary (enforced):
 *
 *   HTTP query (strings; bracket keys arrive literally)
 *     ↓  AJV lexical gate (`filterQuerySchema`: `filter[...]`-shaped keys
 *        with string/string-array values; unknown top-level keys rejected
 *        per composed route; duplicates surface as arrays, not silence)
 *   `parseFilter` (semantic gate: key expansion, suffix parse, field
 *     allowlist, operator/type matrix, value validation, complexity
 *     caps; throws AppError 400 — frozen M6 path, no new code)
 *     ↓  `NormalizedFilter` — criteria with server-mapped columns and
 *        typed values; AND semantics throughout
 *   service → repository (typed) → Prisma `where` (repository-owned
 *     translation; pattern documented, no consumer yet)
 *
 * What NEVER happens: client strings reaching `where`. The server owns
 * the external→column mapping and the operator vocabulary; `Map`
 * storage makes even `__proto__` lookups structurally impossible.
 */

/** Supported operators. Small by design — see D2 in the M7.5 spec. */
export type FilterOperator = 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';

/** Value types a filterable field may declare. */
export type FilterFieldType = 'string' | 'enum' | 'integer' | 'datetime';

/**
 * Maximum expanded criteria per request (M7.5 §12). Bounds CPU, query
 * planning, and request amplification: each criterion is one predicate,
 * so ten predicates is ample for V1 domains while staying plannable.
 */
export const MAX_FILTER_CRITERIA = 10;

/**
 * Maximum values inside one `in`-list (M7.5 §11/§12). Bounds list
 * cardinality: twenty exact-match alternatives cover legitimate
 * multi-select use without unbounded `IN (...)` expansion.
 */
export const MAX_IN_VALUES = 20;

/**
 * Maximum length of one scalar filter value (M7.5 §12/§15). Bounds
 * `contains` LIKE patterns and general payload: 256 characters exceeds
 * any legitimate identifier/timestamp while keeping substring scans
 * cheap. Longer values are rejected, never truncated.
 */
export const MAX_FILTER_VALUE_LENGTH = 256;

/**
 * Maximum length of one filter key (`field` or `field_op`, M7.5 §12).
 * Field vocabularies are short identifiers; longer keys cannot be
 * allowlisted members and are rejected before map lookup.
 */
export const MAX_FILTER_KEY_LENGTH = 64;

/** Fixed operator matrix per field type (M7.5 D2). */
const TYPE_OPERATORS: Readonly<Record<FilterFieldType, ReadonlyArray<FilterOperator>>> = {
  string: ['eq', 'ne', 'in', 'contains'],
  enum: ['eq', 'ne', 'in'],
  integer: ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte'],
  datetime: ['gt', 'gte', 'lt', 'lte'],
};

/** Operator suffixes, longest first so `_gte` wins over a shorter match. */
const OPERATOR_SUFFIXES: ReadonlyArray<{ suffix: string; operator: FilterOperator }> = [
  { suffix: '_contains', operator: 'contains' },
  { suffix: '_gte', operator: 'gte' },
  { suffix: '_lte', operator: 'lte' },
  { suffix: '_ne', operator: 'ne' },
  { suffix: '_in', operator: 'in' },
  { suffix: '_gt', operator: 'gt' },
  { suffix: '_lt', operator: 'lt' },
];

/**
 * Endpoint-owned field definition. `column` is the internal/database
 * field the external name maps to; `values` is required exactly when
 * `type` is `enum`. Sensitive fields simply never appear here.
 */
export type FilterFieldDef = {
  readonly type: FilterFieldType;
  readonly column: string;
  readonly values?: ReadonlyArray<string>;
};

export type FilterFieldMap = Readonly<Record<string, FilterFieldDef>>;

/** One validated criterion. ANDed with its siblings, in client order. */
export type FilterCriterion = {
  /** External field name as requested (allowlisted). */
  readonly field: string;
  readonly operator: FilterOperator;
  /** Server-mapped column for this field. */
  readonly column: string;
  /** Typed value: number for integers, validated string otherwise. Array iff `in`. */
  readonly value: string | number | ReadonlyArray<string | number>;
};

/** Normalized filtering: the only form services/repositories accept. */
export type NormalizedFilter = {
  /** AND semantics throughout; empty means no filtering. */
  readonly criteria: ReadonlyArray<FilterCriterion>;
};

/** Endpoint-owned filter configuration, built once per filterable listing. */
export type FilterConfig = {
  readonly fields: ReadonlyMap<string, FilterFieldDef>;
};

/**
 * Defines an endpoint's filterable contract. Fails fast on programmer
 * error (empty map, empty/ill-shaped columns, enum without members,
 * stray `values` on non-enums) — definition-time bugs, never client
 * input, so they throw plain Errors.
 */
export function defineFilterConfig(input: {
  readonly fields: FilterFieldMap;
}): FilterConfig {
  const entries = Object.entries(input.fields);
  if (entries.length === 0) {
    throw new Error('defineFilterConfig: fields must allowlist at least one filterable field.');
  }
  const columnPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const [name, def] of entries) {
    if (name.length === 0 || name.length > MAX_FILTER_KEY_LENGTH) {
      throw new Error('defineFilterConfig: field names must be non-empty identifiers.');
    }
    if (!columnPattern.test(def.column)) {
      throw new Error(`defineFilterConfig: column for "${name}" must be a plain identifier.`);
    }
    if (def.type === 'enum') {
      if (!def.values || def.values.length === 0) {
        throw new Error(`defineFilterConfig: enum field "${name}" requires a non-empty values list.`);
      }
    } else if (def.values !== undefined) {
      throw new Error(`defineFilterConfig: only enum fields declare values (field "${name}").`);
    }
  }
  return { fields: new Map(entries) };
}

/**
 * Pattern fragment for composition into route query schemas, e.g.
 * `querystring: { type: 'object', additionalProperties: false,
 * patternProperties: { ...filterPatternProperties } }` merged with any
 * sibling fragments. Pagination/sorting compose by plain property
 * spread; filtering composes by pattern spread — one fragment per
 * primitive, no universal query object.
 */
export const filterPatternProperties = {
  '^filter\\[[^\\]]+\\]$': {
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  },
} as const;

/**
 * Standalone query schema for routes accepting only filtering.
 * Unknown top-level fields are rejected — they must never silently
 * become behavior. (Per-key bounds live in the normalizer, the single
 * enforcement point.)
 */
export const filterQuerySchema = {
  type: 'object',
  additionalProperties: false,
  patternProperties: filterPatternProperties,
} as const;

function invalidFilter(detail: string): AppError {
  // Static details only: the offending value is never reflected, so
  // attacker input cannot round-trip into a public `detail`.
  return new AppError(ErrorCodes.VALIDATION_FAILED, 400, detail, { title: 'Bad Request' });
}

/**
 * Strict ISO-8601 UTC instant: `YYYY-MM-DDTHH:mm:ss[.sss]Z` with real
 * calendar validity (leap years included). Never `Date.parse` — its
 * permissive parsing would accept non-contract shapes and silently
 * reinterpret timezones. Returns the canonical string unchanged.
 */
function parseDatetime(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) {
    throw invalidFilter('Invalid filtering: datetime must be ISO-8601 UTC (YYYY-MM-DDTHH:mm:ssZ).');
  }
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) {
    throw invalidFilter('Invalid filtering: datetime is out of range.');
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > daysInMonth) {
    throw invalidFilter('Invalid filtering: datetime is out of range.');
  }
  return value;
}

function parseScalar(value: string, def: FilterFieldDef): string | number {
  if (value.length === 0) {
    throw invalidFilter('Invalid filtering: values must be non-empty.');
  }
  if (value.length > MAX_FILTER_VALUE_LENGTH) {
    throw invalidFilter('Invalid filtering: value exceeds the maximum length.');
  }
  switch (def.type) {
    case 'string':
      return value;
    case 'enum':
      if (!(def.values as ReadonlyArray<string>).includes(value)) {
        throw invalidFilter('Invalid filtering: value is not an allowed enum member.');
      }
      return value;
    case 'integer': {
      if (!/^-?[0-9]+$/.test(value)) {
        throw invalidFilter('Invalid filtering: value must be an integer.');
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) {
        throw invalidFilter('Invalid filtering: value is out of range.');
      }
      return parsed;
    }
    case 'datetime':
      return parseDatetime(value);
  }
}

function splitKey(key: string): { field: string; operator: FilterOperator } {
  if (key.length === 0 || key.length > MAX_FILTER_KEY_LENGTH) {
    throw invalidFilter('Invalid filtering: unknown filter field.');
  }
  for (const { suffix, operator } of OPERATOR_SUFFIXES) {
    if (key.endsWith(suffix) && key.length > suffix.length) {
      return { field: key.slice(0, -suffix.length), operator };
    }
  }
  return { field: key, operator: 'eq' };
}

function parseValues(
  raw: string | Array<string>,
  def: FilterFieldDef,
  operator: FilterOperator,
): ReadonlyArray<string | number> {
  const list = Array.isArray(raw) ? raw : [raw];
  if (operator === 'in') {
    const elements: Array<string | number> = [];
    for (const item of list) {
      for (const element of item.split(',')) {
        elements.push(parseScalar(element, def));
      }
    }
    if (elements.length > MAX_IN_VALUES) {
      throw invalidFilter(`Invalid filtering: at most ${MAX_IN_VALUES} values per filter.`);
    }
    return elements;
  }
  // Repeated keys AND: one value per occurrence (§9.3).
  return list.map((item) => parseScalar(item, def));
}

/**
 * Validates raw query input into normalized filtering (M7.5 §5–§14).
 *
 * Accepts the parsed query object as the framework delivers it: bracket
 * keys arrive literally (`{ 'filter[status]': 'active' }`) because
 * Fastify's default parser does not nest them — the expansion below is
 * deliberate and documented, not an accident of one parser. Keys outside
 * the `filter` namespace are sibling parsers' business (pagination,
 * sorting) and are ignored here; route schemas govern unknown keys.
 * `filter` absent → zero criteria (same as unfiltered). Violations throw
 * a 400 AppError. Repositories must never receive `req.query` or raw
 * strings — only the result of this function, translated to persistence
 * syntax at the repository boundary.
 */
export function parseFilter(query: unknown, config: FilterConfig): NormalizedFilter {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw invalidFilter('Invalid filtering: query must be an object.');
  }
  const criteria: FilterCriterion[] = [];
  let count = 0;
  for (const [key, raw] of Object.entries(query as Record<string, unknown>)) {
    if (!key.startsWith('filter')) {
      continue;
    }
    const inner = /^filter\[([^\]]+)\]$/.exec(key)?.[1];
    if (inner === undefined) {
      throw invalidFilter('Invalid filtering: filter keys must look like filter[field].');
    }
    const { field, operator } = splitKey(inner);
    const def = config.fields.get(field);
    if (def === undefined) {
      throw invalidFilter('Invalid filtering: unknown filter field.');
    }
    if (!TYPE_OPERATORS[def.type].includes(operator)) {
      throw invalidFilter('Invalid filtering: operator not supported for this field.');
    }
    if (typeof raw !== 'string' && !Array.isArray(raw)) {
      throw invalidFilter('Invalid filtering: values must be strings.');
    }
    if (Array.isArray(raw) && raw.some((item) => typeof item !== 'string')) {
      throw invalidFilter('Invalid filtering: values must be strings.');
    }
    const values = parseValues(raw as string | Array<string>, def, operator);
    // The cap counts predicates: one `in`-list is one criterion no
    // matter its cardinality (elements carry their own bound above).
    count += operator === 'in' ? 1 : values.length;
    if (count > MAX_FILTER_CRITERIA) {
      throw invalidFilter(`Invalid filtering: at most ${MAX_FILTER_CRITERIA} filter criteria per request.`);
    }
    if (operator === 'in') {
      criteria.push({ field, operator, column: def.column, value: values });
    } else {
      for (const value of values) {
        criteria.push({ field, operator, column: def.column, value });
      }
    }
  }
  return { criteria };
}
