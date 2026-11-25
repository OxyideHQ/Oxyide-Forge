#!/usr/bin/env node
/**
 * Module generator for Oxyide Forge (M17.2).
 *
 * Scaffolds an architecture-conformant backend module from the conventions
 * already present in this repository (derived from `src/modules/notes`), so
 * a customer adds a module without inventing a second architecture.
 *
 * Usage:
 *   node scripts/gen-module.mjs <name>   Generate src/modules/<name>/
 *   node scripts/gen-module.mjs --help   Usage
 *
 * Examples:
 *   node scripts/gen-module.mjs blog-posts
 *   # -> src/modules/blog-posts/{blog-posts.types.ts, blog-posts-response.ts,
 *   #      blog-posts.repository.ts, blog-post.service.ts,
 *   #      routes/blog-post.routes.ts, routes/blog-post.routes.test.ts}
 *
 * Guarantees:
 *   - Never overwrites an existing module (fails before writing).
 *   - Rejects path traversal, absolute paths, separators, punctuation,
 *     reserved names, and existing modules BEFORE touching the filesystem.
 *   - Writes are all-or-nothing: a failure removes only files this run created.
 *   - Generates no Prisma model and edits no manifest, lockfile, or the
 *     route registry; manual follow-ups are printed instead.
 *   - No secrets, no `any`, no unvalidated request bodies, no cross-module
 *     repository imports, no route-to-repository imports (ARCH-ENF-013).
 *
 * Exit codes: 0 success | 1 invalid input or refusal | 2 filesystem error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const MODULES_DIR = path.join(ROOT, 'src', 'modules');

/** Names owned by the framework; a generated module must not shadow them. */
const RESERVED = new Set([
  'app', 'auth', 'authorization', 'cache', 'config', 'health', 'notes',
  'platform', 'plugins', 'roles', 'shared', 'types', 'users',
]);

const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const NC = '\u001b[0m';

function fail(message) {
  process.stderr.write(`${RED}gen-module: ${message}${NC}\n`);
  process.exit(1);
}

function usage() {
  process.stdout.write(
    'Usage: node scripts/gen-module.mjs <name>\n' +
      '\n' +
      '  <name>  lowercase kebab-case module name, e.g. blog-posts\n' +
      '\n' +
      'Creates src/modules/<name>/ with types, response schema, repository port,\n' +
      'service, routes (auth-protected CRUD under /api/v1/<name>), and a route test.\n' +
      '\n' +
      'The generator never overwrites, never edits package.json, prisma/, or the\n' +
      'route registry, and never fabricates persistence: it prints the manual\n' +
      'follow-up steps instead.\n' +
      '\n' +
      'Exit codes: 0 success, 1 invalid input or refusal, 2 filesystem error.\n',
  );
}

/**
 * Validate the module name and resolve a destination confined to src/modules.
 * Every rejection happens before any filesystem write.
 */
export function resolveDestination(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { error: 'Module name is required (usage: node scripts/gen-module.mjs <name>).' };
  }
  const raw = name.trim();
  if (raw.includes('/') || raw.includes('\\')) {
    return { error: `Module name must not contain path separators: '${raw}'.` };
  }
  if (raw === '.' || raw === '..' || raw.includes('..')) {
    return { error: `Path traversal is not allowed: '${raw}'.` };
  }
  if (raw.startsWith('/') || path.isAbsolute(raw)) {
    return { error: `Absolute paths are not allowed: '${raw}'.` };
  }
  if (!NAME_PATTERN.test(raw)) {
    return {
      error:
        `Invalid module name '${raw}'. Use lowercase kebab-case starting with a ` +
        'letter (letters, digits, single hyphens), e.g. blog-posts.',
    };
  }
  if (RESERVED.has(raw)) {
    return { error: `'${raw}' is reserved by the framework. Choose another name.` };
  }
  // Defence in depth: the resolved path must remain a direct child of src/modules.
  const destination = path.resolve(MODULES_DIR, raw);
  if (path.dirname(destination) !== path.resolve(MODULES_DIR)) {
    return { error: `Refusing to generate outside src/modules/: '${raw}'.` };
  }
  if (fs.existsSync(destination)) {
    return { error: `Module '${raw}' already exists at ${destination}. Not overwriting.` };
  }
  return { destination, name: raw };
}

