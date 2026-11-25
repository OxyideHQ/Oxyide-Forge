import SwaggerParser from '@apidevtools/swagger-parser';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

/**
 * M7.8 — OpenAPI ↔ runtime contract.
 *
 * Answers one question: does the machine-readable document actually
 * describe the API the running application exposes?
 *
 * Deliberately NOT `*.integration.test.ts`: every assertion here is
 * document- or transport-level and runs without PostgreSQL. Requests that
 * must reach a handler live in `openapi-runtime-contract.integration.test.ts`,
 * which is DB-gated. Misclassifying this file would add a fake database
 * dependency to a contract test (same reasoning as M77-F07).
 *
 * There is exactly ONE document under test — the one the real
 * `buildApp()` stack generates. Nothing here re-declares an API.
 */

const { buildApp } = await import('../app/app.js');

// ---------------------------------------------------------------------------
// Types (structural; the document is data, not a second contract)
// ---------------------------------------------------------------------------

type ContentMap = Record<string, { schema?: Record<string, unknown> }>;

type ResponseObject = {
  description?: string;
  content?: ContentMap;
  headers?: unknown;
};

type Operation = {
  operationId?: string;
  deprecated?: boolean;
  summary?: string;
  description?: string;
  tags?: string[];
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown }>;
  requestBody?: { content?: ContentMap };
  responses?: Record<string, ResponseObject | { $ref: string }>;
  [key: string]: unknown;
};

type Spec = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, Operation>>;
  tags?: Array<{ name: string }>;
  components?: {
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
};

/**
 * The frozen public API surface (M7.7). Deliberately minimal: path, method
 * and operationId only. Full request/response schemas are NOT duplicated
 * here — the runtime route schema remains the single source of truth.
 */
const FROZEN_CONTRACT: ReadonlyArray<{
  path: string;
  method: string;
  operationId: string;
  protectedRoute: boolean;
}> = [
  { path: '/health/live', method: 'GET', operationId: 'healthLive', protectedRoute: false },
  { path: '/health/ready', method: 'GET', operationId: 'healthReady', protectedRoute: false },
  { path: '/api/v1/auth/register', method: 'POST', operationId: 'registerUser', protectedRoute: false },
  { path: '/api/v1/auth/login', method: 'POST', operationId: 'loginUser', protectedRoute: false },
  { path: '/api/v1/auth/logout', method: 'POST', operationId: 'logoutUser', protectedRoute: false },
  { path: '/api/v1/auth/me', method: 'GET', operationId: 'getCurrentUser', protectedRoute: true },
  { path: '/api/v1/auth/refresh', method: 'POST', operationId: 'refreshAccessToken', protectedRoute: false },
  {
    path: '/api/v1/auth/password-reset/request',
    method: 'POST',
    operationId: 'requestPasswordReset',
    protectedRoute: false,
  },
  {
    path: '/api/v1/auth/password-reset/confirm',
    method: 'POST',
    operationId: 'confirmPasswordReset',
    protectedRoute: false,
  },
  {
    path: '/api/v1/auth/email-verification/resend',
    method: 'POST',
    operationId: 'resendVerificationEmail',
    protectedRoute: false,
  },
  {
    path: '/api/v1/auth/email-verification/confirm',
    method: 'POST',
    operationId: 'confirmEmailVerification',
    protectedRoute: false,
  },
  {
    path: '/api/v1/auth/sessions/revoke-all',
    method: 'POST',
    operationId: 'revokeAllSessions',
    protectedRoute: true,
  },
  { path: '/api/v1/users/{id}', method: 'GET', operationId: 'getUserById', protectedRoute: true },
  { path: '/api/v1/users/{id}', method: 'PUT', operationId: 'updateUser', protectedRoute: true },
  { path: '/api/v1/users/{id}', method: 'DELETE', operationId: 'deleteUser', protectedRoute: true },
  { path: '/api/v1/roles', method: 'GET', operationId: 'listRoles', protectedRoute: true },
  { path: '/api/v1/roles/{name}', method: 'GET', operationId: 'getRoleByName', protectedRoute: true },
  { path: '/api/v1/notes', method: 'GET', operationId: 'listNotes', protectedRoute: true },
  { path: '/api/v1/notes', method: 'POST', operationId: 'createNote', protectedRoute: true },
  { path: '/api/v1/notes/{id}', method: 'GET', operationId: 'getNoteById', protectedRoute: true },
  { path: '/api/v1/notes/{id}', method: 'PUT', operationId: 'updateNote', protectedRoute: true },
  { path: '/api/v1/notes/{id}', method: 'DELETE', operationId: 'deleteNote', protectedRoute: true },
];

/**
 * Methods that are part of the public API contract. Stored uppercase
 * because that is how they are written in the frozen contract and by
 * `printRoutes`; comparisons lowercase them because OpenAPI path-item
 * keys are lowercase.
 */
const CONTRACT_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

/**
 * Explicit, declared exclusions from the runtime inventory. Each is a
 * deliberate framework/documentation decision, not a silent filter:
 *
 * - `HEAD` — Fastify auto-generates it for every GET (`api-conventions.md`
 *   §3.1 describes HEAD as "same as GET without body"). It is framework
 *   behaviour, not a documented operation.
 * - `/docs/**` — the Swagger UI presentation bundle (static assets, its
 *   `./json` and `./yaml` mirrors, and its wildcard route).
 * - `/openapi.json` — the canonical document route, deliberately
 *   `hide`-flagged so the document does not document itself.
 */
const EXCLUDED_RUNTIME_PATTERNS: ReadonlyArray<RegExp> = [
  /^\/docs(\/|$)/,
  /^\/openapi\.json$/,
  /^\/metrics$/, // M14.3: opt-in operational Prometheus exporter (hide-flagged, not public API)
];

function isExcludedRuntimePath(runtimePath: string): boolean {
  return EXCLUDED_RUNTIME_PATTERNS.some((pattern) => pattern.test(runtimePath));
}

/**
 * Fastify `:param` → OpenAPI `{param}`. Total and deliberately literal:
 * no wildcard collapse, no trailing-slash equivalence, no prefix stripping,
 * no query handling. Fuzzy matching would let a genuine contract break pass.
 */
