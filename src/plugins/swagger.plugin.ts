import swagger, { type FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { config } from '../config/index.js';
import {
  deriveOpenApiDeprecation,
  type DeprecationMetadata,
} from '../shared/api-lifecycle/deprecation.js';
import { PAGINATION_METADATA_JSON_SCHEMA } from '../shared/pagination/pagination.js';

/**
 * API documentation plugin (M7.6).
 *
 * Two independently configurable capabilities over one source:
 * - OpenAPI 3.1 document generation from the runtime route schemas
 *   (`@fastify/swagger`, dynamic mode) served at `/openapi.json`.
 * - Swagger UI presentation bundle at `/docs` (its internal `./json`
 *   fetch serves the same `app.swagger()` source — one definition,
 *   two URLs; `/openapi.json` is canonical).
 *
 * Respects `config.docs`: OpenAPI off registers nothing; UI on requires
 * OpenAPI (the invalid combination is rejected at startup in
 * env.schema.ts, so the pair is valid by the time this runs).
 *
 * Generation strategy (no drift by construction):
 * - Success bodies come straight from the M7.2 route `response:`
 *   contracts — the generator reads them; nothing is re-declared.
 * - Error responses cannot live in route `response:` (status-keyed
 *   serialization would enter the frozen M6 error path), so the
 *   per-route `transform` merges an operationId-keyed static error
 *   table (`$ref: ProblemDetails`) plus bodyless 204 contracts for the
 *   schema-less 204 routes. Transform output is docs-only (the plugin
 *   consumes it during `app.swagger()`, never for validation).
 * - Reusable pagination/sorting/filtering contracts live as OpenAPI
 *   components, explicitly unattached to operations that ignore query
 *   (attaching them would be false documentation).
 */

const PROBLEM_DETAILS_REF = { $ref: '#/components/schemas/ProblemDetails' };

const PROBLEM_DETAILS_SCHEMA = {
  type: 'object',
  description:
    'Frozen M6 Problem Details body: exactly these six fields with application/problem+json. Never stacks, causes, SQL, tokens, paths, or debug metadata.',
  required: ['type', 'title', 'status', 'detail', 'code', 'instance'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', description: 'Stable problem-type URI' },
    title: { type: 'string', description: 'Short stable summary' },
    status: { type: 'integer', description: 'HTTP status actually sent' },
    detail: { type: 'string', description: 'Safe human-readable description' },
    code: { type: 'string', description: 'Stable machine-readable application code' },
    instance: { type: 'string', description: 'Occurrence identifier (/requests/<id>)' },
  },
} as const;

const ERROR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '400': 'Invalid request. The `code` field identifies the failure; see the validation contract.',
  '401':
    'Missing, invalid, or expired credentials (includes a `WWW-Authenticate` header). A valid token whose subject no longer exists is also 401.',
  '403': 'Authenticated but not authorized. The detail is intentionally generic.',
  '404': 'Unknown route or authorized-but-missing resource.',
  '409': 'Duplicate registration: the email is already in use.',
  '429': 'Too many attempts. Back off and retry later.',
  '500': 'Unexpected failure. Sanitized generic body; operators correlate via `instance`.',
};

/**
 * Error applicability per operation, verified against service/guard
 * code (not guessed): register has no throttle (assessment-only), login
 * and recovery issuance do; stale subjects are 401, never 404. No entry
 * exists for either health probe — liveness cannot fail, and readiness's
 * 503 carries an empty body rather than Problem Details, so it is
 * published by STATIC_RESPONSES instead. No 422 anywhere (M6.5 deliberate);
 * 503 exists only on the readiness probe (M9.1/M9.2).
 */
const OPERATION_ERRORS: Readonly<Record<string, ReadonlyArray<string>>> = {
  registerUser: ['400', '409', '500'],
  loginUser: ['400', '401', '429', '500'],
  logoutUser: ['500'],
  getCurrentUser: ['401', '500'],
  refreshAccessToken: ['401', '500'],
  requestPasswordReset: ['400', '429', '500'],
  confirmPasswordReset: ['400', '401', '500'],
  resendVerificationEmail: ['400', '429', '500'],
  confirmEmailVerification: ['400', '401', '500'],
  revokeAllSessions: ['401', '500'],
  getUserById: ['401', '403', '404', '500'],
  updateUser: ['400', '401', '403', '404', '500'],
  deleteUser: ['401', '403', '404', '500'],
  listRoles: ['401', '403', '500'],
  getRoleByName: ['401', '403', '404', '500'],
  listNotes: ['400', '401', '500'],
  createNote: ['400', '401', '500'],
  getNoteById: ['401', '403', '404', '500'],
  updateNote: ['400', '401', '403', '404', '500'],
  deleteNote: ['401', '403', '404', '500'],
};