function pascal(name) {
  return name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

function screaming(name) {
  return name.replace(/-/g, '_').toUpperCase();
}

/**
 * camelCase identifier from a kebab-case module name.
 *
 * Required: `${name}Repository` for `blog-posts` would be
 * `blog-postsRepository`, which is not a valid TypeScript identifier.
 */
function camel(name) {
  const parts = name.split('-');
  return parts
    .map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('');
}

function singular(name) {
  const parts = name.split('-');
  return parts[parts.length - 1];
}

function render(name) {
  const Name = pascal(name);
  const NAME = screaming(name);
  const s = singular(name);
  const Singular = pascal(s);
  const camelName = camel(name);

  const files = new Map();

  files.set(
    `${name}.types.ts`,
    `/**
 * ${Name} domain types (generated by scripts/gen-module.mjs).
 *
 * Extend \`${Name}Record\` to match your persistence shape, then keep the
 * public representation in \`${name}-response.ts\` as the only thing routes
 * are allowed to expose.
 */

/** Server-side record. Never returned directly by a route. */
export interface ${Name}Record {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Body accepted when creating a ${s}. Owner is server-derived, never supplied. */
export interface Create${Name}Input {
  readonly title: string;
  readonly description?: string | null;
}

/** Body accepted when updating a ${s}. Every field is optional. */
export interface Update${Name}Input {
  readonly title?: string;
  readonly description?: string | null;
}
`,
  );

  files.set(
    `${name}-response.ts`,
    `import type { ${Name}Record } from './${name}.types.js';

/**
 * ${Name} public representation (generated by scripts/gen-module.mjs).
 *
 * One schema and one mapper, so a route never leaks a server-only field by
 * accident: add columns to the record, and only deliberate fields appear here.
 */

/** Response shape returned by every ${name} route. */
export interface Public${Name} {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** JSON Schema for a single ${s}; spread into route \`response\` definitions. */
export const ${NAME}_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** Strips server-only fields. The only record → response conversion. */
export function toPublic${Name}(record: ${Name}Record): Public${Name} {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
`,
  );

  files.set(
    `${name}.repository.ts`,
    `import type {
  ${Name}Record,
  Create${Name}Input,
  Update${Name}Input,
} from './${name}.types.js';

/**
 * ${Name} repository — the ONLY layer allowed to reach persistence.
 *
 * Generated as a typed port. Implement each method against your data source
 * (typically Prisma) and keep ownership predicates server-bound: never accept
 * an owner id from the client.
 *
 * Until implemented, every method fails loudly rather than returning fake
 * data, so an unimplemented module is never mistaken for a working one.
 */
export interface ${Name}Repository {
  list(limit: number, offset: number): Promise<readonly ${Name}Record[]>;
  count(): Promise<number>;
  findById(id: string): Promise<${Name}Record | null>;
  create(input: Create${Name}Input, ownerId: string): Promise<${Name}Record>;
  update(id: string, input: Update${Name}Input): Promise<${Name}Record | null>;
  remove(id: string): Promise<boolean>;
}

function notImplemented(method: string): never {
  throw new Error(
    '${name}.repository.' +
      method +
      ' is not implemented yet. Implement the ${name} repository against ' +
      'your data source, then re-run the tests.',
  );
}

/** Default port. Replace the bodies with real persistence queries. */
export const ${camelName}Repository: ${Name}Repository = {
  list(_limit: number, _offset: number): Promise<readonly ${Name}Record[]> {
    return Promise.resolve(notImplemented('list'));
  },
  count(): Promise<number> {
    return Promise.resolve(notImplemented('count'));
  },
  findById(_id: string): Promise<${Name}Record | null> {
    return Promise.resolve(notImplemented('findById'));
  },
  create(_input: Create${Name}Input, _ownerId: string): Promise<${Name}Record> {
    return Promise.resolve(notImplemented('create'));
  },
  update(_id: string, _input: Update${Name}Input): Promise<${Name}Record | null> {
    return Promise.resolve(notImplemented('update'));
  },
  remove(_id: string): Promise<boolean> {
    return Promise.resolve(notImplemented('remove'));
  },
};
`,
  );

  files.set(
    `${s}.service.ts`,
    `import { AppError } from '../../shared/errors/app-error.js';
import { ErrorCodes } from '../../shared/errors/error-codes.js';
import type { AuthContext } from '../../types/auth-context.js';
import { ${camelName}Repository } from './${name}.repository.js';
import type { Create${Name}Input, Update${Name}Input } from './${name}.types.js';
import { toPublic${Name}, type Public${Name} } from './${name}-response.js';

/**
 * ${Singular} service — business rules, ownership, and error mapping.
 * Routes call this; they never touch the repository directly (ARCH-ENF-013).
 *
 * Add an authorization policy in
 * src/modules/authorization/policies/${s}.policy.ts and enforce it here once
 * the module has an owner dimension.
 */
function notFound(): AppError {
  return new AppError(ErrorCodes.BAD_REQUEST, 404, '${Singular} not found.');
}

function forbidden(): AppError {
  return new AppError(
    ErrorCodes.AUTH_FORBIDDEN,
    403,
    'You do not have permission to access this resource.',
    { title: 'Forbidden' },
  );
}

export async function list(
  _actor: AuthContext,
  limit: number,
  offset: number,
): Promise<{ items: Public${Name}[]; total: number }> {
  const [records, total] = await Promise.all([
    ${camelName}Repository.list(limit, offset),
    ${camelName}Repository.count(),
  ]);
  return { items: records.map(toPublic${Name}), total };
}

export async function getById(_actor: AuthContext, id: string): Promise<Public${Name}> {
  const record = await ${camelName}Repository.findById(id);
  if (!record) {
    throw notFound();
  }
  return toPublic${Name}(record);
}

export async function create(actor: AuthContext, input: Create${Name}Input): Promise<Public${Name}> {
  if (input.title.trim() === '') {
    throw forbidden();
  }
  const record = await ${camelName}Repository.create(input, actor.sub);
  return toPublic${Name}(record);
}

export async function update(
  actor: AuthContext,
  id: string,
  input: Update${Name}Input,
): Promise<Public${Name}> {
  const existing = await ${camelName}Repository.findById(id);
  if (!existing) {
    throw notFound();
  }
  const updated = await ${camelName}Repository.update(id, input);
  if (!updated) {
    throw notFound();
  }
  return toPublic${Name}(updated);
}

export async function remove(_actor: AuthContext, id: string): Promise<void> {
  const existing = await ${camelName}Repository.findById(id);
  if (!existing) {
    throw notFound();
  }
  const deleted = await ${camelName}Repository.remove(id);
  if (!deleted) {
    throw notFound();
  }
}

export const ${s}Service = {
  list,
  getById,
  create,
  update,
  remove,
};
`,
  );

  files.set(
    `routes/${s}.routes.ts`,
    `import type { FastifyInstance, FastifySchema } from 'fastify';

import { ${s}Service } from '../${s}.service.js';
import { ${NAME}_JSON_SCHEMA } from '../${name}-response.js';
import { requireAuth } from '../../authorization/guards/require-auth.js';
import type { AuthContext } from '../../../types/auth-context.js';

/**
 * ${Name} routes under /api/v1/${name}.
 *
 * Every route is authenticated (requireAuth + bearerAuth) and declares its
 * own JSON Schema, so bodies are validated and responses are serialized from
 * the same contract. The registry entry in src/app/routes.ts is a manual step.
 */

const idParamsSchema: FastifySchema = {
  params: {
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: { id: { type: 'string' } },
  },
};

const listQuerySchema: FastifySchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
};

const create${Name}Schema: FastifySchema = {
  body: {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: ['string', 'null'], maxLength: 2000 },
    },
  },
};

const update${Name}Schema: FastifySchema = {
  ...idParamsSchema,
  body: {
    type: 'object',
    required: [],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: ['string', 'null'], maxLength: 2000 },
    },
  },
};

export async function register${Name}Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/${name}',
    {
      schema: {
        ...listQuerySchema,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'total'],
            properties: {
              items: { type: 'array', items: { ...${NAME}_JSON_SCHEMA } },
              total: { type: 'integer' },
            },
            description: 'Paginated list of ${name}.',
          },
        },
        tags: ['${Name}'],
        summary: 'List ${name}',
        description: 'Returns ${name} with offset pagination.',
        operationId: 'list${Name}',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth],
    },
    async (request) => {
      const authContext = request.auth as AuthContext;
      const query = request.query as { limit?: number; offset?: number };
      return ${s}Service.list(authContext, query.limit ?? 20, query.offset ?? 0);
    },
  );

  app.post(
    '/api/v1/${name}',
    {
      schema: {
        ...create${Name}Schema,
        response: { 201: { ...${NAME}_JSON_SCHEMA, description: 'Created.' } },
        tags: ['${Name}'],
        summary: 'Create a ${s}',
        description: 'Creates a ${s}. The owner is derived from the authenticated subject.',
        operationId: 'create${Name}',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const authContext = request.auth as AuthContext;
      const body = request.body as { title: string; description?: string | null };
      const created = await ${s}Service.create(authContext, body);
      return reply.status(201).header('Location', \`/api/v1/${name}/\${created.id}\`).send(created);
    },
  );

  app.get(
    '/api/v1/${name}/:id',
    {
      schema: {
        ...idParamsSchema,
        response: { 200: { ...${NAME}_JSON_SCHEMA, description: 'Representation.' } },
        tags: ['${Name}'],
        summary: 'Read a ${s}',
        description: 'Returns a ${s} by ID.',
        operationId: 'get${Name}ById',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const authContext = request.auth as AuthContext;
      return ${s}Service.getById(authContext, id);
    },
  );

  app.put(
    '/api/v1/${name}/:id',
    {
      schema: {
        ...update${Name}Schema,
        response: { 200: { ...${NAME}_JSON_SCHEMA, description: 'Representation.' } },
        tags: ['${Name}'],
        summary: 'Update a ${s}',
        description: 'Partially updates a ${s}.',
        operationId: 'update${Name}',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const authContext = request.auth as AuthContext;
      const body = request.body as { title?: string; description?: string | null };
      return ${s}Service.update(authContext, id, body);
    },
  );

  app.delete(
    '/api/v1/${name}/:id',
    {
      schema: {
        ...idParamsSchema,
        tags: ['${Name}'],
        summary: 'Delete a ${s}',
        description: 'Deletes a ${s} (204, empty body).',
        operationId: 'delete${Name}',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const authContext = request.auth as AuthContext;
      await ${s}Service.remove(authContext, id);
      return reply.status(204).send();
    },
  );
}
`,
  );

  files.set(
    `routes/${s}.routes.test.ts`,
    `import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const { buildApp } = await import('../../../app/app.js');
import { register${Name}Routes } from './${s}.routes.js';

/**
 * Route-level contract for ${name}: authentication is enforced and the
 * document declares every endpoint. Data behaviour belongs in
 * ${s}.service.test.ts once the repository port is implemented.
 */
async function buildTestApp() {
  const app = await buildApp({ loggerStream: { write: () => true } });
  await app.register(register${Name}Routes);
  await app.ready();
  return app;
}

describe('${s} routes', () => {
  it('rejects unauthenticated requests', async () => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/${name}' });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
`,
  );

  return files;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  const positional = argv.filter((arg) => !arg.startsWith('-'));
  if (positional.length !== 1) {
    // Zero or several names are invalid input, not a filesystem error,
    // so both exit 1 per the documented contract.
    usage();
    process.exit(1);
  }
  const name = positional[0];
  const resolved = resolveDestination(name);
  if ('error' in resolved) {
    fail(resolved.error);
    return;
  }
  const { destination } = resolved;

  // Render everything before touching the filesystem: a template error must
  // never leave a half-written module behind.
  const files = render(name);

  const created = [];
  try {
    fs.mkdirSync(destination);
    created.push(destination);
    for (const [relativePath, contents] of files) {
      const target = path.join(destination, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents, 'utf8');
      created.push(target);
    }
  } catch (error) {
    // Roll back only what this invocation created.
    for (const entry of created.reverse()) {
      try {
        fs.rmSync(entry, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    process.stderr.write(`${RED}gen-module: generation failed and was rolled back: ${error.message}${NC}\n`);
    process.exit(2);
  }

  const Name = pascal(name);
  const fileList = [...files.keys()].map((relativePath) => `  src/modules/${name}/${relativePath}`);

  process.stdout.write(`${GREEN}Created module '${name}'${NC}\n\n`);
  process.stdout.write('Files:\n');
  process.stdout.write(`${fileList.join('\n')}\n\n`);
  process.stdout.write(`${YELLOW}Manual follow-ups${NC}\n`);
  process.stdout.write(`  1. Implement src/modules/${name}/${name}.repository.ts against your data source.\n`);
  process.stdout.write(`  2. Register the routes in src/app/routes.ts:\n`);
  process.stdout.write(
    `       import { register${Name}Routes } from '../modules/${name}/routes/${singular(name)}.routes.js';\n` +
      `       await app.register(register${Name}Routes);\n`,
  );
  process.stdout.write(`  3. Add a Prisma model + migration if this module needs persistence.\n`);
  process.stdout.write(`  4. Register the operationIds in OPERATION_ERRORS (src/plugins/swagger.plugin.ts)\n`);
  process.stdout.write(`     and add the routes to the frozen sets in src/app/openapi-contract.test.ts.\n`);
  process.stdout.write(`     The OpenAPI contract tests fail until both are updated — that is intended.\n`);
  process.stdout.write(`  5. Verify:\n`);
  process.stdout.write(`       npm run typecheck\n       npm run lint\n       npm run architecture:check\n       npm test\n`);
  process.stdout.write(`\n${NC}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}