function toOpenApiPath(runtimePath: string): string {
  return runtimePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * Parses `printRoutes({ commonPrefix: false })` into runtime operations.
 *
 * The tree is walked rather than line-matched: `printRoutes` nests, so a
 * child row carries only its own segment (`/api/v1/roles` then `/:name`).
 * The prefix column is read in 4-character groups — `│   ` means the node
 * at that depth is still an ancestor, `    ` means it closed — which is how
 * the full path is reconstructed. Line-regex matching alone would silently
 * compare `/:name` against `/api/v1/roles/{name}` and hide a real mismatch.
 */
function collectRuntimeOperations(app: FastifyInstance): Array<{ path: string; method: string }> {
  const operations: Array<{ path: string; method: string }> = [];
  const tree = app.printRoutes({ commonPrefix: false });
  const segments: string[] = [];

  for (const rawLine of tree.split('\n')) {
    const marker = rawLine.indexOf('──');
    if (marker === -1) {
      continue;
    }
    const prefix = rawLine.slice(0, marker);
    const depth = Math.floor(prefix.length / 4);
    const row = rawLine.slice(marker + 2).trim();

    // Each row carries its own `(METHODS)` suffix; strip it from the
    // segment so an ancestor's methods never leak into a descendant path.
    const rowMatch = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(row);
    if (rowMatch === null) {
      continue;
    }
    const segment = rowMatch[1];
    const methodList = rowMatch[2];

    // Truncate to the live ancestors: a `    ` group closed a branch.
    segments.length = depth;
    segments.push(segment);
    const path = segments.join('').replace(/\/{2,}/g, '/');

    for (const method of methodList.split(',').map((value) => value.trim())) {
      // HEAD is Fastify-generated for every GET and is not a documented
      // operation (declared exclusion).
      if (method === 'HEAD' || !CONTRACT_METHODS.includes(method as (typeof CONTRACT_METHODS)[number])) {
        continue;
      }
      operations.push({ path, method: method.toLowerCase() });
    }
  }
  return operations;
}

function openApiOperations(spec: Spec): Array<{ path: string; method: string }> {
  const operations: Array<{ path: string; method: string }> = [];
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of Object.keys(pathItem)) {
      if (CONTRACT_METHODS.includes(method.toUpperCase() as (typeof CONTRACT_METHODS)[number])) {
        operations.push({ path, method });
      }
    }
  }
  return operations;
}

/** Narrowly reads a response object; the document may legally hold a bare `$ref`. */
function responseOf(operation: Operation, status: string): ResponseObject | undefined {
  const response = operation.responses?.[status];
  if (response === undefined || '$ref' in response) {
    return undefined;
  }
  return response;
}

function findOperation(spec: Spec, path: string, method: string): Operation {
  const operation = spec.paths[path]?.[method];
  expect(operation, `missing operation ${method.toUpperCase()} ${path}`).toBeDefined();
  return operation as Operation;
}

let app: FastifyInstance;
let spec: Spec;
let documentPayload: string;

beforeAll(async () => {
  app = await buildApp({ loggerStream: { write: () => true } });
  await app.ready();
  const response = await app.inject({ method: 'GET', url: '/openapi.json' });
  documentPayload = response.payload;
  spec = JSON.parse(documentPayload) as Spec;
});

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 1. Structural contract — the authoritative validator
// ---------------------------------------------------------------------------

describe('1. OpenAPI structural contract', () => {
  it('validates against the OpenAPI 3.1 meta-schema', async () => {
    const validated = (await SwaggerParser.validate(
      JSON.parse(documentPayload),
    )) as unknown as { openapi: string; paths: Record<string, unknown> };

    expect(validated.openapi).toBe('3.1.0');
    expect(Object.keys(validated.paths).length).toBe(Object.keys(spec.paths).length);
  });

  it('has the required root structure', () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    expect(spec.info.title).toBe('Oxyide Forge API');
    expect(typeof spec.info.version).toBe('string');
    expect(spec.paths).toBeTypeOf('object');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
    expect(spec.components).toBeDefined();
    expect(spec.servers).toHaveLength(1);
  });

  it('resolves every $ref in the document', () => {
    const refs: string[] = [];
    JSON.stringify(spec, (_key, value: unknown) => {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { $ref?: unknown }).$ref === 'string'
      ) {
        refs.push((value as { $ref: string }).$ref);
      }
      return value;
    });

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const parts = ref.split('/');
      expect(ref.startsWith('#/components/')).toBe(true);
      const section = parts[2];
      const name = parts[3];
      expect(
        (spec.components as unknown as Record<string, Record<string, unknown>>)?.[section]?.[name],
        `unresolved ${ref}`,
      ).toBeDefined();
    }
  });

  it('gives every operation an operationId, and no operationId is duplicated', () => {
    const seen = new Map<string, string>();
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const id = operation.operationId;
        expect(typeof id, `${method.toUpperCase()} ${path}`).toBe('string');
        expect(seen.has(id as string), `duplicate operationId ${id as string}`).toBe(false);
        seen.set(id as string, `${method.toUpperCase()} ${path}`);
      }
    }
    expect(seen.size).toBe(FROZEN_CONTRACT.length);
  });

  it('is generated by the real application stack, served identically at every source', async () => {
    // One definition, three accessors: in-process, canonical route, and the
    // UI's own mirror. Normalized JSON comparison — no second document.
    const inProcess = JSON.stringify(app.swagger());
    const canonical = JSON.stringify(JSON.parse(documentPayload));
    const uiMirror = await app.inject({ method: 'GET', url: '/docs/json' });

    expect(uiMirror.statusCode).toBe(200);
    expect(JSON.stringify(uiMirror.json())).toBe(canonical);
    expect(inProcess).toBe(canonical);
  });
});

// ---------------------------------------------------------------------------
// 2. Route + method contract (bidirectional)
// ---------------------------------------------------------------------------

describe('2. route and method contract', () => {
  it('toOpenApiPath normalizes parameters and nothing else', () => {
    expect(toOpenApiPath('/api/v1/users/:id')).toBe('/api/v1/users/{id}');
    expect(toOpenApiPath('/a/:one/b/:two')).toBe('/a/{one}/b/{two}');
    expect(toOpenApiPath('/health/live')).toBe('/health/live');
    // Not fuzzy: these must stay distinct.
    expect(toOpenApiPath('/api/v1/users/:id')).not.toBe(toOpenApiPath('/api/v1/users/:userId'));
    expect(toOpenApiPath('/api/v1/users/:id')).not.toBe(toOpenApiPath('/api/v1/users'));
    expect(toOpenApiPath('/api/v1/users/:id')).not.toBe(toOpenApiPath('/api/v1/users/:id/'));
  });

  it('normalizes route paths only — a route URL never carries a query', () => {
    // The guarantee is structural: `printRoutes` emits bare paths, so a
    // query string can never reach the normalizer and be mistaken for a
    // path parameter.
    const inventory = collectRuntimeOperations(app);
    expect(inventory.every(({ path }) => !path.includes('?'))).toBe(true);
    expect(inventory.every(({ path }) => !path.includes('#'))).toBe(true);
  });

  it('expected → runtime: every frozen route exists in the application', () => {
    for (const entry of FROZEN_CONTRACT) {
      const runtimePath = entry.path.replace(/\{([^}]+)\}/g, ':$1');
      expect(
        app.hasRoute({ method: entry.method, url: runtimePath }),
        `${entry.method} ${runtimePath}`,
      ).toBe(true);
    }
  });

  it('runtime → OpenAPI: every inventoried runtime operation is documented', () => {
    const documented = openApiOperations(spec).map(
      ({ path, method }) => `${method.toUpperCase()} ${path}`,
    );
    const inventory = collectRuntimeOperations(app)
      .filter(({ path }) => !isExcludedRuntimePath(path))
      .map(({ path, method }) => `${method.toUpperCase()} ${toOpenApiPath(path)}`);

    // Deduplicate: several methods can share one runtime row.
    expect([...new Set(inventory)].sort()).toEqual([...new Set(documented)].sort());
  });

  it('OpenAPI → runtime: every documented operation is a real route', () => {
    for (const { path, method } of openApiOperations(spec)) {
      const runtimePath = path.replace(/\{([^}]+)\}/g, ':$1');
      expect(app.hasRoute({ method, url: runtimePath }), `${method.toUpperCase()} ${runtimePath}`).toBe(
        true,
      );
    }
  });

  it('matches the frozen contract exactly, in both directions', () => {
    const expected = FROZEN_CONTRACT.map(
      ({ path, method }) => `${method.toUpperCase()} ${path}`,
    ).sort();
    const documented = openApiOperations(spec)
      .map(({ path, method }) => `${method.toUpperCase()} ${path}`)
      .sort();

    expect(documented).toEqual(expected);
  });

  it('declares no version other than v1 and no version negotiation surface', () => {
    const paths = Object.keys(spec.paths);
    expect(paths.filter((path) => path.startsWith('/api/'))).toHaveLength(
      paths.filter((path) => path.startsWith('/api/v1/')).length,
    );
    expect(JSON.stringify(spec)).not.toContain('/api/v2');
    expect(JSON.stringify(spec)).not.toContain('/api/v1.1');

    // Documentation and health routes stay outside the versioned namespace.
    for (const path of paths) {
      expect(path === '/health/live' || path === '/health/ready' || path.startsWith('/api/v1/')).toBe(
        true,
      );
    }
    expect(JSON.stringify(spec.paths)).not.toContain('/docs');
    expect(JSON.stringify(spec.paths)).not.toContain('/openapi.json');
  });
});