/**
 * Static response contracts for operations whose runtime intentionally
 * declares no response schema: the two health probes return `{}` with no
 * validation contract by design (M7.1), so their responses are documented
 * here (description only, never a body schema) rather than invented in code.
 *
 * `healthReady` also publishes its `503` (M9.2). It is deliberately NOT in
 * `OPERATION_ERRORS`: that table emits `$ref: ProblemDetails`, and the frozen
 * M9.1 readiness contract requires an **empty** body on failure — the status
 * code is the entire signal, and no error envelope, code, or detail is
 * exposed on an unauthenticated endpoint.
 */
const STATIC_RESPONSES: Readonly<Record<string, Record<string, unknown>>> = {
  healthLive: { 200: { description: 'Service is alive (empty object).' } },
  healthReady: {
    200: { description: 'Service is ready to serve traffic (empty object).' },
    503: { description: 'A required dependency is unusable; not serving traffic (empty object).' },
  },
};

/** Response headers the runtime emits but JSON Schema cannot express (M7.2 §6). */
const RESPONSE_HEADERS: Readonly<Record<string, { status: string }>> = {
  registerUser: { status: '201' },
  createNote: { status: '201' },
};

/**
 * Runnable request examples for the interactive docs, keyed by operationId.
 *
 * Swagger UI prefills "Try it out" bodies by sampling the request schema;
 * for `pattern`-constrained strings it generates regex-shaped gibberish, so
 * without this table the auth operations present an unrunnable blob. These
 * values are presentation-only: they live here (not in route schemas)
 * because AJV strict mode rejects the unknown `example` keyword at route
 * registration — including in every test harness and customer module that
 * registers these routes on a default Fastify instance. Every value satisfies
 * its runtime schema (email matches the route pattern, passwords meet the
 * length bounds, tokens are obvious placeholders), so executing the prefilled
 * sample reaches the handler instead of failing validation. Placeholder
 * secrets only — nothing here is a real credential.
 */
const OPERATION_REQUEST_EXAMPLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  registerUser: {
    email: 'test@example.com',
    password: 'correct-horse-battery-staple',
    displayName: 'Test User',
  },
  loginUser: {
    email: 'test@example.com',
    password: 'correct-horse-battery-staple',
  },
  requestPasswordReset: {
    email: 'test@example.com',
  },
  confirmPasswordReset: {
    token: 'replace-with-token-from-email',
    password: 'correct-horse-battery-staple',
  },
  resendVerificationEmail: {
    email: 'test@example.com',
  },
  confirmEmailVerification: {
    token: 'replace-with-token-from-email',
  },
};

/**
 * Merges OPERATION_REQUEST_EXAMPLES into matching request-body properties.
 * Defensive by design: entries whose operation, media type, or property is
 * absent are skipped, so document generation can never 500 the docs. Stale
 * or incomplete entries are caught instead by the openapi-contract suite,
 * which pins every table key against the frozen operation list and every
 * covered operation against its runtime schema bounds.
 */
function applyRequestExamples(paths: Record<string, Record<string, unknown>> | undefined): void {
  if (paths === undefined) return;
  for (const pathItem of Object.values(paths)) {
    for (const operation of Object.values(pathItem)) {
      if (operation === null || typeof operation !== 'object') continue;
      const operationId = (operation as { operationId?: unknown }).operationId;
      if (typeof operationId !== 'string') continue;
      const examples = OPERATION_REQUEST_EXAMPLES[operationId];
      if (examples === undefined) continue;
      const schema = (operation as { requestBody?: unknown }).requestBody as
        | { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }
        | undefined;
      const properties = schema?.content?.['application/json']?.schema?.properties;
      if (properties === undefined) continue;
      for (const [name, example] of Object.entries(examples)) {
        const property = properties[name];
        if (property !== null && typeof property === 'object') {
          (property as Record<string, unknown>).example = example;
        }
      }
    }
  }
}

/** Operations whose success contract is bodyless 204 (no runtime schema by M7.2 design). */const NO_CONTENT_OPERATIONS: ReadonlySet<string> = new Set([
  'logoutUser',
  'requestPasswordReset',
  'confirmPasswordReset',
  'resendVerificationEmail',
  'confirmEmailVerification',
  'revokeAllSessions',
  'deleteUser',
  'deleteNote',
]);

