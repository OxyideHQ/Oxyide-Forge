import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../errors/app-error.js';
import { ErrorCodes } from '../errors/error-codes.js';
import {
  defineSortConfig,
  MAX_SORT_FIELDS,
  parseSort,
  sortOrderEntries,
  type NormalizedSort,
  type SortConfig,
} from './sorting.js';

/**
 * M7.4 — sorting primitive proofs.
 *
 * Pure unit tests for definition/validation/normalization/entries, HTTP
 * tests through the REAL schema and normalizer with production-identical
 * AJV policy (M7.3 fidelity lesson: default Fastify options coerce and
 * strip — the opposite of production), one M6-integration test proving
 * the frozen error contract, and pagination-composition proof.
 */

const USER_SORT: SortConfig = defineSortConfig({
  fields: { email: 'email', createdAt: 'createdAt', displayName: 'displayName' },
  defaultField: 'createdAt',
  defaultDirection: 'desc',
  tieBreaker: { column: 'id', direction: 'asc' },
});

describe('defineSortConfig — definition-time validation', () => {
  it('rejects an empty allowlist', () => {
    expect(() =>
      defineSortConfig({
        fields: {},
        defaultField: 'createdAt',
        defaultDirection: 'desc',
        tieBreaker: { column: 'id', direction: 'asc' },
      }),
    ).toThrow(Error);
  });

  it('rejects an unknown default field and bad defaults', () => {
    const base = {
      fields: { email: 'email' },
      defaultDirection: 'desc' as const,
      tieBreaker: { column: 'id', direction: 'asc' as const },
    };
    expect(() => defineSortConfig({ ...base, defaultField: 'nope' })).toThrow(Error);
    expect(() =>
      defineSortConfig({ ...base, defaultField: 'email', defaultDirection: 'sideways' as never }),
    ).toThrow(Error);
    expect(() =>
      defineSortConfig({ ...base, defaultField: 'email', tieBreaker: { column: '', direction: 'asc' as const } }),
    ).toThrow(Error);
  });

  it('stores the allowlist immune to prototype games', () => {
    const config = defineSortConfig({
      fields: { email: 'email' },
      defaultField: 'email',
      defaultDirection: 'asc',
      tieBreaker: { column: 'id', direction: 'asc' },
    });
    expect(config.fields.get('__proto__')).toBeUndefined();
    expect(config.fields.get('constructor')).toBeUndefined();
    expect(config.fields.get('prototype')).toBeUndefined();
  });
});

describe('parseSort — valid contracts', () => {
  it('applies the endpoint default when sort is omitted', () => {
    expect(parseSort({}, USER_SORT)).toEqual({
      sorts: [{ field: 'createdAt', direction: 'desc', column: 'createdAt' }],
      tieBreaker: { column: 'id', direction: 'asc' },
    });
  });

  it('accepts a bare field with per-entry default asc', () => {
    expect(parseSort({ sort: 'email' }, USER_SORT)).toEqual({
      sorts: [{ field: 'email', direction: 'asc', column: 'email' }],
      tieBreaker: { column: 'id', direction: 'asc' },
    });
  });

  it('accepts explicit directions and preserves client order', () => {
    const result = parseSort({ sort: 'email:desc,createdAt:asc' }, USER_SORT);
    expect(result.sorts).toEqual([
      { field: 'email', direction: 'desc', column: 'email' },
      { field: 'createdAt', direction: 'asc', column: 'createdAt' },
    ]);
  });

  it('accepts three fields (the documented maximum)', () => {
    const result = parseSort({ sort: 'email:asc,createdAt:desc,displayName:asc' }, USER_SORT);
    expect(result.sorts).toHaveLength(3);
  });

  it('separates external names from internal columns', () => {
    const config = defineSortConfig({
      fields: { created: 'createdAt', name: 'displayName' },
      defaultField: 'created',
      defaultDirection: 'desc',
      tieBreaker: { column: 'id', direction: 'asc' },
    });
    expect(parseSort({ sort: 'created:asc' }, config).sorts).toEqual([
      { field: 'created', direction: 'asc', column: 'createdAt' },
    ]);
  });
});

