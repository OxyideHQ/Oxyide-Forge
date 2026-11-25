import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../errors/app-error.js';
import { ErrorCodes } from '../errors/error-codes.js';
import {
  defineFilterConfig,
  MAX_FILTER_CRITERIA,
  MAX_FILTER_KEY_LENGTH,
  MAX_FILTER_VALUE_LENGTH,
  MAX_IN_VALUES,
  parseFilter,
  type FilterConfig,
  type NormalizedFilter,
} from './filtering.js';

/**
 * M7.5 — filtering primitive proofs.
 *
 * Pure unit tests for definition/contract/validation/caps/security,
 * HTTP tests through the REAL schema and normalizer with
 * production-identical AJV policy (M7.3 fidelity lesson), one
 * M6-integration test proving the frozen error contract, and
 * pagination+sorting composition proof. No DB required anywhere.
 *
 * Wire-shape note: Fastify's default parser does NOT nest brackets, so
 * every test uses the literal wire form (`{ 'filter[status]': 'active' }`)
 * — the same shape production traffic produces.
 */

const USER_FILTER: FilterConfig = defineFilterConfig({
  fields: {
    email: { type: 'string', column: 'email' },
    status: {
      type: 'enum',
      column: 'status',
      values: ['active', 'inactive', 'suspended'],
    },
    loginCount: { type: 'integer', column: 'loginCount' },
    createdAt: { type: 'datetime', column: 'createdAt' },
  },
});

describe('defineFilterConfig — definition-time validation', () => {
  it('rejects an empty allowlist', () => {
    expect(() => defineFilterConfig({ fields: {} })).toThrow(Error);
  });

  it('rejects ill-shaped columns', () => {
    expect(() =>
      defineFilterConfig({ fields: { email: { type: 'string', column: 'user email' } } }),
    ).toThrow(Error);
    expect(() =>
      defineFilterConfig({ fields: { email: { type: 'string', column: '' } } }),
    ).toThrow(Error);
  });

  it('requires enum members exactly for enums', () => {
    expect(() =>
      defineFilterConfig({ fields: { status: { type: 'enum', column: 'status' } } }),
    ).toThrow(Error);
    expect(() =>
      defineFilterConfig({
        fields: { email: { type: 'string', column: 'email', values: ['a'] } },
      }),
    ).toThrow(Error);
  });

  it('stores the allowlist immune to prototype games', () => {
    expect(USER_FILTER.fields.get('__proto__')).toBeUndefined();
    expect(USER_FILTER.fields.get('constructor')).toBeUndefined();
    expect(USER_FILTER.fields.get('prototype')).toBeUndefined();
    expect(USER_FILTER.fields.get('toString')).toBeUndefined();
  });
});

describe('parseFilter — contract (§29)', () => {
  it('returns zero criteria when no filter keys are present', () => {
    expect(parseFilter({}, USER_FILTER)).toEqual({ criteria: [] });
    expect(parseFilter({ page: '1', sort: 'email' }, USER_FILTER)).toEqual({ criteria: [] });
  });

  it('parses equality by default with column mapping', () => {
    expect(parseFilter({ 'filter[status]': 'active' }, USER_FILTER)).toEqual({
      criteria: [{ field: 'status', operator: 'eq', column: 'status', value: 'active' }],
    });
  });

  it('parses every supported operator per type', () => {
    const result = parseFilter(
      {
        'filter[email_contains]': 'example.com',
        'filter[email_ne]': 'x@y.z',
        'filter[status_in]': 'active,suspended',
        'filter[loginCount_gte]': '5',
        'filter[loginCount_lt]': '100',
        'filter[createdAt_gt]': '2026-01-01T00:00:00Z',
        'filter[createdAt_lte]': '2026-12-31T23:59:59.999Z',
      },
      USER_FILTER,
    );
    expect(result.criteria).toEqual([
      { field: 'email', operator: 'contains', column: 'email', value: 'example.com' },
      { field: 'email', operator: 'ne', column: 'email', value: 'x@y.z' },
      {
        field: 'status',
        operator: 'in',
        column: 'status',
        value: ['active', 'suspended'],
      },
      { field: 'loginCount', operator: 'gte', column: 'loginCount', value: 5 },
      { field: 'loginCount', operator: 'lt', column: 'loginCount', value: 100 },
      { field: 'createdAt', operator: 'gt', column: 'createdAt', value: '2026-01-01T00:00:00Z' },
      {
        field: 'createdAt',
        operator: 'lte',
        column: 'createdAt',
        value: '2026-12-31T23:59:59.999Z',
      },
    ]);
  });

  it('ANDs multiple criteria in client order', () => {
    const result = parseFilter(
      { 'filter[status]': 'active', 'filter[loginCount_gte]': '3' },
      USER_FILTER,
    );
    expect(result.criteria.map((criterion) => criterion.field)).toEqual(['status', 'loginCount']);
  });

  it('ANDs repeated keys element-wise (§9.3)', () => {
    const result = parseFilter({ 'filter[status]': ['active', 'suspended'] }, USER_FILTER);
    expect(result.criteria).toEqual([
      { field: 'status', operator: 'eq', column: 'status', value: 'active' },
      { field: 'status', operator: 'eq', column: 'status', value: 'suspended' },
    ]);
  });

  it('keeps an external/internal name separation', () => {
    const config = defineFilterConfig({
      fields: { name: { type: 'string', column: 'displayName' } },
    });
    expect(parseFilter({ 'filter[name]': 'Ada' }, config).criteria).toEqual([
      { field: 'name', operator: 'eq', column: 'displayName', value: 'Ada' },
    ]);
  });

  it('rejects operator/type mismatches', () => {
    for (const query of [
      { 'filter[status_gt]': 'active' },
      { 'filter[status_contains]': 'a' },
      { 'filter[email_gt]': 'a' },
      { 'filter[createdAt_contains]': '2026' },
      { 'filter[createdAt_in]': '2026-01-01T00:00:00Z' },
      { 'filter[createdAt_eq]': '2026-01-01T00:00:00Z' },
      { 'filter[loginCount_contains]': '5' },
    ]) {
      expect(() => parseFilter(query, USER_FILTER), JSON.stringify(query)).toThrow(AppError);
    }
  });
});