function problemResponse(status: string): Record<string, unknown> {
  return {
    description: ERROR_DESCRIPTIONS[status],
    content: { 'application/problem+json': { schema: PROBLEM_DETAILS_REF } },
  };
}

const swaggerPluginCallback: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  if (!config.docs.openApiEnabled) {
    app.log.info('OpenAPI disabled (OPENAPI_ENABLED=false) — skipping documentation plugin');
    return;
  }

  const swaggerOptions: FastifyDynamicSwaggerOptions = {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Oxyide Forge API',
        description:
          'Versioned product API (`/api/v1`) with RFC 7807 Problem Details errors. ' +
          'Reusable pagination (`?page`, `?limit`), sorting (`?sort`), and filtering ' +
          '(`filter[field_op]`) contracts are documented as components for future ' +
          'list endpoints; no current endpoint consumes them. Cursor pagination ' +
          'is future work. See docs/api-conventions.md for the normative contracts.',
        // API major version tracks /api/v1; tied to package.json by test.
        version: '1.0.0',
      },
      // Operator-configured public base URL (validated config, never
      // hardcoded, never a secret — it is the public address by design).
      servers: [{ url: config.appBaseUrl }],
      tags: [
        { name: 'Health', description: 'Infrastructure liveness outside /api/v1 (no auth, no dependencies checked).' },
        { name: 'Auth', description: 'Registration, login, sessions, recovery, and verification.' },
        { name: 'Users', description: 'User resource reads, updates, and privileged deletes.' },
        { name: 'Roles', description: 'Read-only built-in role and permission vocabulary.' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Access JWT in the Authorization header ("Bearer <token>"). Browser clients may equivalently carry it in the HttpOnly access cookie; the token mechanism is identical.',
          },
        },
        schemas: {
          // Fresh `required` arrays: the shared consts are deeply
          // `as const` (correct for their runtime owners), and only the
          // array identity conflicts with the mutable OpenAPI types.
          // Narrowed literals are preserved by the spread, and generation
          // only reads — nothing here can drift from source.
          ProblemDetails: { ...PROBLEM_DETAILS_SCHEMA, required: [...PROBLEM_DETAILS_SCHEMA.required] },
          PaginationMetadata: {
            ...PAGINATION_METADATA_JSON_SCHEMA,
            required: [...PAGINATION_METADATA_JSON_SCHEMA.required],
          },
        },
        parameters: {
          PageParam: {
            name: 'page',
            in: 'query',
            description: 'Reusable pagination: 1-based page, default 1, minimum 1. Unattached — no current operation consumes it.',
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          LimitParam: {
            name: 'limit',
            in: 'query',
            description: 'Reusable pagination: page size, default 20, min 1, max 100 (centralized). Unattached — no current operation consumes it.',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          SortParam: {
            name: 'sort',
            in: 'query',
            description:
              'Reusable sorting: field[:direction] entries, comma-separated, max 3; directions asc|desc (default asc per entry); unknown fields reject. Field allowlists are endpoint-owned. Unattached — no current operation consumes it.',
            schema: { type: 'string', maxLength: 128 },
          },
        },
      },
    },
    // Docs-only augmentation (see module header): success bodies flow
    // from runtime schemas; errors, bodyless 204s, and deprecation
    // metadata (M7.7) are merged here.
    transform: ({ schema, url }) => {
      // Deprecation (M7.7): derived from the route-owned metadata object —
      // the same object the runtime header hook reads, so documentation
      // and runtime cannot disagree. Active routes emit no `deprecated`
      // key at all (absence, not `false`). `@fastify/swagger` ignores an
      // unknown `deprecation` key, so this derivation is what publishes it.
      const deprecation = deriveOpenApiDeprecation(
        (schema as { deprecation?: DeprecationMetadata }).deprecation,
      );
      const rawOperationId = (schema as { operationId?: unknown }).operationId;
      if (deprecation === undefined && typeof rawOperationId !== 'string') {
        return { schema, url };
      }
      const operationId = typeof rawOperationId === 'string' ? rawOperationId : '';
      const response: Record<string, unknown> = {
        ...((schema as { response?: Record<string, unknown> }).response ?? {}),
      };
      // Static response contracts (health probes) replace whatever the
      // generator would otherwise assume for a schema-less route.
      for (const [status, body] of Object.entries(STATIC_RESPONSES[operationId] ?? {})) {
        response[status] = body;
      }
      if (NO_CONTENT_OPERATIONS.has(operationId)) {
        for (const key of Object.keys(response)) {
          delete response[key];
        }
        response['204'] = { description: 'No Content' };
      }
      // M7.2 §6: registration 201 carries `Location: /api/v1/users/<id>`.
      // Documented, never re-implemented: the runtime header is unchanged.
      // Fastify reads `response.<code>.headers` as JSON Schema definitions and
      // emits proper OpenAPI Header Objects from them.
      const locationHeader = RESPONSE_HEADERS[operationId];
      if (locationHeader !== undefined && typeof response[locationHeader.status] === 'object') {
        response[locationHeader.status] = {
          ...(response[locationHeader.status] as Record<string, unknown>),
          headers: {
            Location: {
              type: 'string',
              description:
                'Canonical path of the created resource. Always present on this 201 (M7.2 §6).',
            },
          },
        };
      }
      for (const status of OPERATION_ERRORS[operationId] ?? []) {
        response[status] = problemResponse(status);
      }
      return { schema: { ...schema, ...deprecation, response }, url };
    },
    // Enforcement: a 204 must never claim a JSON body, no matter what a
    // future route edit declares. Descriptions survive; content is dropped.
    // The single `as unknown as` below is reasoned, not blind: the
    // library's document types are deeply partial generics, and this
    // traversal touches exactly one known leaf
    // (`paths.*.*.responses.204.content`). The unreachable swaggerObject
    // variant throws rather than passing through silently.
    transformObject: (documentObject) => {
      if (!('openapiObject' in documentObject) || documentObject.openapiObject === undefined) {
        throw new Error('swagger plugin misconfigured: expected OpenAPI mode');
      }
      const openapiObject = documentObject.openapiObject;
      const paths = (openapiObject as unknown as { paths?: Record<string, Record<string, unknown>> })
        .paths;
      for (const pathItem of Object.values(paths ?? {})) {
        for (const operation of Object.values(pathItem)) {
          const responses = (operation as { responses?: Record<string, unknown> })?.responses;
          const noContent = responses?.['204'];
          if (noContent !== null && typeof noContent === 'object') {
            delete (noContent as Record<string, unknown>).content;
          }
        }
      }
      // M7.9: the notes list is the first legitimate consumer of the
      // reusable M7.3–M7.5 contracts. Point its query parameters and its
      // 200-envelope pagination at the shared components instead of
      // duplicating them inline, so the document carries exactly one
      // authoritative definition. This is a docs-only rewrite — runtime
      // validation still runs against the original route schema.
      applyRequestExamples(paths);
      const notesList = paths?.['/api/v1/notes'] as
        | Record<string, unknown>
        | undefined;
      const list = notesList?.get as Record<string, unknown> | undefined;
      if (list !== undefined) {
        const parameters = list.parameters as unknown[] | undefined;
        if (Array.isArray(parameters)) {
          const byName: Record<string, string> = {
            page: 'PageParam',
            limit: 'LimitParam',
            sort: 'SortParam',
          };
          list.parameters = parameters.map((parameter) => {
            const componentName = byName[(parameter as { name?: string }).name ?? ''];
            return componentName === undefined
              ? parameter
              : { '$ref': `#/components/parameters/${componentName}` };
          });
        }
        const content = (list.responses as Record<string, unknown> | undefined)?.['200'] as
          | { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }
          | undefined;
        const envelopeSchema = content?.content?.['application/json']?.schema;
        if (envelopeSchema?.properties) {
          envelopeSchema.properties.pagination = {
            '$ref': '#/components/schemas/PaginationMetadata',
          };
        }
      }
      return openapiObject;
    },
  };
  await app.register(swagger, swaggerOptions);

  // Canonical machine-readable document. Hidden from the document itself.
  // Returns the same `app.swagger()` source the UI bundle consumes —
  // one definition, two URLs.
  app.get('/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
    return reply.send(app.swagger());
  });

  if (!config.docs.swaggerUiEnabled) {
    app.log.info('Swagger UI disabled (SWAGGER_UI_ENABLED=false) — /openapi.json remains available');
    return;
  }

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
  app.log.info('Swagger UI available at /docs (spec: /openapi.json)');
};

export const swaggerPlugin = fp(swaggerPluginCallback, {
  fastify: '5.x',
  name: 'swagger-plugin',
});
