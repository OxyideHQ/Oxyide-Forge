import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifySchema } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

// package.json sits outside tsconfig rootDir, so it is read (not
// imported) at test time: the version assertion below is what prevents
// the document's info.version from drifting away from the package
// source of truth. Read through a URL rather than a require() call so
// the architecture checker's import graph stays unchanged.
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * M7.6 — OpenAPI document and Swagger UI proofs.
 *
 * The generated specification is validated structurally (version, info,
 * paths, unique operation IDs, resolvable refs, security, schemas) and
 * for content accuracy (every real route present, no invented routes,
 * errors match the frozen M6 contract, no secrets). Registration is
 * proven across the four flag combinations. DB-free: no test touches
 * persistence.
 */

const { buildApp } = await import('../app/app.js');
const { createDeprecationRouteHook } = await import('../shared/api-lifecycle/deprecation.js');

type Spec = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, Operation>>;
  components?: {
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  tags?: Array<{ name: string }>;
};

type ContentMap = Record<string, { schema?: unknown }>;

type ResponseObject = {
  description?: string;
  content?: ContentMap;
  headers?: Record<string, { description?: string; required?: boolean }>;
};

type Operation = {
  operationId?: string;
  deprecated?: boolean;
  tags?: string[];
  summary?: string;
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown }>;
  requestBody?: { content?: ContentMap };
  responses?: Record<string, ResponseObject>;
};

let app: FastifyInstance;
let spec: Spec;

beforeEach(async () => {
  vi.unstubAllEnvs();
});

async function buildDefaultApp(): Promise<FastifyInstance> {
  vi.stubEnv('OPENAPI_ENABLED', 'true');
  vi.stubEnv('SWAGGER_UI_ENABLED', 'true');
  const instance = await buildApp({ loggerStream: { write: () => true } });
  await instance.ready();
  return instance;
}

describe('openapi document structure', () => {
  it('serves a valid OpenAPI 3.1 document at /openapi.json', async () => {
    app = await buildDefaultApp();
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    spec = response.json() as Spec;

    expect(spec.openapi).toMatch(/^3\.1\./);
    expect(spec.info.title).toBe('Oxyide Forge API');
    expect(spec.info.version).toBe(packageJson.version);
    expect(typeof spec.info.description).toBe('string');
    expect(spec.paths).toBeDefined();
    expect(spec.components?.schemas).toBeDefined();
    expect(spec.components?.securitySchemes).toBeDefined();
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });
});

describe('openapi paths match the real routes', () => {
  const EXPECTED_PATHS: Readonly<Record<string, ReadonlyArray<string>>> = {
    '/api/v1/auth/register': ['post'],
    '/api/v1/auth/login': ['post'],
    '/api/v1/auth/logout': ['post'],
    '/api/v1/auth/me': ['get'],
    '/api/v1/auth/refresh': ['post'],
    '/api/v1/auth/password-reset/request': ['post'],
    '/api/v1/auth/password-reset/confirm': ['post'],
    '/api/v1/auth/email-verification/resend': ['post'],
    '/api/v1/auth/email-verification/confirm': ['post'],
    '/api/v1/auth/sessions/revoke-all': ['post'],
    '/api/v1/users/{id}': ['get', 'put', 'delete'],
    '/api/v1/roles': ['get'],
    '/api/v1/roles/{name}': ['get'],
    '/api/v1/notes': ['get', 'post'],
    '/api/v1/notes/{id}': ['get', 'put', 'delete'],
    '/health/live': ['get'],
    '/health/ready': ['get'],
  };

  it('contains exactly the real operations, no more and no fewer', async () => {
    app = await buildDefaultApp();
    spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;

    expect(Object.keys(spec.paths).sort()).toEqual(Object.keys(EXPECTED_PATHS).sort());
    for (const [path, methods] of Object.entries(EXPECTED_PATHS)) {
      expect(Object.keys(spec.paths[path]).sort()).toEqual([...methods].sort());
    }
    expect(JSON.stringify(spec)).not.toContain('/api/v2');
    expect(JSON.stringify(spec)).not.toContain('/openapi.json');
    expect(JSON.stringify(spec)).not.toContain('/docs');
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });

  it('uses unique, stable operation IDs', async () => {
    app = await buildDefaultApp();
    spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;

    const ids: string[] = [];
    for (const pathItem of Object.values(spec.paths)) {
      for (const operation of Object.values(pathItem)) {
        expect(typeof operation.operationId).toBe('string');
        expect(typeof operation.summary).toBe('string');
        expect(typeof operation.description).toBe('string');
        ids.push(operation.operationId as string);
      }
    }
    expect(ids).toHaveLength(22);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('registerUser');
    expect(ids).toContain('getRoleByName');
    expect(ids).toContain('healthLive');
    expect(ids).toContain('listNotes');
    expect(ids).toContain('getNoteById');
    expect(ids).toContain('deleteNote');
    // No generator placeholders leak into the published document.
    for (const pathItem of Object.values(spec.paths)) {
      for (const operation of Object.values(pathItem)) {
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          expect(`${status}:${response.description}`).not.toContain('Default Response');
        }
      }
    }
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });

  it('tags only real resource boundaries', async () => {
    app = await buildDefaultApp();
    spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;

    for (const pathItem of Object.values(spec.paths)) {
      for (const operation of Object.values(pathItem)) {
        expect(operation.tags).toBeDefined();
        for (const tag of operation.tags as string[]) {
          expect(['Health', 'Auth', 'Users', 'Roles', 'Notes']).toContain(tag);
        }
      }
    }
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });
});