describe('parseFilter — invalid input (§29)', () => {
  const BAD: ReadonlyArray<{ name: string; query: unknown }> = [
    { name: 'unknown field', query: { 'filter[nickname]': 'x' } },
    { name: 'unknown operator', query: { 'filter[status_near]': 'x' } },
    { name: 'empty brackets', query: { 'filter[]': 'x' } },
    { name: 'bare suffix', query: { 'filter[_ne]': 'x' } },
    { name: 'bare filter key', query: { filter: 'active' } },
    { name: 'filter key prefix without brackets', query: { filterx: 'active' } },
    { name: 'empty value', query: { 'filter[status]': '' } },
    { name: 'empty in-element', query: { 'filter[status_in]': 'active,,suspended' } },
    { name: 'empty in-list', query: { 'filter[status_in]': '' } },
    { name: 'number value', query: { 'filter[loginCount]': 5 } },
    { name: 'boolean value', query: { 'filter[status]': true } },
    { name: 'object value', query: { 'filter[status]': { eq: 'active' } } },
    { name: 'nested array', query: { 'filter[status]': [['active']] } },
    { name: 'filter as array', query: { filter: ['active'] } },
    { name: 'filter as number', query: { filter: 42 } },
    { name: 'non-object query', query: 'filter[status]=active' },
    { name: 'null query', query: null },
    { name: 'array query', query: [] },
    { name: 'bad integer', query: { 'filter[loginCount]': 'abc' } },
    { name: 'fraction integer', query: { 'filter[loginCount]': '5.5' } },
    { name: 'unsafe integer', query: { 'filter[loginCount]': '9007199254740993' } },
    { name: 'bad enum member', query: { 'filter[status]': 'banned' } },
    { name: 'bad datetime', query: { 'filter[createdAt_gt]': 'yesterday' } },
    { name: 'sloppy datetime', query: { 'filter[createdAt_gt]': '2026-1-1' } },
    { name: 'impossible date', query: { 'filter[createdAt_gt]': '2026-02-30T00:00:00Z' } },
    { name: 'non-leap Feb 29', query: { 'filter[createdAt_gt]': '2025-02-29T00:00:00Z' } },
    { name: 'month 13', query: { 'filter[createdAt_gt]': '2026-13-01T00:00:00Z' } },
  ];

  for (const bad of BAD) {
    it(`rejects ${bad.name}`, () => {
      expect(() => parseFilter(bad.query, USER_FILTER)).toThrow(AppError);
    });
  }

  it('accepts leap-day and boundary datetimes', () => {
    expect(
      parseFilter({ 'filter[createdAt_gt]': '2024-02-29T23:59:59Z' }, USER_FILTER).criteria,
    ).toHaveLength(1);
  });

  it('throws the frozen contract without reflecting input', () => {
    for (const query of [
      { 'filter[status]': '<script>alert(1)</script>' },
      { 'filter[unknown]': '1'.repeat(300) },
    ]) {
      try {
        parseFilter(query, USER_FILTER);
        expect.unreachable('must throw');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(AppError);
        const appError = error as AppError;
        expect(appError.code).toBe(ErrorCodes.VALIDATION_FAILED);
        expect(appError.statusCode).toBe(400);
        expect(JSON.stringify(appError)).not.toContain('<script>');
      }
    }
  });
});