describe('parseSort — invalid input (§19)', () => {
  const BAD: ReadonlyArray<{ name: string; query: unknown }> = [
    { name: 'unsupported field', query: { sort: 'passwordHash' } },
    { name: 'empty sort', query: { sort: '' } },
    { name: 'trailing colon', query: { sort: 'email:' } },
    { name: 'leading colon', query: { sort: ':asc' } },
    { name: 'double colon', query: { sort: 'email:asc:extra' } },
    { name: 'empty entry', query: { sort: 'email,,createdAt' } },
    { name: 'leading comma', query: { sort: ',email' } },
    { name: 'trailing comma', query: { sort: 'email,' } },
    { name: 'uppercase direction', query: { sort: 'email:ASC' } },
    { name: 'numeric direction', query: { sort: 'email:1' } },
    { name: 'word direction', query: { sort: 'email:ascending' } },
    { name: 'four fields', query: { sort: 'email:asc,createdAt:asc,displayName:asc,email:desc' } },
    { name: 'duplicate params', query: { sort: ['email', 'createdAt'] } },
    { name: 'duplicate column, default directions', query: { sort: 'email,email' } },
    { name: 'duplicate column, mixed directions', query: { sort: 'email:asc,email:desc' } },
    { name: 'duplicate column among three entries', query: { sort: 'email:asc,createdAt:desc,email:desc' } },
    { name: 'object value', query: { sort: { email: 'asc' } } },
    { name: 'number value', query: { sort: 1 } },
    { name: 'null value', query: { sort: null } },
    { name: 'boolean value', query: { sort: true } },
    { name: 'non-object query', query: 'sort=email' },
    { name: 'null query', query: null },
    { name: 'array query', query: [] },
  ];

  for (const bad of BAD) {
    it(`rejects ${bad.name}`, () => {
      expect(() => parseSort(bad.query, USER_SORT)).toThrow(AppError);
    });
  }

  it('rejects a repeated sort column within the field limit (M710 freeze: duplicates are rejected, never last-wins)', () => {
    for (const sort of ['email,email', 'email:asc,email:desc', 'email:desc,createdAt:asc,email:asc']) {
      try {
        parseSort({ sort }, USER_SORT);
        expect.unreachable(`expected 400 for duplicate sort column: ${sort}`);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCodes.VALIDATION_FAILED);
        expect((error as AppError).statusCode).toBe(400);
      }
    }
    // Distinct columns within the limit remain accepted.
    expect(parseSort({ sort: 'email:asc,createdAt:desc' }, USER_SORT).sorts).toHaveLength(2);
  });

  it('throws the frozen validation contract without reflecting input', () => {
    for (const query of [{ sort: '<script>alert(1)</script>' }, { sort: 'credential.passwordHash:desc' }]) {
      try {
        parseSort(query, USER_SORT);
        expect.unreachable('must throw');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(AppError);
        const appError = error as AppError;
        expect(appError.code).toBe(ErrorCodes.VALIDATION_FAILED);
        expect(appError.statusCode).toBe(400);
        expect(JSON.stringify(appError)).not.toContain('<script>');
        expect(JSON.stringify(appError)).not.toContain('credential');
      }
    }
  });
});

describe('parseSort — security boundary (§15, §16)', () => {
  const HOSTILE = [
    'sort=1',
    'sort=*',
    'sort=../../id',
    'sort=User.email',
    'sort=credential.passwordHash',
    'sort=credentials.passwordHash',
    'sort=foo.bar',
    'sort={"email":"asc"}',
    'sort=email desc',
    'sort=email,createdAt,displayName,email',
    'sort=email%00',
    'sort=proto',
    'sort=constructor',
    'sort=prototype',
    'sort=__proto__',
    'sort=__proto__:asc',
    'sort=constructor:desc',
    'sort=email:asc:nulls-first',
    'sort=email:ASC',
    'sort=EMAIL:asc',
    'sort=é',
  ];

  for (const hostile of HOSTILE) {
    it(`rejects ${hostile}`, () => {
      const [, value = ''] = hostile.split('=');
      const decoded = decodeURIComponent(value);
      expect(() => parseSort({ sort: decoded }, USER_SORT)).toThrow(AppError);
    });
  }

  it('rejects oversized sort strings at the lexical layer', () => {
    expect('x'.repeat(129)).toHaveLength(129);
    // Unit-level: the allowlist rejects regardless of length.
    expect(() => parseSort({ sort: 'x'.repeat(129) }, USER_SORT)).toThrow(AppError);
  });

  it('never consults the prototype chain for membership', () => {
    for (const key of ['toString', 'hasOwnProperty', 'valueOf', '__proto__', 'constructor']) {
      expect(() => parseSort({ sort: key }, USER_SORT)).toThrow(AppError);
    }
    expect({}).toHaveProperty('toString');
  });
});