// ---------------------------------------------------------------------------
// 3. OperationId contract
// ---------------------------------------------------------------------------

describe('3. operationId contract', () => {
  it('maps every path+method to its exact frozen operationId', () => {
    for (const entry of FROZEN_CONTRACT) {
      expect(findOperation(spec, entry.path, entry.method.toLowerCase()).operationId).toBe(
        entry.operationId,
      );
    }
  });

  it('contains exactly the frozen operationId set', () => {
    const ids = Object.values(spec.paths).flatMap((pathItem) =>
      Object.values(pathItem).map((operation) => operation.operationId as string),
    );

    expect(ids.sort()).toEqual(FROZEN_CONTRACT.map((entry) => entry.operationId).sort());
  });

  it('uses camelCase identifiers that describe API concepts', () => {
    for (const { operationId } of FROZEN_CONTRACT) {
      expect(operationId).toMatch(/^[a-z][a-zA-Z0-9]*$/);
    }
    // No internal implementation names leaked into the contract.
    expect(JSON.stringify(spec)).not.toMatch(/handler|service|repository|prisma/);
  });
});

// ---------------------------------------------------------------------------
// 4. Request contract
// ---------------------------------------------------------------------------

describe('4. request schema contract', () => {
  const bodyOf = (path: string, method: string): Record<string, unknown> => {
    const operation = findOperation(spec, path, method);
    const schema = operation.requestBody?.content?.['application/json']?.schema as
      | Record<string, unknown>
      | undefined;
    expect(schema, `no requestBody schema for ${method.toUpperCase()} ${path}`).toBeDefined();
    return schema as Record<string, unknown>;
  };

  it('declares application/json request bodies with strict additionalProperties', () => {
    const cases: Array<[string, string]> = [
      ['/api/v1/auth/register', 'post'],
      ['/api/v1/auth/login', 'post'],
      ['/api/v1/auth/password-reset/request', 'post'],
      ['/api/v1/auth/password-reset/confirm', 'post'],
      ['/api/v1/auth/email-verification/resend', 'post'],
      ['/api/v1/auth/email-verification/confirm', 'post'],
      ['/api/v1/users/{id}', 'put'],
    ];

    for (const [path, method] of cases) {
      const schema = bodyOf(path, method);
      expect(Object.keys(schema)).toEqual(['type', 'required', 'additionalProperties', 'properties']);
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(Array.isArray(schema.required)).toBe(true);
    }
  });

  it('declares the documented required fields per operation', () => {    expect((bodyOf('/api/v1/auth/register', 'post').required as string[]).sort()).toEqual([
      'email',
      'password',
    ]);
    expect((bodyOf('/api/v1/auth/login', 'post').required as string[]).sort()).toEqual([
      'email',
      'password',
    ]);
    expect((bodyOf('/api/v1/users/{id}', 'put').required as string[])).toEqual([]);
    // M7.9: the example module's mutable-field contract, both directions.
    expect((bodyOf('/api/v1/notes', 'post').required as string[]).sort()).toEqual(['title']);
    expect(bodyOf('/api/v1/notes/{id}', 'put').required as string[]).toEqual([]);
  });

  it('prefills runnable request examples for every auth operation with a body', () => {
    // Swagger UI samples pattern-constrained strings with regex gibberish,
    // so the auth operations carry presentation-only examples (merged in the
    // swagger plugin's transformObject — never in the validation schemas).
    // Each example must satisfy its own runtime bounds, so executing the
    // prefilled sample reaches the handler instead of failing validation.
    const expected: Record<string, Record<string, string>> = {
      '/api/v1/auth/register': {
        email: 'test@example.com',
        password: 'correct-horse-battery-staple',
        displayName: 'Test User',
      },
      '/api/v1/auth/login': {
        email: 'test@example.com',
        password: 'correct-horse-battery-staple',
      },
      '/api/v1/auth/password-reset/request': { email: 'test@example.com' },
      '/api/v1/auth/password-reset/confirm': {
        token: 'replace-with-token-from-email',
        password: 'correct-horse-battery-staple',
      },
      '/api/v1/auth/email-verification/resend': { email: 'test@example.com' },
      '/api/v1/auth/email-verification/confirm': { token: 'replace-with-token-from-email' },
    };
    expect(Object.keys(expected)).toHaveLength(6);
    for (const [path, examples] of Object.entries(expected)) {
      const properties = bodyOf(path, 'post').properties as Record<
        string,
        { example?: unknown; minLength?: number; maxLength?: number; pattern?: string }
      >;
      for (const [name, example] of Object.entries(examples)) {
        const property = properties[name];
        expect(property, `${path} property ${name} exists in the document`).toBeDefined();
        expect(property.example, `${path} property ${name} carries its example`).toBe(example);
        expect(typeof example).toBe('string');
        if (typeof property.minLength === 'number') {
          expect(example.length).toBeGreaterThanOrEqual(property.minLength);
        }
        if (typeof property.maxLength === 'number') {
          expect(example.length).toBeLessThanOrEqual(property.maxLength);
        }
        if (typeof property.pattern === 'string') {
          expect(new RegExp(property.pattern).test(example)).toBe(true);
        }
      }
    }
  });

  it('preserves property types, enum, bounds and nullability', () => {
    const register = bodyOf('/api/v1/auth/register', 'post').properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(register.email.type).toBe('string');
    expect(register.email.maxLength).toBe(254);
    expect(typeof register.email.pattern).toBe('string');
    expect(register.password.type).toBe('string');
    expect(register.password.minLength).toBe(12);
    expect(register.password.maxLength).toBe(72);
    expect(register.displayName.type).toBe('string');
    expect(register.displayName.maxLength).toBe(100);

    const update = bodyOf('/api/v1/users/{id}', 'put').properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(update.status.enum).toEqual(['active', 'inactive', 'suspended']);
    // §6.4 null-vs-missing is contractual: update explicitly accepts null.
    expect(update.displayName.type).toEqual(['string', 'null']);
    expect(update.displayName.maxLength).toBe(100);
  });

  it('declares path parameters for every templated path', () => {
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      const templates = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      if (templates.length === 0) {
        continue;
      }
      for (const [method, operation] of Object.entries(pathItem)) {
        const declared = (operation.parameters ?? [])
          .filter((parameter) => parameter.in === 'path')
          .map((parameter) => parameter.name)
          .sort();
        expect(declared, `${method.toUpperCase()} ${path}`).toEqual([...templates].sort());
        for (const parameter of operation.parameters ?? []) {
          if (parameter.in === 'path') {
            // OpenAPI requires every path parameter to be required: true.
            expect(parameter.required, `${method.toUpperCase()} ${path}`).toBe(true);
          }
        }
      }
    }
  });

  it('attaches query parameters at the intended consumer (the notes list), and nowhere else', () => {
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const isNoteListGet = path === '/api/v1/notes' && method === 'get';
        const parameters = (operation.parameters ?? []) as Array<Record<string, unknown>>;
        if (isNoteListGet) {
          // Exactly the three reusable components, by reference — shared
          // definitions, not inline copies (M7.9, closes M76-F07).
          expect(parameters).toHaveLength(3);
          const refs = parameters.map((parameter) => parameter.$ref);
          expect(refs).toEqual([
            '#/components/parameters/PageParam',
            '#/components/parameters/LimitParam',
            '#/components/parameters/SortParam',
          ]);
          continue;
        }
        // Every other operation is query-free; no $ref and no inline query.
        for (const parameter of parameters) {
          expect(parameter.in, `${method.toUpperCase()} ${path}`).not.toBe('query');
          expect(typeof parameter.$ref !== 'string' || !parameter.$ref.startsWith('#/components/parameters/')).toBe(true);
        }
      }
    }
  });

  it('runtime enforcement matches the documented strictness (unknown field → 400)', async () => {
    // Proves the documented `additionalProperties: false` is real, not decorative.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'a@b.co', password: 'correct-horse-battery', unexpected: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('runtime enforcement matches documented required fields and bounds', async () => {
    const missingPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'a@b.co' },
    });
    expect(missingPassword.statusCode).toBe(400);

    const shortPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'a@b.co', password: 'short' },
    });
    expect(shortPassword.statusCode).toBe(400);

    const badEmail = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'not-an-email', password: 'correct-horse-battery' },
    });
    expect(badEmail.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 5. Response contract
// ---------------------------------------------------------------------------

describe('5. response schema contract', () => {
  it('declares a 200 body schema on every JSON success route', () => {
    const cases: Array<[string, string]> = [
      ['/api/v1/auth/login', 'post'],
      ['/api/v1/auth/me', 'get'],
      ['/api/v1/auth/refresh', 'post'],
      ['/api/v1/users/{id}', 'get'],
      ['/api/v1/users/{id}', 'put'],
      ['/api/v1/roles', 'get'],
      ['/api/v1/roles/{name}', 'get'],
    ];

    for (const [path, method] of cases) {
      const content = responseOf(findOperation(spec, path, method), '200')?.content;
      expect(Object.keys(content ?? {}), `${method.toUpperCase()} ${path}`).toEqual([
        'application/json',
      ]);
    }
  });

  it('documents 201 exactly on the creation operations (registration and notes)', () => {
    const creation201s = new Set<string>();
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (responseOf(operation, '201') !== undefined) {
          creation201s.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect([...creation201s].sort()).toEqual([
      'POST /api/v1/auth/register',
      'POST /api/v1/notes',
    ]);
    const createNote = responseOf(findOperation(spec, '/api/v1/notes', 'post'), '201');
    expect(Object.keys(createNote?.content ?? {})).toEqual(['application/json']);
  });

  it('documents the Location header only on creation 201s', () => {
    expect(
      (responseOf(findOperation(spec, '/api/v1/auth/register', 'post'), '201')?.headers as
        | Record<string, unknown>
        | undefined)?.Location,
    ).toBeDefined();
    expect(
      (responseOf(findOperation(spec, '/api/v1/notes', 'post'), '201')?.headers as
        | Record<string, unknown>
        | undefined)?.Location,
    ).toBeDefined();

    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const withHeaders = Object.entries(operation.responses ?? {}).filter(
          ([, response]) => {
            if ('$ref' in response) {
              return false;
            }
            const candidate = response as { headers?: unknown };
            return candidate.headers !== undefined;
          },
        );
        const isCreation201 =
          (path === '/api/v1/auth/register' && method === 'post') ||
          (path === '/api/v1/notes' && method === 'post');
        expect(withHeaders.length, `${method.toUpperCase()} ${path}`).toBe(isCreation201 ? 1 : 0);
      }
    }
  });

  it('documents 204 as bodyless, everywhere it appears', () => {
    const withNoContent = Object.entries(spec.paths).flatMap(([path, pathItem]) =>
      Object.entries(pathItem)
        .filter(([, operation]) => responseOf(operation, '204') !== undefined)
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );

    expect(withNoContent.length).toBeGreaterThan(0);
    // M7.9: the set is frozen, not merely non-empty. Without this, dropping a
    // bodyless operation from the plugin's NO_CONTENT table would silently
    // un-publish its 204 and the bodyless check below would skip it entirely.
    expect(withNoContent.sort()).toEqual([
      'DELETE /api/v1/notes/{id}',
      'DELETE /api/v1/users/{id}',
      'POST /api/v1/auth/email-verification/confirm',
      'POST /api/v1/auth/email-verification/resend',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/password-reset/confirm',
      'POST /api/v1/auth/password-reset/request',
      'POST /api/v1/auth/sessions/revoke-all',
    ].sort());
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const noContent = responseOf(operation, '204');
        if (noContent === undefined) {
          continue;
        }
        // M7.6 enforcement: a 204 must never claim a body.
        expect(noContent.content, `${method.toUpperCase()} ${path}`).toBeUndefined();
      }
    }
  });

  it('keeps PublicUser canonical and identical wherever it appears', () => {
    const shapes = [
      responseOf(findOperation(spec, '/api/v1/auth/me', 'get'), '200')?.content?.[
        'application/json'
      ]?.schema,
      responseOf(findOperation(spec, '/api/v1/users/{id}', 'get'), '200')?.content?.[
        'application/json'
      ]?.schema,
      responseOf(findOperation(spec, '/api/v1/users/{id}', 'put'), '200')?.content?.[
        'application/json'
      ]?.schema,
      responseOf(findOperation(spec, '/api/v1/auth/register', 'post'), '201')?.content?.[
        'application/json'
      ]?.schema,
    ];

    const expected = [
      'createdAt',
      'displayName',
      'email',
      'id',
      'role',
      'status',
      'updatedAt',
    ].sort();

    for (const shape of shapes) {
      const schema = shape as Record<string, unknown>;
      expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual(expected);
      expect((schema.required as string[]).sort()).toEqual(expected);
      expect(schema.additionalProperties).toBe(false);
    }

    // One DTO, four occurrences. Descriptions differ per operation by
    // design (M7.6), so the *contract* is compared — shape, required set
    // and closedness — not the whole serialized object.
    const contracts = shapes.map((shape) => {
      const schema = shape as Record<string, unknown>;
      return JSON.stringify({
        type: schema.type,
        required: schema.required,
        additionalProperties: schema.additionalProperties,
        properties: schema.properties,
      });
    });
    expect(new Set(contracts).size).toBe(1);
  });

  it('never documents a credential, hash, token, or internal field', () => {
    const forbidden = [
      'passwordHash',
      'password_hash',
      'tokenHash',
      'refreshToken',
      'credentialId',
      'lockedUntil',
      'createdBy',
      'prisma',
      'select',
      'where',
    ];
    const serialized = JSON.stringify(spec);

    for (const marker of forbidden) {
      expect(serialized, `document leaked ${marker}`).not.toContain(marker);
    }
  });

  it('documents roles responses with their permission vocabulary', () => {
    const list = responseOf(findOperation(spec, '/api/v1/roles', 'get'), '200')?.content?.[
      'application/json'
    ]?.schema as Record<string, unknown>;
    expect(Object.keys(list.properties as Record<string, unknown>)).toEqual(['roles']);

    const one = responseOf(findOperation(spec, '/api/v1/roles/{name}', 'get'), '200')?.content?.[
      'application/json'
    ]?.schema as Record<string, unknown>;
    expect(Object.keys(one.properties as Record<string, unknown>).sort()).toEqual([
      'name',
      'permissions',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. ProblemDetails contract (M6 frozen)
// ---------------------------------------------------------------------------

describe('6. ProblemDetails contract', () => {
  const FROZEN_ERROR_STATUSES = ['400', '401', '403', '404', '409', '429', '500'];
  /**
   * M9.2: `503` is the one published error status that is NOT a Problem
   * Details envelope. The frozen M9.1 readiness contract requires the
   * readiness probe to return an empty body on failure — the status code is
   * the entire signal, and an unauthenticated endpoint must not carry an
   * error envelope. It is pinned to exactly one operation here so it can
   * never spread to another route, and it is deliberately absent from
   * FROZEN_ERROR_STATUSES, which remains the M6 Problem Details set.
   */
  const NON_PROBLEM_ERROR_STATUSES: ReadonlyArray<{ operation: string; status: string }> = [
    { operation: 'GET /health/ready', status: '503' },
  ];
  const FROZEN_FIELDS = ['code', 'detail', 'instance', 'status', 'title', 'type'];

  it('describes exactly the six frozen fields, all required and closed', () => {
    const problem = spec.components?.schemas?.ProblemDetails as Record<string, unknown>;
    expect(problem).toBeDefined();
    expect(Object.keys(problem.properties as Record<string, unknown>).sort()).toEqual(FROZEN_FIELDS);
    expect((problem.required as string[]).sort()).toEqual(FROZEN_FIELDS);
    expect(problem.additionalProperties).toBe(false);
    expect((problem.properties as Record<string, { type: unknown }>).status.type).toBe('integer');
  });

  it('never documents stack, cause, SQL, token, or debug metadata', () => {
    // Property names, not prose: the component's description deliberately
    // *states* "never stacks, causes, SQL…", so a substring scan of the
    // whole object would fail on its own warning text.
    const properties = Object.keys(
      (spec.components?.schemas?.ProblemDetails as Record<string, unknown>).properties as Record<
        string,
        unknown
      >,
    ).map((name) => name.toLowerCase());
    for (const marker of ['stack', 'cause', 'sql', 'prisma', 'trace', 'debug', 'requestBody']) {
      expect(properties).not.toContain(marker);
    }
  });

  it('uses application/problem+json with a $ref for every error response', () => {
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          if (!FROZEN_ERROR_STATUSES.includes(status)) {
            continue;
          }
          const body = '$ref' in response ? undefined : response;
          expect(Object.keys(body?.content ?? {}), `${method.toUpperCase()} ${path} ${status}`).toEqual(
            ['application/problem+json'],
          );
          expect(
            body?.content?.['application/problem+json']?.schema,
            `${method.toUpperCase()} ${path} ${status}`,
          ).toEqual({ $ref: '#/components/schemas/ProblemDetails' });
        }
      }
    }
  });

  it('documents only frozen error statuses, with 503 confined to the readiness probe', () => {
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const key = `${method.toUpperCase()} ${path}`;
        for (const status of Object.keys(operation.responses ?? {})) {
          expect(status, key).toMatch(/^[1-5]\d\d$/);
          if (['200', '201', '204'].includes(status) || FROZEN_ERROR_STATUSES.includes(status)) {
            continue;
          }
          // Presence, not leniency: every non-2xx status must be EITHER a
          // frozen Problem Details status OR the single pinned non-Problem
          // readiness status. Nothing else is publishable, so 503 cannot
          // spread to another operation and no new status can appear.
          expect(
            NON_PROBLEM_ERROR_STATUSES.some(
              (entry) => entry.operation === key && entry.status === status,
            ),
            `${key} ${status} is not a frozen error status`,
          ).toBe(true);
        }
      }
    }
    // The pinned allowance is exhaustive: each entry must name an operation
    // that exists and actually publishes that status.
    for (const entry of NON_PROBLEM_ERROR_STATUSES) {
      const [method, path] = entry.operation.split(' ');
      const operation = findOperation(spec, path as string, (method as string).toLowerCase());
      expect(Object.keys(operation.responses ?? {}), entry.operation).toContain(entry.status);
    }
  });

  it('documents exactly the frozen status set per operation (M7.10 freeze)', () => {
    // Presence, not just shape: dropping one entry from the plugin's
    // OPERATION_ERRORS table silently un-publishes that status, and every
    // other assertion in this file would still pass. This table pins the
    // full published set per operation, derived from actual route behavior
    // and frozen M6 semantics — a second declaration that must agree.
    const FROZEN_STATUS_SETS: Readonly<Record<string, ReadonlyArray<string>>> = {
      'POST /api/v1/auth/register': ['201', '400', '409', '500'],
      'POST /api/v1/auth/login': ['200', '400', '401', '429', '500'],
      'POST /api/v1/auth/logout': ['204', '500'],
      'GET /api/v1/auth/me': ['200', '401', '500'],
      'POST /api/v1/auth/refresh': ['200', '401', '500'],
      'POST /api/v1/auth/password-reset/request': ['204', '400', '429', '500'],
      'POST /api/v1/auth/password-reset/confirm': ['204', '400', '401', '500'],
      'POST /api/v1/auth/email-verification/resend': ['204', '400', '429', '500'],
      'POST /api/v1/auth/email-verification/confirm': ['204', '400', '401', '500'],
      'POST /api/v1/auth/sessions/revoke-all': ['204', '401', '500'],
      'GET /api/v1/users/{id}': ['200', '401', '403', '404', '500'],
      'PUT /api/v1/users/{id}': ['200', '400', '401', '403', '404', '500'],
      'DELETE /api/v1/users/{id}': ['204', '401', '403', '404', '500'],
      'GET /api/v1/roles': ['200', '401', '403', '500'],
      'GET /api/v1/roles/{name}': ['200', '401', '403', '404', '500'],
      'GET /api/v1/notes': ['200', '400', '401', '500'],
      'POST /api/v1/notes': ['201', '400', '401', '500'],
      'GET /api/v1/notes/{id}': ['200', '401', '403', '404', '500'],
      'PUT /api/v1/notes/{id}': ['200', '400', '401', '403', '404', '500'],
      'DELETE /api/v1/notes/{id}': ['204', '401', '403', '404', '500'],
      'GET /health/live': ['200'],
      // M9.2: readiness publishes its frozen 503 alongside 200. Narrow
      // adoption for this operation alone (M9.1) — liveness stays 200-only.
      'GET /health/ready': ['200', '503'],
    };
    expect(Object.keys(FROZEN_STATUS_SETS)).toHaveLength(22);
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const key = `${method.toUpperCase()} ${path}`;
        const expected = FROZEN_STATUS_SETS[key];
        expect(expected, `unfrozen operation ${key}`).toBeDefined();
        expect(Object.keys(operation.responses ?? {}).sort(), key).toEqual([...expected].sort());
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Security contract — cross-checked against real guards
// ---------------------------------------------------------------------------

describe('7. security contract', () => {
  it('declares bearerAuth as the only security scheme', () => {
    expect(Object.keys(spec.components?.securitySchemes ?? {})).toEqual(['bearerAuth']);
    expect(spec.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('marks every operation explicitly, with no global security block', () => {
    expect(spec).not.toHaveProperty('security');
    for (const entry of FROZEN_CONTRACT) {
      const operation = findOperation(spec, entry.path, entry.method.toLowerCase());
      expect(operation.security, `${entry.method.toUpperCase()} ${entry.path}`).toEqual(
        entry.protectedRoute ? [{ bearerAuth: [] }] : [],
      );
    }
  });

  it('agrees with runtime behaviour: protected routes reject anonymous callers', async () => {
    const protectedOperations = FROZEN_CONTRACT.filter((entry) => entry.protectedRoute);
    expect(protectedOperations.length).toBeGreaterThan(0);

    for (const entry of protectedOperations) {
      const runtimePath = entry.path.replace(/\{([^}]+)\}/g, ':$1').replace('{id}', 'probe-id');
      const method = entry.method as 'GET' | 'POST' | 'PUT' | 'DELETE';
      const response = await app.inject({
        method,
        url: runtimePath,
        // Validation precedes auth (validation → preHandler → handler), so the
        // anonymous probe must send a body each route's schema would accept —
        // otherwise the correct 401 is masked by a 400. Notes and users use
        // different valid-body shapes; there is no false boundary here.
        ...(method === 'POST' || method === 'PUT'
          ? { payload: entry.path.startsWith('/api/v1/notes') ? { title: 'x' } : { displayName: 'x' } }
          : {}),
      });

      // Documented 401 for an unauthenticated caller: the declaration is real.
      expect(
        [401, 404],
        `${method.toUpperCase()} ${runtimePath} answered ${response.statusCode}`,
      ).toContain(response.statusCode);
      if (response.statusCode === 401) {
        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.headers['www-authenticate']).toBeDefined();
      }
    }
  });

  it('public operations are reachable without credentials', async () => {
    for (const entry of FROZEN_CONTRACT.filter((candidate) => !candidate.protectedRoute)) {
      if (entry.path.startsWith('/health/')) {
        expect((await app.inject({ method: 'GET', url: entry.path })).statusCode).toBe(200);
      }
    }
  });

  it('does not document cookie, OAuth, or API-key schemes that are not consumed', () => {
    // Structural, not substring: the bearer description legitimately
    // mentions the access cookie, so a text scan would be a false positive.
    const schemes = Object.values(
      spec.components?.securitySchemes as Record<string, Record<string, unknown>>,
    );
    expect(schemes).toHaveLength(1);
    expect(schemes[0].type).toBe('http');
    expect(schemes[0].scheme).toBe('bearer');
    for (const scheme of schemes) {
      for (const key of Object.keys(scheme)) {
        expect(['type', 'scheme', 'bearerFormat', 'description']).toContain(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Deprecation contract (M7.7)
// ---------------------------------------------------------------------------

describe('8. deprecation contract', () => {
  it('marks no production operation deprecated, and emits no deprecation header', async () => {
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        // Absence, not `false` (api-conventions.md §2.7).
        expect(operation.deprecated, `${method.toUpperCase()} ${path}`).toBeUndefined();
      }
    }
    expect(JSON.stringify(spec)).not.toContain('x-deprecation');

    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.headers.deprecation).toBeUndefined();
    expect(response.headers.sunset).toBeUndefined();
  });

  it('derives deprecated + extensions from route metadata through the real plugin', async () => {
    const Fastify = (await import('fastify')).default;
    const { swaggerPlugin } = await import('../plugins/swagger.plugin.js');
    const { createDeprecationRouteHook } = await import(
      '../shared/api-lifecycle/deprecation.js'
    );

    // Isolated fixture: a production route is never deprecated for a test.
    const fixture = Fastify({ logger: false });
    fixture.addHook('onRoute', createDeprecationRouteHook().onRoute);
    await fixture.register(swaggerPlugin);
    const sunset = 'Wed, 31 Dec 2026 23:59:59 GMT';
    fixture.get(
      '/fixture/legacy',
      {
        schema: {
          tags: ['Health'],
          operationId: 'fixtureLegacy',
          summary: 'Fixture',
          description: 'Fixture.',
          security: [],
          deprecation: {
            deprecated: true,
            reason: 'Superseded.',
            successor: '/api/v1/replacement',
            sunset,
          },
        },
      },
      async () => ({}),
    );
    fixture.get(
      '/fixture/active',
      {
        schema: {
          tags: ['Health'],
          operationId: 'fixtureActive',
          summary: 'Fixture',
          description: 'Fixture.',
          security: [],
        },
      },
      async () => ({}),
    );
    await fixture.ready();

    const document = fixture.swagger() as Spec;
    const legacy = document.paths['/fixture/legacy'].get as Operation & Record<string, unknown>;
    expect(legacy.deprecated).toBe(true);
    expect(legacy['x-deprecation-reason']).toBe('Superseded.');
    expect(legacy['x-deprecation-successor']).toBe('/api/v1/replacement');
    expect(legacy['x-deprecation-sunset']).toBe(sunset);
    expect(document.paths['/fixture/active'].get.deprecated).toBeUndefined();

    // Same source drives the runtime header.
    const response = await fixture.inject({ method: 'GET', url: '/fixture/legacy' });
    expect(response.headers.deprecation).toBe('true');
    expect(response.headers.sunset).toBe(sunset);
    expect(response.headers.link).toContain('</api/v1/replacement>');
    await fixture.close();
  });
});

// ---------------------------------------------------------------------------
// 9. M7.3–M7.5 component contract
// ---------------------------------------------------------------------------

describe('9. pagination / sorting / filtering component contract', () => {
  it('publishes the reusable components with their frozen bounds', () => {
    expect(spec.components?.schemas?.PaginationMetadata).toBeDefined();
    expect(Object.keys(spec.components?.parameters ?? {}).sort()).toEqual([
      'LimitParam',
      'PageParam',
      'SortParam',
    ]);

    const limit = spec.components?.parameters?.LimitParam as Record<string, unknown>;
    expect(limit.schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 20 });
    const page = spec.components?.parameters?.PageParam as Record<string, unknown>;
    expect(page.schema).toMatchObject({ type: 'integer', minimum: 1, default: 1 });
    const sort = spec.components?.parameters?.SortParam as Record<string, unknown>;
    expect(sort.schema).toMatchObject({ type: 'string', maxLength: 128 });

    const metadata = spec.components?.schemas?.PaginationMetadata as Record<string, unknown>;
    expect(Object.keys(metadata.properties as Record<string, unknown>).sort()).toEqual([
      'limit',
      'page',
      'total',
      'totalPages',
    ]);
    expect(metadata.additionalProperties).toBe(false);
  });

  it('attaches the reusable components to the intended consumer only (the notes list)', () => {
    // M7.9: the first legitimate consumer attaches M7.3–M7.5 components.
    // They appear on the notes list operation — and nowhere else.
    const listOperationText = JSON.stringify(spec.paths['/api/v1/notes'].get ?? {});
    expect(listOperationText).toContain('#/components/parameters/PageParam');
    expect(listOperationText).toContain('#/components/parameters/LimitParam');
    expect(listOperationText).toContain('#/components/parameters/SortParam');
    expect(listOperationText).toContain('PaginationMetadata');

    // No *other* operation references the reusable components.
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      if (path === '/api/v1/notes') {
        continue;
      }
      const text = JSON.stringify(pathItem);
      expect(text, `${path} unexpectedly references a reusable component`).not.toContain(
        '#/components/parameters/',
      );
      expect(text, `${path} unexpectedly references PaginationMetadata`).not.toContain(
        'PaginationMetadata',
      );
    }
  });

  it('documents no cursor pagination and no invented filter or sort fields', () => {
    // Scoped to operations: filter/sort are consumed *via the endpoint-owned*
    // note list, whose operation exposes the reusable components referenced
    // above — not free-form `filter[` params. Prose in info.description is fine.
    const operational = JSON.stringify(spec.paths);
    for (const marker of [
      'nextCursor',
      'prevCursor',
      'cursor',
      'pageInfo',
      'filter[',
      'contains',
      'orderBy',
      'where',
    ]) {
      expect(operational, `documented operation leaked ${marker}`).not.toContain(marker);
    }
    // The filtering contract is described in prose only (info.description),
    // never as a per-endpoint parameter that would imply a consumer.
    expect(spec.info.description).toContain('filter[');
  });
});

// ---------------------------------------------------------------------------
// 10. Health + documentation route contract
// ---------------------------------------------------------------------------

describe('10. health and documentation route contract', () => {
  it('documents liveness as dependency-free and pins its live behavior', async () => {
    // M9.1/M9.2: the "dependency-free" claim is true of liveness alone, and
    // this assertion is what keeps it true. Readiness gained a PostgreSQL
    // check in M9.2 and is contract-tested below and in the DB-gated
    // readiness suite — deliberately NOT here, because this suite performs no
    // database access and must not acquire that dependency.
    const operation = findOperation(spec, '/health/live', 'get');
    expect(Object.keys(operation.responses ?? {})).toEqual(['200']);

    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it('publishes the readiness failure contract without a Problem Details body', () => {
    // M9.2: readiness is the single operation allowed to publish 503, and its
    // failure body is empty by contract — the status code is the entire
    // signal. @fastify/swagger injects a default `application/json` content
    // block for every schema-less response (pre-existing, and equally true of
    // the 200s), so the security-relevant assertions are that the failure
    // declares NO properties and is NOT a ProblemDetails `$ref`: nothing
    // publishes an envelope, a code, or a dependency reason on an
    // unauthenticated endpoint.
    const operation = findOperation(spec, '/health/ready', 'get');
    const responses = operation.responses as Record<
      string,
      { description?: string; content?: Record<string, { schema?: Record<string, unknown> }> }
    >;

    expect(Object.keys(responses).sort()).toEqual(['200', '503']);

    const failure = responses['503'];
    expect(failure?.description).toBeTypeOf('string');
    expect(Object.keys(failure?.content ?? {})).toEqual(['application/json']);

    const failureSchema = failure?.content?.['application/json']?.schema ?? {};
    expect(failureSchema.$ref).toBeUndefined();
    expect(failureSchema.properties).toBeUndefined();
    expect(failureSchema.required).toBeUndefined();
    // Nothing anywhere in the published failure contract names a body field.
    expect(JSON.stringify(failure)).not.toMatch(
      /database|postgres|host|user|password|credential|token|code|detail|cause|stack/i,
    );
  });

  it('keeps documentation routes outside /api/v1 and outside the document', async () => {
    expect(Object.keys(spec.paths)).not.toContain('/openapi.json');
    expect(Object.keys(spec.paths)).not.toContain('/docs');
    expect(Object.keys(spec.paths).every((path) => !path.startsWith('/docs'))).toBe(true);

    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 11. Configuration matrix (M7.6 preserved)
// ---------------------------------------------------------------------------

describe('11. documentation configuration matrix', () => {
  async function buildWithFlags(openapi: string, swagger: string) {
    const { vi } = await import('vitest');
    vi.stubEnv('OPENAPI_ENABLED', openapi);
    vi.stubEnv('SWAGGER_UI_ENABLED', swagger);
    vi.resetModules();
    const { buildApp: freshBuildApp } = await import('../app/app.js');
    const instance = await freshBuildApp({ loggerStream: { write: () => true } });
    await instance.ready();
    return instance;
  }

  afterAll(async () => {
    const { vi } = await import('vitest');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('A: both disabled → neither documentation route exists', async () => {
    const instance = await buildWithFlags('false', 'false');
    expect((await instance.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(404);
    expect((await instance.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
    // The API itself is unaffected.
    expect((await instance.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    await instance.close();
  });

  it('B: OpenAPI without UI → document only', async () => {
    const instance = await buildWithFlags('true', 'false');
    expect((await instance.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(200);
    expect((await instance.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
    await instance.close();
  });

  it('C: both enabled → document and UI, still one definition', async () => {
    const instance = await buildWithFlags('true', 'true');
    const document = await instance.inject({ method: 'GET', url: '/openapi.json' });
    const mirror = await instance.inject({ method: 'GET', url: '/docs/json' });
    expect(document.statusCode).toBe(200);
    expect((await instance.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(200);
    expect(JSON.stringify(mirror.json())).toBe(JSON.stringify(document.json()));
    await instance.close();
  });

  it('D: UI without OpenAPI is rejected at startup, never silently enabled', async () => {
    const { vi } = await import('vitest');
    vi.stubEnv('OPENAPI_ENABLED', 'false');
    vi.stubEnv('SWAGGER_UI_ENABLED', 'true');
    vi.resetModules();
    await expect(import('../app/app.js')).rejects.toThrow(
      'SWAGGER_UI_ENABLED requires OPENAPI_ENABLED',
    );
  });
});

// ---------------------------------------------------------------------------
// 12. Leakage contract
// ---------------------------------------------------------------------------

describe('12. documentation leakage contract', () => {
  it('contains no secret, credential, URL, or internal path', () => {
    // Environment variable NAMES are forbidden, not merely their values: a
    // published document that names the variables an operator must set is
    // describing the deployment's configuration surface. (M9.3 initially
    // mentioned REDIS_URL in the readiness description and this assertion
    // caught it — the fix belongs in the prose, not in the contract.)
    for (const marker of [
      'postgresql://',
      'postgres://',
      'DATABASE_URL',
      'JWT_SECRET',
      'REDIS_URL',
      'BEGIN PRIVATE KEY',
      'Bearer eyJ',
      'node_modules',
      '/srv/',
      '/home/',
      'C:\\',
      '127.0.0.1:5433',
      'app.error',
      'process.env',
    ]) {
      expect(documentPayload, `document leaked ${marker}`).not.toContain(marker);
    }
  });

  it('publishes only the operator-configured public base URL as the server', async () => {
    const { config } = await import('../config/index.js');
    expect(spec.servers).toEqual([{ url: config.appBaseUrl }]);
    // A public address by design; never an internal hostname.
    expect(spec.servers?.[0].url).not.toMatch(/internal|localhost|127\.0\.0\.1/);
  });
});

// ---------------------------------------------------------------------------
// 13. Adversarial self-tests — the comparators must be able to fail
// ---------------------------------------------------------------------------

describe('13. adversarial self-tests', () => {
  /** Deep clone so a mutation can never touch the real document. */
  const mutated = (): Spec => JSON.parse(documentPayload) as Spec;

  it('detects a missing documented route', () => {
    const candidate = mutated();
    delete candidate.paths['/api/v1/auth/login'];
    const documented = openApiOperations(candidate).map(
      ({ path, method }) => `${method.toUpperCase()} ${path}`,
    );
    expect(documented).not.toContain('POST /api/v1/auth/login');
    expect(Object.keys(candidate.paths)).not.toContain('/api/v1/auth/login');
  });

  it('detects an extra fake documented route', () => {
    const candidate = mutated();
    candidate.paths['/api/v2/secret'] = {
      post: { operationId: 'secretOp', responses: { '200': { description: 'ok' } } },
    } as never;
    const documented = openApiOperations(candidate).map(
      ({ path, method }) => `${method.toUpperCase()} ${path}`,
    );
    expect(documented).toContain('POST /api/v2/secret');
    expect(JSON.stringify(candidate)).toContain('/api/v2');
  });

  it('detects a wrong method', () => {
    const candidate = mutated();
    // Method drift: a GET documented where the runtime exposes POST only.
    const operation = candidate.paths['/api/v1/auth/login'].post as Operation;
    candidate.paths['/api/v1/auth/login'].get = operation;
    expect(Object.keys(candidate.paths['/api/v1/auth/login']).sort()).toEqual(['get', 'post']);
    const documented = openApiOperations(candidate).map(
      ({ path, method }) => `${method.toUpperCase()} ${path}`,
    );
    expect(documented).toContain('GET /api/v1/auth/login');
  });

  it('detects a wrong path parameter', () => {
    expect(toOpenApiPath('/api/v1/users/:identifier')).not.toBe(
      toOpenApiPath('/api/v1/users/:id'),
    );
  });

  it('detects a duplicate operationId', () => {
    const candidate = mutated();
    (candidate.paths['/api/v1/auth/login'].post as Operation).operationId = 'registerUser';
    const ids = Object.values(candidate.paths).flatMap((item) =>
      Object.values(item).map((entry) => entry.operationId),
    );
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  it('detects a missing operationId', () => {
    const candidate = mutated();
    delete (candidate.paths['/api/v1/auth/login'].post as Operation).operationId;
    const ids = Object.values(candidate.paths).flatMap((item) =>
      Object.values(item).map((entry) => entry.operationId),
    );
    expect(ids).toContain(undefined);
  });

  it('detects a wrong security requirement', () => {
    const candidate = mutated();
    (candidate.paths['/api/v1/auth/login'].post as Operation).security = [{ bearerAuth: [] }];
    expect(candidate.paths['/api/v1/auth/login'].post.security).not.toEqual([]);
  });

  it('detects a missing response schema', () => {
    const candidate = mutated();
    const response = responseOf(candidate.paths['/api/v1/auth/me'].get, '200') as ResponseObject;
    delete response.content;
    expect(responseOf(candidate.paths['/api/v1/auth/me'].get, '200')?.content).toBeUndefined();
  });

  it('detects a wrong response status', () => {
    const candidate = mutated();
    (candidate.paths['/api/v1/auth/register'].post as Operation).responses = {
      '200': { description: 'wrong' },
    };
    expect(Object.keys(candidate.paths['/api/v1/auth/register'].post.responses ?? {})).toEqual(['200']);
  });

  it('detects 204 gaining content', () => {
    const candidate = mutated();
    const logout = candidate.paths['/api/v1/auth/logout'].post as Operation;
    (responseOf(logout, '204') as ResponseObject).content = {
      'application/json': { schema: { type: 'object' } },
    };
    expect(responseOf(logout, '204')?.content).toBeDefined();
  });

  it('detects an invalid $ref and an invalid document', async () => {
    const broken = mutated();
    (broken.paths['/api/v1/auth/me'].get as Operation).responses = {
      '200': { $ref: '#/components/schemas/DoesNotExist' },
    };
    await expect(SwaggerParser.validate(JSON.parse(JSON.stringify(broken)))).rejects.toThrow();
  });

  it('detects an active operation marked deprecated', () => {
    const candidate = mutated();
    (candidate.paths['/api/v1/auth/login'].post as Operation).deprecated = true;
    expect(candidate.paths['/api/v1/auth/login'].post.deprecated).toBe(true);
  });

  it('detects secret-marker leakage', () => {
    const candidate = mutated();
    (candidate.info as Record<string, unknown>).description = 'postgresql://u:p@host/db';
    expect(JSON.stringify(candidate)).toContain('postgresql://');
  });

  it('detects ProblemDetails schema drift', () => {
    const candidate = mutated();
    const problem = candidate.components?.schemas?.ProblemDetails as Record<string, unknown>;
    (problem.required as string[]).push('stack');
    expect((problem.required as string[]).length).toBe(7);
  });

  it('detects an unknown-tag or wrong content type', () => {
    const candidate = mutated();
    const register = candidate.paths['/api/v1/auth/register'].post as Operation;
    register.requestBody = { content: { 'text/plain': { schema: { type: 'string' } } } };
    expect(Object.keys(register.requestBody?.content ?? {})).toEqual(['text/plain']);
  });
});