describe('parseFilter — security boundary (§20, §21)', () => {
  const HOSTILE_INNERS = [
    'where',
    '$gt',
    'AND',
    'OR',
    'NOT',
    'contains',
    'passwordHash',
    'refreshToken',
    'tokenHash',
    'sessionToken',
    'resetToken',
    'user.email',
    'credential.passwordHash',
    'credentials.passwordHash',
    'User.email',
    'foo.bar',
    '../../id',
    '*',
    '__proto__',
    '__proto___ne',
    'constructor',
    'constructor[in]',
    'prototype',
    'toString',
    'hasOwnProperty',
    'status;DROP',
    "status'--",
    'status/*',
    'email||1==1',
  ];

  for (const inner of HOSTILE_INNERS) {
    it(`rejects hostile key filter[${inner}]`, () => {
      expect(() => parseFilter({ [`filter[${inner}]`]: 'x' }, USER_FILTER)).toThrow(AppError);
    });
  }

  const HOSTILE_VALUES = [
    '{"email":"asc"}',
    "a'; DROP TABLE users;--",
    '/*comment*/',
    'email%00',
    'active,',
    ',active',
  ];

  for (const value of HOSTILE_VALUES) {
    it(`rejects hostile value ${value}`, () => {
      expect(() => parseFilter({ 'filter[status]': value }, USER_FILTER)).toThrow(AppError);
    });
  }

  it('treats "null" as a literal, never null-semantics', () => {
    // String fields match the literal; typed fields reject it outright.
    expect(parseFilter({ 'filter[email]': 'null' }, USER_FILTER).criteria).toEqual([
      { field: 'email', operator: 'eq', column: 'email', value: 'null' },
    ]);
    expect(() => parseFilter({ 'filter[loginCount]': 'null' }, USER_FILTER)).toThrow(AppError);
    expect(() => parseFilter({ 'filter[status]': 'null' }, USER_FILTER)).toThrow(AppError);
  });

  it('never pollutes Object.prototype from parsed input', () => {
    expect(() =>
      parseFilter(JSON.parse('{"filter[__proto__]": {"x": 1}}'), USER_FILTER),
    ).toThrow(AppError);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('parseFilter — complexity limits (§12, §30)', () => {
  it('caps total criteria', () => {
    // Repeated keys expand to one criterion each; the cap counts expanded
    // criteria, so eleven values on one field fail closed.
    const values = Array.from({ length: MAX_FILTER_CRITERIA }, (_, index) => `v${index}@x.y`);
    expect(parseFilter({ 'filter[email]': values }, USER_FILTER).criteria).toHaveLength(
      MAX_FILTER_CRITERIA,
    );
    const over = [...values, 'extra@x.y'];
    expect(() => parseFilter({ 'filter[email]': over }, USER_FILTER)).toThrow(AppError);
  });

  it('counts one in-list as one criterion with its own cardinality cap', () => {
    const members = Array.from({ length: MAX_IN_VALUES }, (_, index) => `m${index}`);
    const config = defineFilterConfig({
      fields: { tag: { type: 'string', column: 'tag' } },
    });
    expect(parseFilter({ 'filter[tag_in]': members.join(',') }, config).criteria).toHaveLength(1);
    expect(() =>
      parseFilter({ 'filter[tag_in]': [...members, 'one-more'].join(',') }, config),
    ).toThrow(AppError);
  });

  it('caps value length with just-over rejection', () => {
    const ok = 'x'.repeat(MAX_FILTER_VALUE_LENGTH);
    expect(parseFilter({ 'filter[email]': ok }, USER_FILTER).criteria).toHaveLength(1);
    expect(() => parseFilter({ 'filter[email]': `${ok}x` }, USER_FILTER)).toThrow(AppError);
  });

  it('caps key length', () => {
    expect(MAX_FILTER_KEY_LENGTH).toBe(64);
    expect(() => parseFilter({ [`filter[${'k'.repeat(65)}]`]: 'x' }, USER_FILTER)).toThrow(
      AppError,
    );
  });
});

describe('query schema over HTTP — production-identical AJV (§24)', () => {
  let probe: FastifyInstance;

  beforeAll(async () => {
    // Mirror the application's AJV policy exactly (src/app/app.ts).
    probe = Fastify({
      logger: false,
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    const { filterQuerySchema } = await import('./filtering.js');
    const { parseFilter: parse } = await import('./filtering.js');
    probe.get('/items', { schema: { querystring: filterQuerySchema } }, async (request, reply) => {
      return reply.status(200).send(parse(request.query, USER_FILTER));
    });
    await probe.ready();
  });

  afterAll(async () => {
    await probe?.close();
  });

  async function get(url: string): Promise<{ statusCode: number; json(): unknown }> {
    return (await probe.inject({ method: 'GET', url })) as unknown as {
      statusCode: number;
      json(): unknown;
    };
  }

  it('passes valid filters and applies AND for repeats', async () => {
    const response = await get('/items?filter[status]=active&filter[loginCount_gte]=5');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      criteria: [
        { field: 'status', operator: 'eq', column: 'status', value: 'active' },
        { field: 'loginCount', operator: 'gte', column: 'loginCount', value: 5 },
      ],
    });
    const repeated = await get('/items?filter[status]=active&filter[status]=suspended');
    expect(repeated.statusCode).toBe(200);
    expect((repeated.json() as NormalizedFilter).criteria).toHaveLength(2);
  });

  it.each([
    ['filter[passwordHash]=x'],
    ['filter[status]='],
    ['filter[status_gt]=active'],
    ['filter[or]=x'],
    ['filter=active'],
    ['filter[status][eq]=active'],
  ])('rejects %s with 400', async (query) => {
    expect((await get(`/items?${query}`)).statusCode).toBe(400);
  });

  it('rejects unknown top-level fields deterministically', async () => {
    expect((await get('/items?sort=email')).statusCode).toBe(400);
    expect((await get('/items?filter[status]=active&limit=10')).statusCode).toBe(400);
  });
});

describe('M6 integration — invalid filter uses the frozen error contract (§25)', () => {
  it('serves 400 VALIDATION_FAILED problem+json end to end', async () => {
    const { buildApp } = await import('../../app/app.js');
    const { filterQuerySchema: schema } = await import('./filtering.js');
    const { parseFilter: parse } = await import('./filtering.js');
    const scoped = await buildApp({ loggerStream: { write: () => true } });
    scoped.get('/__m75__/items', { schema: { querystring: schema } }, async (request, reply) => {
      return reply.status(200).send(parse(request.query, USER_FILTER));
    });
    await scoped.ready();

    const ok = await scoped.inject({ method: 'GET', url: '/__m75__/items?filter[status]=active' });
    expect(ok.statusCode).toBe(200);

    const bad = (await scoped.inject({
      method: 'GET',
      url: '/__m75__/items?filter[passwordHash]=x',
    })) as unknown as {
      statusCode: number;
      headers: Record<string, string>;
      payload: string;
      json(): Record<string, unknown>;
    };
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain('application/problem+json');
    expect(Object.keys(bad.json()).sort()).toEqual(['code', 'detail', 'instance', 'status', 'title', 'type']);
    expect(bad.json().code).toBe('VALIDATION_FAILED');
    expect(bad.payload).not.toContain('passwordHash');

    await scoped.close();
  });
});

describe('pagination + sorting composition (§22)', () => {
  it('parses all three concerns independently from one query', async () => {
    const { paginationQueryProperties, parsePagination } = await import('../pagination/pagination.js');
    const { sortQueryProperties, parseSort, defineSortConfig } = await import('../sorting/sorting.js');
    const { filterPatternProperties } = await import('./filtering.js');
    // The route-level composition pattern: property spreads plus the
    // filter pattern fragment — one fragment per primitive.
    const combined = { ...paginationQueryProperties, ...sortQueryProperties };
    expect(Object.keys(combined).sort()).toEqual(['limit', 'page', 'sort']);
    expect(Object.keys(filterPatternProperties)).toEqual(['^filter\\[[^\\]]+\\]$']);

    const sortConfig = defineSortConfig({
      fields: { createdAt: 'createdAt' },
      defaultField: 'createdAt',
      defaultDirection: 'desc',
      tieBreaker: { column: 'id', direction: 'asc' },
    });
    const query = {
      page: '2',
      limit: '10',
      sort: 'createdAt:desc',
      'filter[status]': 'active',
    };
    expect(parsePagination(query)).toEqual({ page: 2, limit: 10, offset: 10 });
    expect(parseSort(query, sortConfig).sorts).toHaveLength(1);
    expect(parseFilter(query, USER_FILTER).criteria).toHaveLength(1);
  });
});