describe('openapi security', () => {
  const PROTECTED: ReadonlyArray<string> = [
    'getCurrentUser',
    'revokeAllSessions',
    'getUserById',
    'updateUser',
    'deleteUser',
    'listRoles',
    'getRoleByName',
    'listNotes',
    'createNote',
    'getNoteById',
    'updateNote',
    'deleteNote',
  ];

  it('marks protected operations with bearerAuth and public ones explicitly empty', async () => {
    app = await buildDefaultApp();
    spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;

    expect(spec.components?.securitySchemes?.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    const byId: Record<string, Operation> = {};
    for (const pathItem of Object.values(spec.paths)) {
      for (const operation of Object.values(pathItem)) {
        byId[operation.operationId as string] = operation;
      }
    }
    for (const id of PROTECTED) {
      expect(byId[id].security).toEqual([{ bearerAuth: [] }]);
    }
    for (const id of ['registerUser', 'loginUser', 'logoutUser', 'healthLive']) {
      expect(byId[id].security).toEqual([]);
    }
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });
});

describe('openapi schemas', () => {
  it('documents request bodies and path parameters from runtime schemas', async () => {
    app = await buildDefaultApp();
    spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;

    const register = spec.paths['/api/v1/auth/register'].post;
    const registerBody = register.requestBody?.content?.['application/json']?.schema as {
      required?: string[];
    };
    expect(registerBody.required).toContain('email');
    expect(registerBody.required).toContain('password');

    const userGet = spec.paths['/api/v1/users/{id}'].get;
    expect(userGet.parameters).toContainEqual(
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    );
    // No format claimed beyond what runtime enforces (any string ≤ cap).
    const idParam = (userGet.parameters as Array<{ name: string; schema?: object }>).find(
      (parameter) => parameter.name === 'id',
    );
    expect(idParam).not.toHaveProperty('format', 'uuid');

    const me = spec.paths['/api/v1/auth/me'].get;
    const meSchema = me.responses?.['200']?.content?.['application/json']?.schema as {
      required?: string[];
    };
    expect(meSchema.required).toEqual(
      expect.arrayContaining(['id', 'email', 'displayName', 'status', 'role', 'createdAt', 'updatedAt']),
    );
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });

  it('documents 204 operations with no body', async () => {
    app = await buildDefaultApp();
    spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;

    for (const path of [
      '/api/v1/auth/logout',
      '/api/v1/auth/password-reset/request',
      '/api/v1/users/{id}',
    ]) {
      for (const [method, operation] of Object.entries(spec.paths[path])) {
        const noContent = operation.responses?.['204'];
        if (noContent !== undefined) {
          expect(noContent.content).toBeUndefined();
          expect(method).toBeDefined();
        }
      }
    }
    const logout = spec.paths['/api/v1/auth/logout'].post.responses as Record<string, object>;
    expect(Object.keys(logout).sort()).toEqual(['204', '500']);
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });

  it('represents every error through the frozen Problem Details component', async () => {
    app = await buildDefaultApp();
    spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;

    const problem = spec.components?.schemas?.ProblemDetails as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(problem).toBeDefined();
    expect([...(problem.required as string[])].sort()).toEqual(
      ['code', 'detail', 'instance', 'status', 'title', 'type'].sort(),
    );
    expect(problem.properties).not.toHaveProperty('stack');
    expect(problem.properties).not.toHaveProperty('cause');

    const register = spec.paths['/api/v1/auth/register'].post.responses as Record<
      string,
      ResponseObject & { content?: ContentMap }
    >;
    expect(Object.keys(register).sort()).toEqual(['201', '400', '409', '500']);
    for (const status of ['400', '409', '500']) {
      expect(Object.keys(register[status].content ?? {})).toEqual(['application/problem+json']);
      expect(register[status].content?.['application/problem+json']?.schema).toEqual({
        $ref: '#/components/schemas/ProblemDetails',
      });
    }
    expect(Object.keys(register['201'].content ?? {})).toEqual(['application/json']);
    // M7.2 §6 Location header is documented (and only for registration).
    expect(register['201'].headers?.Location).toBeDefined();
    expect(register['201'].description).not.toBe('Default Response');
    expect(spec.paths['/api/v1/auth/login'].post.responses?.['201']).toBeUndefined();
    expect(spec.paths['/api/v1/auth/me'].get.responses?.['200']?.headers).toBeUndefined();

    // Frozen policy: no 422 anywhere; no cursor pagination; no errors bag.
    // M9.2 replaced the blanket "no 503 anywhere" with a narrower and stricter
    // rule: 503 exists on the readiness probe alone, and never as a Problem
    // Details envelope. Asserting it is confined to one operation is a
    // tightening — the previous assertion could not tell "absent" from
    // "accidentally present on the wrong route".
    const serialized = JSON.stringify(spec);
    expect(serialized).not.toContain('"422"');
    expect(serialized).not.toContain('nextCursor');
    expect(serialized).not.toContain('prevCursor');
    expect(serialized).not.toContain('"errors"');

    const readiness = spec.paths['/health/ready'].get.responses as Record<
      string,
      ResponseObject & { content?: ContentMap }
    >;
    expect(Object.keys(readiness).sort()).toEqual(['200', '503']);
    expect(readiness['503'].content?.['application/problem+json']).toBeUndefined();
    // Every other operation is untouched by the readiness status.
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      if (path === '/health/ready') {
        continue;
      }
      for (const operation of Object.values(pathItem)) {
        expect(Object.keys(operation.responses ?? {}), path).not.toContain('503');
      }
    }
    expect(spec.paths['/health/live'].get.responses?.['503']).toBeUndefined();
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });

  it('documents reusable pagination/sorting metadata without attaching them', async () => {
    app = await buildDefaultApp();
    spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;

    expect(spec.components?.schemas?.PaginationMetadata).toBeDefined();
    expect(spec.components?.parameters).toMatchObject({
      PageParam: expect.anything(),
      LimitParam: expect.anything(),
      SortParam: expect.anything(),
    });
    // M7.9: attached only where intentionally consumed. The notes list
    // GET references the parameters and the envelope; no other path does.
    const onlyNotes = (() => {
      for (const [path, pathItem] of Object.entries(spec.paths)) {
        if (path !== '/api/v1/notes' && path !== '/api/v1/notes/{id}') {
          const text = JSON.stringify(pathItem);
          if (text.includes('#/components/parameters/') || text.includes('PaginationMetadata')) {
            return false;
          }
        }
      }
      const notesGet = (spec.paths['/api/v1/notes']?.get ?? {}) as unknown as Record<string, unknown>;
      const text = JSON.stringify(notesGet);
      return (
        text.includes('#/components/parameters/PageParam') &&
        text.includes('#/components/parameters/LimitParam') &&
        text.includes('#/components/parameters/SortParam') &&
        text.includes('PaginationMetadata')
      );
    })();
    expect(onlyNotes).toBe(true);
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });

  it('resolves every $ref in the document', async () => {
    app = await buildDefaultApp();
    spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;

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
        (spec.components as Record<string, Record<string, unknown>>)?.[section]?.[name],
      ).toBeDefined();
    }
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });

  it('advertises the configured server URL, never a hardcoded host', async () => {
    app = await buildDefaultApp();
    spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;

    const { config } = await import('../config/index.js');
    expect(spec.servers).toEqual([{ url: config.appBaseUrl }]);
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });
});

