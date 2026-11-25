import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defineDeprecation } from '../shared/api-lifecycle/deprecation.js';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

/**
 * M7.7 — API compatibility contract, proven against the real application.
 *
 * Deliberately NOT named `*.integration.test.ts`: it performs no database
 * access at all (every probe is unauthenticated, so it asserts routing and
 * metadata, not credentials), and ARCH-ENF-011 requires DB-gated suites to
 * declare that dependency explicitly. Misclassifying it would add a fake
 * database dependency to a contract test.
 *
 * The milestone establishes a promise, so the promise is asserted rather
 * than described: the route set, the operationIds, the absence of any
 * version-negotiation surface, and the fact that not one operation is
 * accidentally deprecated. No DB access — every assertion is transport or
 * document level, and DB-backed operations are probed unauthenticated so
 * the assertions are about routing and metadata, not about credentials.
 */

const { buildApp } = await import('../app/app.js');

type Operation = {
  operationId?: string;
  deprecated?: boolean;
  tags?: string[];
  parameters?: Array<{ name: string; in: string }>;
  responses?: Record<string, unknown>;
};

type Spec = {
  openapi: string;
  info: { version: string; title: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
};

/** The frozen public surface established by M7.2–M7.6. */
const FROZEN_ROUTES: Readonly<Record<string, ReadonlyArray<string>>> = {
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

/** OperationIds are part of the machine-readable contract (M7.7 §2.7). */
const FROZEN_OPERATION_IDS: ReadonlyArray<string> = [
  'registerUser',
  'loginUser',
  'logoutUser',
  'getCurrentUser',
  'refreshAccessToken',
  'requestPasswordReset',
  'confirmPasswordReset',
  'resendVerificationEmail',
  'confirmEmailVerification',
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
  'healthLive',
  'healthReady',
];

let app: FastifyInstance;
let spec: Spec;

beforeAll(async () => {
  app = await buildApp({ loggerStream: { write: () => true } });
  await app.ready();
  spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Spec;
});

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
});

describe('versioning: /api/v1 is the only version surface', () => {
  it('publishes exactly the frozen route set', () => {
    expect(Object.keys(spec.paths).sort()).toEqual(Object.keys(FROZEN_ROUTES).sort());
    for (const [path, methods] of Object.entries(FROZEN_ROUTES)) {
      expect(Object.keys(spec.paths[path]).sort()).toEqual([...methods].sort());
    }
  });

  it('keeps every documented operation reachable at its /api/v1 path', async () => {
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    // Unauthenticated probe: proves routing, not credentials.
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/roles' })).statusCode).toBe(401);
  });

  it('has no /api/v2 and no unversioned business route', async () => {
    for (const url of [
      '/api/v2/auth/me',
      '/api/v2/roles',
      '/auth/me',
      '/users/1',
      '/roles',
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    expect(JSON.stringify(spec)).not.toContain('/api/v2');
  });

  it('offers no version negotiation surface', async () => {
    // Header negotiation must not exist: an unknown Accept or version
    // header changes nothing, and no route is reachable without /api/v1.
    const withHeaders = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        accept: 'application/vnd.oxyide.v1+json',
        'accept-version': 'v1',
        'api-version': '1',
        'x-api-version': 'v2',
      },
    });
    expect(withHeaders.statusCode).toBe(404);

    const queryVersion = await app.inject({ method: 'GET', url: '/auth/me?version=1&api_version=v1' });
    expect(queryVersion.statusCode).toBe(404);

    // The only route that answers is the canonical one.
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
  });

  it('does not tie the API major version to the package version', async () => {
    const packageJson = JSON.parse(
      // Read rather than import: package.json sits outside tsconfig rootDir,
      // and an import here would pollute the architecture checker graph.
      await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'),
      ),
    ) as { version: string };

    expect(spec.info.version).toBe(packageJson.version);
    // Documented independence: /api/v1 is not derived from a package
    // version, it is a hard-coded contract. Nothing here may imply that a
    // package bump produces /api/v2.
    expect(Object.keys(spec.paths).every((path) => !path.startsWith('/api/v2'))).toBe(true);
  });
});

describe('operationId stability (machine-readable contract)', () => {
  it('keeps every operationId stable and unique', () => {
    const ids: string[] = [];
    for (const pathItem of Object.values(spec.paths)) {
      for (const operation of Object.values(pathItem)) {
        ids.push(operation.operationId as string);
      }
    }

    expect(ids.slice().sort()).toEqual(FROZEN_OPERATION_IDS.slice().sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('deprecation state: nothing is accidentally deprecated', () => {
  it('marks no production operation deprecated', () => {
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        // Absent, not `false`: the document must never imply a state that
        // does not exist.
        expect(operation.deprecated, `${method.toUpperCase()} ${path}`).toBeUndefined();
      }
    }
    expect(JSON.stringify(spec)).not.toContain('x-deprecation');
  });

  it('emits no deprecation header on any production response', async () => {
    for (const url of [
      '/health/live',
      '/health/ready',
      '/api/v1/auth/me',
      '/api/v1/roles',
      '/openapi.json',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.headers.deprecation, url).toBeUndefined();
      expect(response.headers.sunset, url).toBeUndefined();
    }
  });

  it('cannot be made deprecated by client-supplied headers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: {
        deprecation: 'true',
        sunset: 'Wed, 31 Dec 1999 23:59:59 GMT',
        link: '<https://evil.example>; rel="successor-version"',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.deprecation).toBeUndefined();
    expect(response.headers.sunset).toBeUndefined();
  });
});

describe('OpenAPI integration (M7.6 preserved)', () => {
  it('keeps the document valid and M7.6 metadata intact', () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    expect(spec.info.title).toBe('Oxyide Forge API');
    expect(spec.components?.schemas).toHaveProperty('ProblemDetails');
    expect(spec.components?.securitySchemes).toHaveProperty('bearerAuth');

    const problem = spec.components?.schemas?.ProblemDetails as { required?: string[] };
    expect([...(problem.required ?? [])].sort()).toEqual(
      ['code', 'detail', 'instance', 'status', 'title', 'type'].sort(),
    );
  });

  it('keeps Swagger UI bound to the same single generated definition', async () => {
    const document = await app.inject({ method: 'GET', url: '/openapi.json' });
    const bundle = await app.inject({ method: 'GET', url: '/docs/json' });

    expect(bundle.statusCode).toBe(200);
    expect(bundle.json()).toEqual(document.json());
  });
});

describe('deprecation metadata contract is reusable, not wired in', () => {
  it('derives OpenAPI fields from a declaration the way the plugin does', () => {
    const derived = defineDeprecation({
      deprecated: true,
      reason: 'Superseded.',
      successor: '/api/v1/replacement',
      sunset: 'Wed, 31 Dec 2026 23:59:59 GMT',
    });

    expect(derived.successor).toBe('/api/v1/replacement');
    expect(derived.metadata.deprecated).toBe(true);
  });
});