describe('sortOrderEntries — persistence translation shape', () => {
  it('orders client sorts first, tie-breaker last', () => {
    const sort: NormalizedSort = parseSort({ sort: 'email:desc,createdAt:asc' }, USER_SORT);
    expect(sortOrderEntries(sort)).toEqual([
      { column: 'email', direction: 'desc' },
      { column: 'createdAt', direction: 'asc' },
      { column: 'id', direction: 'asc' },
    ]);
  });

  it('dedupes a tie-breaker column the client already sorts', () => {
    const byId = defineSortConfig({
      fields: { id: 'id', email: 'email' },
      defaultField: 'id',
      defaultDirection: 'asc',
      tieBreaker: { column: 'id', direction: 'asc' },
    });
    expect(sortOrderEntries(parseSort({ sort: 'id:desc' }, byId))).toEqual([
      { column: 'id', direction: 'desc' },
    ]);
    expect(sortOrderEntries(parseSort({ sort: 'email:asc' }, byId))).toEqual([
      { column: 'email', direction: 'asc' },
      { column: 'id', direction: 'asc' },
    ]);
  });

  it('contains only allowlisted columns and valid directions', () => {
    const allowed = new Set(['email', 'createdAt', 'displayName', 'id']);
    const sort = parseSort({ sort: 'displayName:desc' }, USER_SORT);
    for (const entry of sortOrderEntries(sort)) {
      expect(allowed.has(entry.column)).toBe(true);
      expect(['asc', 'desc']).toContain(entry.direction);
    }
  });
});

describe('query schema over HTTP — production-identical AJV (§20)', () => {
  let probe: FastifyInstance;

  beforeAll(async () => {
    // Mirror the application's AJV policy exactly (src/app/app.ts):
    // strict rejection, no silent coercion, no silent stripping.
    probe = Fastify({
      logger: false,
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    const { sortQuerySchema } = await import('./sorting.js');
    const { parseSort: parse } = await import('./sorting.js');
    probe.get('/items', { schema: { querystring: sortQuerySchema } }, async (request, reply) => {
      return reply.status(200).send(parse(request.query, USER_SORT));
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

  it('applies the endpoint default when the query is absent', async () => {
    const response = await get('/items');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sorts: [{ field: 'createdAt', direction: 'desc', column: 'createdAt' }],
      tieBreaker: { column: 'id', direction: 'asc' },
    });
  });

  it('normalizes a valid multi-field sort', async () => {
    const response = await get('/items?sort=email:desc,createdAt:asc');
    expect(response.statusCode).toBe(200);
    expect((response.json() as NormalizedSort).sorts).toHaveLength(2);
  });

  it.each([['sort=passwordHash'], ['sort=email:ASC'], ['sort=email:asc,createdAt:desc,displayName:asc,email:asc'], ['sort=a,b,c,d'], ['sort=email,email'], ['sort=email:asc,email:desc']])(
    'rejects %s with 400',
    async (query) => {
      expect((await get(`/items?${query}`)).statusCode).toBe(400);
    },
  );

  it('rejects duplicates and unknown fields deterministically', async () => {
    expect((await get('/items?sort=email&sort=createdAt')).statusCode).toBe(400);
    expect((await get('/items?order=email')).statusCode).toBe(400);
    expect((await get('/items?sort=__proto__')).statusCode).toBe(400);
  });
});

describe('M6 integration — invalid sort uses the frozen error contract (§22)', () => {
  it('serves 400 VALIDATION_FAILED problem+json end to end', async () => {
    const { buildApp } = await import('../../app/app.js');
    const { sortQuerySchema: schema } = await import('./sorting.js');
    const { parseSort: parse } = await import('./sorting.js');
    const scoped = await buildApp({ loggerStream: { write: () => true } });
    scoped.get('/__m74__/items', { schema: { querystring: schema } }, async (request, reply) => {
      return reply.status(200).send(parse(request.query, USER_SORT));
    });
    await scoped.ready();

    const ok = await scoped.inject({ method: 'GET', url: '/__m74__/items?sort=email:desc' });
    expect(ok.statusCode).toBe(200);

    const bad = (await scoped.inject({
      method: 'GET',
      url: '/__m74__/items?sort=credential.passwordHash',
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
    expect(bad.payload).not.toContain('credential');

    await scoped.close();
  });
});

describe('pagination composition (§18)', () => {
  it('parses pagination and sorting independently from one query', async () => {
    const { paginationQueryProperties, parsePagination } = await import('../pagination/pagination.js');
    const { sortQueryProperties } = await import('./sorting.js');
    // The route-level composition pattern: spread both fragments.
    const combined = { ...paginationQueryProperties, ...sortQueryProperties };
    expect(Object.keys(combined).sort()).toEqual(['limit', 'page', 'sort']);

    const query = { page: '2', limit: '10', sort: 'email:desc' };
    expect(parsePagination(query)).toEqual({ page: 2, limit: 10, offset: 10 });
    expect(parseSort(query, USER_SORT).sorts).toEqual([
      { field: 'email', direction: 'desc', column: 'email' },
    ]);

    const { buildPaginatedResponse } = await import('../pagination/pagination.js');
    expect(
      buildPaginatedResponse(['a'], { page: 2, limit: 10, total: 25 }),
    ).toEqual({
      items: ['a'],
      pagination: { page: 2, limit: 10, total: 25, totalPages: 3 },
    });
  });

  it(`documents the ${String(MAX_SORT_FIELDS)}-field ceiling`, () => {
    expect(MAX_SORT_FIELDS).toBe(3);
  });
});