describe('openapi error coverage', () => {
  it('gives every non-health operation at least one documented error', async () => {
    app = await buildDefaultApp();
    spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;

    const allowed = new Set(['400', '401', '403', '404', '409', '429', '500']);
    // M9.2: 503 is published by the readiness probe alone, so it is allowed
    // there and nowhere else. Liveness keeps publishing 200 only.
    const nonProblem = new Set(['503']);
    let covered = 0;
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const operation of Object.values(pathItem)) {
        const statuses = Object.keys(operation.responses ?? {});
        for (const status of statuses) {
          expect(status).toMatch(/^[1-5]\d\d$/);
          if (['200', '201', '204'].includes(status)) {
            continue;
          }
          expect(
            allowed.has(status) || (path === '/health/ready' && nonProblem.has(status)),
            `${path} ${status}`,
          ).toBe(true);
        }
        if (path.startsWith('/health/')) {
          expect(statuses, path).toEqual(path === '/health/ready' ? ['200', '503'] : ['200']);
          continue;
        }
        expect(statuses.some((status) => allowed.has(status))).toBe(true);
        covered += 1;
      }
    }
    expect(covered).toBe(20);
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });
});

describe('openapi deprecation derivation (M7.7)', () => {
  /**
   * Uses the real `swaggerPlugin` on an isolated instance so the derivation
   * is proven end-to-end against production plugin code, without marking
   * any real production route deprecated.
   */
  async function buildFixtureWithDeprecatedRoute() {
    const Fastify = (await import('fastify')).default;
    const { swaggerPlugin: plugin } = await import('./swagger.plugin.js');
    const fixture = Fastify({ logger: false });
    fixture.addHook('onRoute', createDeprecationRouteHook().onRoute);
    await fixture.register(plugin);
    fixture.get(
      '/api/v1/legacy',
      {
        schema: {
          tags: ['Users'],
          operationId: 'legacyOperation',
          summary: 'Legacy',
          description: 'Deprecated example.',
          security: [],
          deprecation: {
            deprecated: true,
            reason: 'Superseded by the batch endpoint.',
            successor: '/api/v1/batches',
            sunset: 'Wed, 31 Dec 2026 23:59:59 GMT',
          },
        },
      },
      async () => ({}),
    );
    fixture.get(
      '/api/v1/active',
      {
        schema: {
          tags: ['Users'],
          operationId: 'activeOperation',
          summary: 'Active',
          description: 'Active example.',
          security: [],
        },
      },
      async () => ({}),
    );
    await fixture.ready();
    return fixture;
  }

  it('marks a deprecated operation and leaves active ones untouched', async () => {
    const fixture = await buildFixtureWithDeprecatedRoute();
    const document = fixture.swagger() as Spec;

    const deprecated = document.paths['/api/v1/legacy'].get;
    expect(deprecated.deprecated).toBe(true);
    expect(deprecated.summary).toBe('Legacy');

    const active = document.paths['/api/v1/active'].get;
    expect(active.deprecated).toBeUndefined();
    await fixture.close();
  });

  it('publishes the reason, sunset and successor as operation extensions', async () => {
    const fixture = await buildFixtureWithDeprecatedRoute();
    const document = fixture.swagger() as Spec & {
      paths: Record<string, Record<string, Operation & Record<string, unknown>>>;
    };

    const operation = document.paths['/api/v1/legacy'].get;
    expect(operation['x-deprecation-reason']).toBe('Superseded by the batch endpoint.');
    expect(operation['x-deprecation-sunset']).toBe('Wed, 31 Dec 2026 23:59:59 GMT');
    expect(operation['x-deprecation-successor']).toBe('/api/v1/batches');
    await fixture.close();
  });

  it('signals the same deprecation at runtime through the standard headers', async () => {
    // The fixture registers the runtime hook exactly as buildApp does.
    const fixture = await buildFixtureWithDeprecatedRoute();
    const deprecated = await fixture.inject({ method: 'GET', url: '/api/v1/legacy' });
    expect(deprecated.headers.deprecation).toBe('true');
    expect(deprecated.headers.sunset).toBe('Wed, 31 Dec 2026 23:59:59 GMT');
    expect(deprecated.headers.link).toContain('</api/v1/batches>');
    expect(deprecated.headers.link).toContain('rel="successor-version"');

    const active = await fixture.inject({ method: 'GET', url: '/api/v1/active' });
    expect(active.headers.deprecation).toBeUndefined();
    await fixture.close();
  });

  it('fails route registration on invalid deprecation metadata', async () => {
    const Fastify = (await import('fastify')).default;
    const fixture = Fastify({ logger: false });
    fixture.addHook('onRoute', createDeprecationRouteHook().onRoute);

    expect(() => {
      fixture.get(
        '/api/v1/bad',
        {
          schema: {
            // Route schemas are structurally open: extra documentation keys
            // such as `deprecation` are carried alongside body/params.
            deprecation: {
              deprecated: true,
              reason: 'r',
              successor: 'https://internal.corp/admin',
            },
          } as FastifySchema,
        },
        async () => ({}),
      );
    }).toThrow(/successor/);
    await fixture.close();
  });
});

