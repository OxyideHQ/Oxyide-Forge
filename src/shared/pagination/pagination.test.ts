import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../errors/app-error.js';
import { ErrorCodes } from '../errors/error-codes.js';
import {
  buildPaginatedResponse,
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
  PAGINATION_METADATA_JSON_SCHEMA,
  paginationQuerySchema,
  parsePagination,
  type NormalizedPagination,
} from './pagination.js';

/**
 * M7.3 — pagination primitive proofs.
 *
 * Pure unit tests for normalization/offset/metadata/invariants, plus
 * HTTP tests through the REAL schema and normalizer on light Fastify
 * instances (query parsing, duplicates, unknown fields, defaults), plus
 * one M6-integration test proving invalid pagination reaches the frozen
 * error contract end to end.
 */

const LARGEST_VALID_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / MAX_LIMIT) + 1;

describe('parsePagination — defaults and normalization', () => {
  it('applies defaults when fields are omitted', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  it('normalizes digit strings to numbers', () => {
    expect(parsePagination({ page: '3', limit: '50' })).toEqual({ page: 3, limit: 50, offset: 100 });
  });

  it('accepts numbers where already converted', () => {
    expect(parsePagination({ page: 2, limit: 10 })).toEqual({ page: 2, limit: 10, offset: 10 });
  });

  it('accepts leading zeros as their numeric value', () => {
    expect(parsePagination({ page: '020' })).toEqual({ page: 20, limit: 20, offset: 380 });
  });

  it('rejects non-object query input', () => {
    for (const input of [null, undefined, 42, 'page=1', [{ page: 1 }]]) {
      expect(() => parsePagination(input), JSON.stringify(input)).toThrow(AppError);
    }
  });
});

describe('parsePagination — adversarial values (§21B)', () => {
  const BAD_PAGES: ReadonlyArray<{ name: string; value: unknown }> = [
    { name: 'zero', value: 0 },
    { name: 'zero-string', value: '0' },
    { name: 'negative', value: -1 },
    { name: 'negative-string', value: '-1' },
    { name: 'alpha', value: 'abc' },
    { name: 'fraction', value: 1.5 },
    { name: 'fraction-string', value: '1.5' },
    { name: 'NaN-string', value: 'NaN' },
    { name: 'Infinity-string', value: 'Infinity' },
    { name: 'Infinity-number', value: Number.POSITIVE_INFINITY },
    { name: 'blank', value: '' },
    { name: 'whitespace', value: ' 20' },
    { name: 'plus-sign', value: '+20' },
    { name: 'hex', value: '0x14' },
    { name: 'boolean', value: true },
    { name: 'null', value: null },
    { name: 'array', value: [1] },
    { name: 'duplicate-array', value: ['1', '2'] },
    { name: 'object', value: { $gt: 1 } },
    { name: 'unsafe-integer', value: Number.MAX_SAFE_INTEGER + 1 },
    { name: 'unsafe-digit-string', value: '9007199254740993' },
  ];

  for (const bad of BAD_PAGES) {
    it(`rejects page=${bad.name}`, () => {
      expect(() => parsePagination({ page: bad.value })).toThrow(AppError);
    });
  }

  const BAD_LIMITS: ReadonlyArray<{ name: string; value: unknown }> = [
    { name: 'zero', value: 0 },
    { name: 'zero-string', value: '0' },
    { name: 'negative', value: -5 },
    { name: 'alpha', value: 'abc' },
    { name: 'fraction-string', value: '2.5' },
    { name: 'over-max', value: 101 },
    { name: 'over-max-string', value: '101' },
    { name: 'huge', value: 1000000 },
    { name: 'NaN-string', value: 'NaN' },
    { name: 'Infinity-string', value: 'Infinity' },
    { name: 'blank', value: '' },
    { name: 'array', value: ['10', '20'] },
    { name: 'object', value: { $lte: 10 } },
  ];

  for (const bad of BAD_LIMITS) {
    it(`rejects limit=${bad.name}`, () => {
      expect(() => parsePagination({ limit: bad.value })).toThrow(AppError);
    });
  }

  it('accepts boundary values 1 and 100', () => {
    expect(parsePagination({ page: 1, limit: 1 })).toEqual({ page: 1, limit: 1, offset: 0 });
    expect(parsePagination({ page: '1', limit: '100' })).toEqual({ page: 1, limit: 100, offset: 0 });
  });

  it('throws the frozen validation contract (400 VALIDATION_FAILED, no reflection)', () => {
    for (const query of [{ page: '<script>alert(1)</script>' }, { limit: '1000000' }]) {
      try {
        parsePagination(query);
        expect.unreachable('must throw');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(AppError);
        const appError = error as AppError;
        expect(appError.code).toBe(ErrorCodes.VALIDATION_FAILED);
        expect(appError.statusCode).toBe(400);
        expect(JSON.stringify(appError)).not.toContain('<script>');
        expect(JSON.stringify(appError)).not.toContain('1000000');
      }
    }
  });
});

describe('parsePagination — offset safety (§21D, §9, §14)', () => {
  const CASES: ReadonlyArray<{ page: number; limit: number; offset: number }> = [
    { page: 1, limit: 20, offset: 0 },
    { page: 2, limit: 20, offset: 20 },
    { page: 3, limit: 20, offset: 40 },
    { page: 1000000, limit: 100, offset: 99999900 },
    { page: LARGEST_VALID_PAGE, limit: 100, offset: (LARGEST_VALID_PAGE - 1) * 100 },
  ];

  for (const testCase of CASES) {
    it(`page ${testCase.page} / limit ${testCase.limit} → offset ${testCase.offset}`, () => {
      expect(parsePagination({ page: testCase.page, limit: testCase.limit })).toEqual({
        page: testCase.page,
        limit: testCase.limit,
        offset: testCase.offset,
      });
    });
  }

  it('rejects pages whose offset exceeds the safe integer range', () => {
    expect(() => parsePagination({ page: LARGEST_VALID_PAGE + 1, limit: 100 })).toThrow(AppError);
    expect(() => parsePagination({ page: Number.MAX_SAFE_INTEGER, limit: 100 })).toThrow(AppError);
  });
});

describe('pagination invariants (§22, table-driven)', () => {
  const VALID: ReadonlyArray<{ page: number; limit: number }> = [
    { page: 1, limit: 1 },
    { page: 1, limit: 20 },
    { page: 7, limit: 100 },
    { page: 1000000, limit: 13 },
    { page: LARGEST_VALID_PAGE, limit: 100 },
  ];

  for (const input of VALID) {
    it(`holds for page=${input.page} limit=${input.limit}`, () => {
      const result: NormalizedPagination = parsePagination(input);
      expect(Number.isInteger(result.page) && Number.isFinite(result.page)).toBe(true);
      expect(Number.isInteger(result.limit) && Number.isFinite(result.limit)).toBe(true);
      expect(Number.isInteger(result.offset) && Number.isFinite(result.offset)).toBe(true);
      expect(result.page).toBeGreaterThanOrEqual(1);
      expect(result.limit).toBeLessThanOrEqual(MAX_LIMIT);
      expect(result.offset).toBeGreaterThanOrEqual(0);
      expect(result.offset).toBe((result.page - 1) * result.limit);
    });
  }
});

describe('buildPaginatedResponse — metadata (§21E)', () => {
  it('echoes page/limit with totals', () => {
    expect(buildPaginatedResponse(['a', 'b'], { page: 2, limit: 20, total: 101 })).toEqual({
      items: ['a', 'b'],
      pagination: { page: 2, limit: 20, total: 101, totalPages: 6 },
    });
  });

  it('defines zero-result behavior: totalPages 0', () => {
    expect(buildPaginatedResponse([], { page: 1, limit: 20, total: 0 })).toEqual({
      items: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it('computes exact pages without rounding up', () => {
    expect(buildPaginatedResponse([], { page: 1, limit: 20, total: 40 }).pagination.totalPages).toBe(2);
  });

  it('fails loud on a nonsense total instead of publishing it', () => {
    expect(() => buildPaginatedResponse([], { page: 1, limit: 20, total: -1 })).toThrow(Error);
    expect(() => buildPaginatedResponse([], { page: 1, limit: 20, total: 1.5 })).toThrow(Error);
  });

  it('metadata schema declares exactly the contract fields', () => {
    expect(PAGINATION_METADATA_JSON_SCHEMA.required).toEqual(['page', 'limit', 'total', 'totalPages']);
    expect(PAGINATION_METADATA_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('query schema over HTTP — parser behavior (§17, §18)', () => {
  let probe: FastifyInstance;

  beforeAll(async () => {
    // Mirror the application's AJV policy exactly (see buildApp in
    // src/app/app.ts): strict rejection, no silent coercion, no silent
    // stripping. Fastify's DEFAULT options would coerce (" 20"→20) and
    // strip unknown keys — the opposite of production behavior — so a
    // default-options probe would prove nothing about the real boundary.
    probe = Fastify({
      logger: false,
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    probe.get(
      '/items',
      { schema: { querystring: paginationQuerySchema } },
      async (request, reply) => {
        return reply.status(200).send(parsePagination(request.query));
      },
    );
    await probe.ready();
  });

  afterAll(async () => {
    await probe?.close();
  });

  async function echoedQuery(url: string): Promise<{ statusCode: number; json(): unknown }> {
    return (await probe.inject({ method: 'GET', url })) as unknown as {
      statusCode: number;
      json(): unknown;
    };
  }

  it('applies defaults when the query is absent', async () => {
    const response = await echoedQuery('/items');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ page: DEFAULT_PAGE, limit: DEFAULT_LIMIT, offset: 0 });
  });

  it('normalizes valid digit strings', async () => {
    const response = await echoedQuery('/items?page=3&limit=50');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ page: 3, limit: 50, offset: 100 });
  });

  it.each([['page=0'], ['page=-1'], ['page=abc'], ['page=1.5'], ['limit=0'], ['limit=101'], ['limit=abc']])(
    'rejects invalid query %s with 400',
    async (query) => {
      expect((await echoedQuery(`/items?${query}`)).statusCode).toBe(400);
    },
  );

  it('rejects duplicate parameters deterministically', async () => {
    // Whatever the parser produces for repeats (array), the contract
    // rejects it — no silent first-wins/last-wins ambiguity.
    expect((await echoedQuery('/items?page=1&page=2')).statusCode).toBe(400);
    expect((await echoedQuery('/items?limit=10&limit=20')).statusCode).toBe(400);
  });

  it('rejects unknown fields and pollution-shaped input', async () => {
    expect((await echoedQuery('/items?sort=name')).statusCode).toBe(400);
    expect((await echoedQuery('/items?page[$gt]=1')).statusCode).toBe(400);
    expect((await echoedQuery('/items?page=%2020')).statusCode).toBe(400);
  });
});

describe('M6 integration — invalid pagination uses the frozen error contract (§20)', () => {
  it('serves 400 VALIDATION_FAILED problem+json end to end', async () => {
    const { buildApp } = await import('../../app/app.js');
    const scoped = await buildApp({ loggerStream: { write: () => true } });
    scoped.get(
      '/__m73__/items',
      { schema: { querystring: paginationQuerySchema } },
      async (request, reply) => {
        return reply.status(200).send(parsePagination(request.query));
      },
    );
    await scoped.ready();

    const ok = await scoped.inject({ method: 'GET', url: '/__m73__/items?page=2&limit=10' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ page: 2, limit: 10, offset: 10 });

    const bad = (await scoped.inject({ method: 'GET', url: '/__m73__/items?limit=1000000' })) as unknown as {
      statusCode: number;
      headers: Record<string, string>;
      payload: string;
      json(): Record<string, unknown>;
    };
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain('application/problem+json');
    expect(Object.keys(bad.json()).sort()).toEqual(['code', 'detail', 'instance', 'status', 'title', 'type']);
    expect(bad.json().code).toBe('VALIDATION_FAILED');
    expect(bad.payload).not.toContain('1000000');

    await scoped.close();
  });
});