describe('openapi security hygiene', () => {
  it('contains no secrets, URLs, tokens, or paths', async () => {
    app = await buildDefaultApp();
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    const payload = response.payload;

    for (const forbidden of [
      'postgresql://',
      'DATABASE_URL',
      'JWT_SECRET',
      'BEGIN PRIVATE KEY',
      'Bearer eyJ',
      'passwordHash',
      'tokenHash',
      'node_modules',
      '/srv/',
      '127.0.0.1:5433',
    ]) {
      expect(payload).not.toContain(forbidden);
    }
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });
});

describe('swagger ui registration', () => {
  it('serves the UI backed by the same generated document', async () => {
    app = await buildDefaultApp();
    const docs = await app.inject({ method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');

    const specResponse = await app.inject({ method: 'GET', url: '/openapi.json' });
    const bundleResponse = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(bundleResponse.statusCode).toBe(200);
    expect(bundleResponse.json()).toEqual(specResponse.json());
    await app.close();
    app = undefined as unknown as FastifyInstance;
  });
});

describe('documentation flag matrix', () => {
  async function buildWithFlags(openapi: string | undefined, swagger: string | undefined) {
    if (openapi === undefined) {
      delete process.env.OPENAPI_ENABLED;
    } else {
      vi.stubEnv('OPENAPI_ENABLED', openapi);
    }
    if (swagger === undefined) {
      delete process.env.SWAGGER_UI_ENABLED;
    } else {
      vi.stubEnv('SWAGGER_UI_ENABLED', swagger);
    }
    vi.resetModules();
    const { buildApp: freshBuildApp } = await import('../app/app.js');
    const instance = await freshBuildApp({ loggerStream: { write: () => true } });
    await instance.ready();
    return instance;
  }

  it('A: both disabled serves neither route', async () => {
    const instance = await buildWithFlags('false', 'false');
    expect((await instance.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(404);
    expect((await instance.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
    // The API itself is unaffected.
    expect((await instance.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    await instance.close();
  });

  it('B: openapi without UI serves the document only', async () => {
    const instance = await buildWithFlags('true', 'false');
    expect((await instance.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(200);
    expect((await instance.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
    await instance.close();
  });

  it('C: both enabled serves document and UI', async () => {
    const instance = await buildWithFlags('true', 'true');
    expect((await instance.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(200);
    expect((await instance.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(200);
    await instance.close();
  });

  it('D: UI without OpenAPI is rejected at startup, never silently enabled', async () => {
    vi.resetModules();
    vi.stubEnv('OPENAPI_ENABLED', 'false');
    vi.stubEnv('SWAGGER_UI_ENABLED', 'true');
    await expect(import('../app/app.js')).rejects.toThrow('SWAGGER_UI_ENABLED requires OPENAPI_ENABLED');
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (app !== undefined) {
    await app.close();
  }
});
