/**
 * Self-tests for scripts/architecture-check.cjs (M1.7).
 *
 * Black-box tests: each case builds an isolated fixture tree under the OS
 * temporary directory, runs the checker as a subprocess with --root pointing
 * at the fixture, and asserts the exit code plus the expected rule ID.
 * Production sources are never modified; no fixture lives under src/.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const checker = path.join(scriptsDir, 'architecture-check.cjs');

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeFixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-fixture-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function runChecker(root: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  return { status: result.status, output: `${stdout}${stderr}` };
}

describe('ARCH-ENF-001 cross-module repository imports', () => {
  it('rejects users importing an auth repository', () => {
    const root = makeFixture({
      'src/modules/users/users.service.ts':
        "import { credentialRepository } from '../auth/repositories/credential.repository.js';\nexport const usersService = { credentialRepository };\n",
      'src/modules/auth/repositories/credential.repository.ts': 'export const credentialRepository = {};\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-001');
    expect(result.output).toContain('users.service.ts');
  });

  it('allows users importing the auth public service contract', () => {
    const root = makeFixture({
      'src/modules/users/users.service.ts':
        "import { credentialService } from '../auth/services/credential.service.js';\nexport const usersService = { credentialService };\n",
      'src/modules/auth/services/credential.service.ts': 'export const credentialService = {};\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-001');
  });
});

describe('ARCH-ENF-002 transaction ownership', () => {
  const txBody =
    'declare const prisma: { $transaction: (fn: () => void) => void };\nexport function run(): void {\n  prisma.$transaction(() => undefined);\n}\n';

  it('rejects $transaction in a repository', () => {
    const root = makeFixture({
      'src/modules/auth/repositories/credential.repository.ts': txBody,
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-002');
  });

  it('rejects $transaction in a route', () => {
    const root = makeFixture({
      'src/modules/users/routes/user.routes.ts': txBody,
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-002');
  });

  it('rejects $transaction in a plugin', () => {
    const root = makeFixture({
      'src/plugins/worker.plugin.ts': txBody,
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-002');
  });

  it('allows $transaction in a services/ directory file', () => {
    const root = makeFixture({
      'src/modules/auth/services/auth.service.ts': txBody,
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-002');
  });

  it('allows $transaction in a module-root *.service.ts file', () => {
    const root = makeFixture({
      'src/modules/users/users.service.ts': txBody,
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-002');
  });
});

describe('ARCH-ENF-003 PrismaClient ownership', () => {
  it('rejects construction in a service', () => {
    const root = makeFixture({
      'src/modules/users/users.service.ts':
        "import { PrismaClient } from '@prisma/client';\nexport const prisma = new PrismaClient();\n",
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-003');
  });

  it('allows construction in platform/database/prisma.ts', () => {
    const root = makeFixture({
      'src/platform/database/prisma.ts':
        "import { PrismaClient } from '@prisma/client';\nexport const prisma = new PrismaClient();\n",
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-003');
  });

  it('allows construction in an explicitly gated integration test', () => {
    const root = makeFixture({
      'src/modules/users/users.service.integration.test.ts':
        "import { PrismaClient } from '@prisma/client';\nimport { beforeAll, describe, expect, it } from 'vitest';\nconst prisma = new PrismaClient();\nbeforeAll(async (ctx) => {\n  try {\n    await prisma.$queryRaw`SELECT 1`;\n  } catch {\n    ctx.skip();\n  }\n});\ndescribe('gated', () => {\n  it('works', () => {\n    expect(1).toBe(1);\n  });\n});\n",
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-003');
    expect(result.output).toContain('PASS ARCH-ENF-011');
  });
});

describe('ARCH-ENF-004 process.env ownership', () => {
  it('rejects member access in a module service', () => {
    const root = makeFixture({
      'src/modules/auth/services/auth.service.ts':
        'const secret = process.env.JWT_SECRET;\nexport { secret };\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-004');
  });

  it('rejects element access in a plugin', () => {
    const root = makeFixture({
      'src/plugins/worker.plugin.ts': 'const url = process["REDIS_URL"];\nexport { url };\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-004');
  });

  it('rejects destructuring in a repository', () => {
    const root = makeFixture({
      'src/modules/users/user.repository.ts':
        'const { env } = process;\nexport { env };\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-004');
  });

  it('allows access in src/config', () => {
    const root = makeFixture({
      'src/config/index.ts': 'const url = process.env.DATABASE_URL;\nexport { url };\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-004');
  });
});

describe('ARCH-ENF-005 leaf-layer isolation', () => {
  it('rejects src/types importing a business module', () => {
    const root = makeFixture({
      'src/types/holder.ts':
        "import type { User } from '../modules/users/user.types.js';\nexport type { User };\n",
      'src/modules/users/user.types.ts': 'export type User = { id: string };\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-005');
  });

  it('allows neutral types importing each other', () => {
    const root = makeFixture({
      'src/types/a.ts': "import type { B } from './b.js';\nexport type A = B;\n",
      'src/types/b.ts': 'export type B = string;\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-005');
  });
});

describe('ARCH-ENF-006 legacy root prohibition', () => {
  it('rejects an existing legacy directory', () => {
    const root = makeFixture({
      'src/modules/users/users.service.ts': 'export const usersService = {};\n',
      'src/cache/legacy.ts': 'export const legacy = 1;\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-006');
  });

  it('rejects imports into a legacy root', () => {
    const root = makeFixture({
      'src/modules/users/users.service.ts':
        "import { legacy } from '../../common/legacy.js';\nexport const usersService = { legacy };\n",
      'src/common/legacy.ts': 'export const legacy = 1;\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-006');
  });
});

describe('ARCH-ENF-007 circular dependency prohibition', () => {
  it('rejects a two-file cycle with the full path', () => {
    const root = makeFixture({
      'src/cycle-a.ts': "import './cycle-b.js';\nexport const a = 1;\n",
      'src/cycle-b.ts': "import './cycle-a.js';\nexport const b = 2;\n",
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-007');
    expect(result.output).toContain('cycle-a.ts');
    expect(result.output).toContain('cycle-b.ts');
  });

  it('allows a linear chain without false positives', () => {
    const root = makeFixture({
      'src/chain-a.ts': "import './chain-b.js';\nexport const a = 1;\n",
      'src/chain-b.ts': "import './chain-c.js';\nexport const b = 2;\n",
      'src/chain-c.ts': 'export const c = 3;\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-007');
  });
});

describe('ARCH-ENF-008 zero-byte file prohibition', () => {
  it('rejects an empty source file', () => {
    const root = makeFixture({
      'src/modules/users/users.service.ts': 'export const usersService = {};\n',
      'src/empty.ts': '',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-008');
    expect(result.output).toContain('empty.ts');
  });
});

describe('ARCH-ENF-009 .gitkeep prohibition', () => {
  it('rejects a .gitkeep file', () => {
    const root = makeFixture({
      'src/modules/users/users.service.ts': 'export const usersService = {};\n',
      'src/modules/future/.gitkeep': 'placeholder\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('FAIL ARCH-ENF-009');
    expect(result.output).not.toContain('FAIL ARCH-ENF-008');
  });
});

describe('ARCH-ENF-010 speculative scaffolding detection', () => {
  it('rejects an empty architecture directory', () => {
    const root = makeFixture({
      'src/modules/users/users.service.ts': 'export const usersService = {};\n',
    });
    fs.mkdirSync(path.join(root, 'src', 'modules', 'ghost'), { recursive: true });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-010');
  });

  it('rejects a comment-only source file', () => {
    const root = makeFixture({
      'src/modules/users/users.service.ts': 'export const usersService = {};\n',
      'src/modules/users/future.ts': '// TODO: implement later\n/* nothing here yet */\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-010');
  });
});

describe('ARCH-ENF-011 integration DB gating', () => {
  it('rejects an integration test without an explicit gate', () => {
    const root = makeFixture({
      'src/modules/users/users.service.integration.test.ts':
        "import { describe, expect, it } from 'vitest';\ndescribe('ungated', () => {\n  it('works', () => {\n    expect(1).toBe(1);\n  });\n});\n",
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-011');
  });

  it('allows an integration test gated with ctx.skip()', () => {
    const root = makeFixture({
      'src/modules/users/users.service.integration.test.ts':
        "import { beforeAll, describe, expect, it } from 'vitest';\nbeforeAll(async (ctx) => {\n  try {\n    await Promise.resolve();\n  } catch {\n    ctx.skip();\n  }\n});\ndescribe('gated', () => {\n  it('works', () => {\n    expect(1).toBe(1);\n  });\n});\n",
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-011');
  });
});

describe('ARCH-ENF-012 policy boundary isolation', () => {
  const cleanService =
    'export const authorizationService = { can: async (): Promise<boolean> => true };\n';
  const cleanPolicy =
    "import type { AuthContext } from '../../../types/auth-context.js';\n" +
    "import { authorizationService } from '../services/authorization.service.js';\n" +
    'export async function canReadUser(authContext: AuthContext, id: string): Promise<boolean> {\n' +
    '  return authorizationService.can(authContext, id);\n' +
    '}\n';
  const authContextType =
    'export type AuthContext = { sub: string; iat: number; exp: number };\n';

  it('rejects a policy importing the persistence layer', () => {
    const root = makeFixture({
      'src/modules/authorization/policies/user.policy.ts':
        "import { prisma } from '../../../platform/database/prisma.js';\nexport const userPolicy = { prisma };\n",
      'src/platform/database/prisma.ts': 'export const prisma = {};\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-012');
  });

  it('rejects a policy importing a repository', () => {
    const root = makeFixture({
      'src/modules/authorization/policies/user.policy.ts':
        "import { usersRepository } from '../../users/repositories/users.repository.js';\nexport const userPolicy = { usersRepository };\n",
      'src/modules/users/repositories/users.repository.ts':
        'export const usersRepository = {};\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-012');
  });

  it('rejects a policy importing Fastify', () => {
    const root = makeFixture({
      'src/modules/authorization/policies/user.policy.ts':
        "import type { FastifyRequest } from 'fastify';\nexport function check(request: FastifyRequest): boolean {\n  return request !== null;\n}\n",
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-012');
  });

  it('rejects $transaction inside a policy', () => {
    const root = makeFixture({
      'src/modules/authorization/policies/user.policy.ts':
        'declare const prisma: { $transaction: (fn: () => void) => void };\nexport function run(): void {\n  prisma.$transaction(() => undefined);\n}\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-012');
  });

  it('allows a policy deciding on trusted inputs via the service contract', () => {
    const root = makeFixture({
      'src/types/auth-context.ts': authContextType,
      'src/modules/authorization/policies/user.policy.ts': cleanPolicy,
      'src/modules/authorization/services/authorization.service.ts': cleanService,
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-012');
  });
});

describe('ARCH-ENF-013 route-layer persistence isolation', () => {
  it('rejects a route importing its own module repository', () => {
    const root = makeFixture({
      'src/modules/users/routes/user.routes.ts':
        "import { usersRepository } from '../user.repository.js';\nexport const routes = { usersRepository };\n",
      'src/modules/users/user.repository.ts': 'export const usersRepository = {};\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-013');
  });

  it('rejects a route importing another module repository', () => {
    const root = makeFixture({
      'src/modules/users/routes/user.routes.ts':
        "import { credentialRepository } from '../../auth/repositories/credential.repository.js';\nexport const routes = { credentialRepository };\n",
      'src/modules/auth/repositories/credential.repository.ts':
        'export const credentialRepository = {};\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-013');
  });

  it('allows a route using the service contract', () => {
    const root = makeFixture({
      'src/modules/users/routes/user.routes.ts':
        "import { usersService } from '../users.service.js';\nexport const routes = { usersService };\n",
      'src/modules/users/users.service.ts': 'export const usersService = {};\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-013');
  });
});

describe('checker contract', () => {
  it('passes the current valid repository architecture', () => {
    const result = runChecker(repoRoot);
    expect(result.status).toBe(0);
    expect(result.output).toContain('Architecture verification: PASS');
  });

describe('ARCH-ENF-014 console logging prohibition', () => {
  it('rejects console.log in a service', () => {
    const root = makeFixture({
      'src/modules/auth/services/auth.service.ts':
        'export function run(): void {\n  console.log("debug");\n}\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-014');
  });

  it('rejects console.error in a plugin', () => {
    const root = makeFixture({
      'src/plugins/worker.plugin.ts': 'export function fail(e: unknown): void {\n  console.error(e);\n}\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-014');
  });

  it('allows console usage in test files', () => {
    const root = makeFixture({
      'src/modules/auth/services/auth.service.test.ts':
        "import { expect, it } from 'vitest';\nit('works', () => {\n  console.log('debug');\n  expect(1).toBe(1);\n});\n",
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-014');
  });
});

describe('ARCH-ENF-015 error envelope ownership', () => {
  it('rejects a route building a problem-details body inline', () => {
    const root = makeFixture({
      'src/modules/users/routes/user.routes.ts':
        'import type { FastifyInstance, FastifyReply } from "fastify";\nexport async function register(app: FastifyInstance): Promise<void> {\n  app.get("/x", async (_request, reply: FastifyReply) => {\n    return reply.status(403).send({\n      type: "https://docs.oxyide.com/errors/forbidden",\n      title: "Forbidden",\n      status: 403,\n      detail: "No.",\n      code: "AUTH_FORBIDDEN",\n    });\n  });\n}\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-015');
  });

  it('allows envelope construction inside the mapper module', () => {
    const root = makeFixture({
      'src/shared/errors/error-mapper.ts':
        'import type { FastifyReply } from "fastify";\nexport function sendMappedError(reply: FastifyReply, type: string): void {\n  reply.status(403).send({\n    type: "https://docs.oxyide.com/errors/forbidden",\n    title: type,\n  });\n}\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS ARCH-ENF-015');
  });
});

describe('ARCH-ENF-016 email template purity', () => {
  const PURE_TEMPLATE =
    'export function render(data: { resetUrl: string }): string {\n  return `<p>${data.resetUrl}</p>`;\n}\n';

  it('allows a pure template', () => {
    const root = makeFixture({
      'src/shared/email/templates/email-templates.ts': PURE_TEMPLATE,
      'src/shared/email/templates/html-escape.ts':
        'export function escapeHtml(value: string): string {\n  return value.replace(/</g, "&lt;");\n}\n',
    });
    const result = runChecker(root);
    expect(result.output).toContain('PASS ARCH-ENF-016');
    expect(result.status).toBe(0);
  });

  it('rejects a template that imports the configuration layer', () => {
    const root = makeFixture({
      'src/shared/email/templates/email-templates.ts':
        "import { config } from '../../../config/index.js';\n" + PURE_TEMPLATE,
      'src/config/index.ts': 'export const config = { appBaseUrl: "https://x.example" };\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-016');
  });

  it('rejects a template that imports the SMTP transport layer', () => {
    const root = makeFixture({
      'src/shared/email/templates/email-templates.ts':
        "import { createEmailProvider } from '../../../platform/email/smtp-email-provider.js';\nexport const x = createEmailProvider;\n",
      'src/platform/email/smtp-email-provider.ts':
        'export function createEmailProvider(): void {}\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-016');
  });

  it('rejects a template that imports nodemailer', () => {
    const root = makeFixture({
      'src/shared/email/templates/email-templates.ts':
        "import { createTransport } from 'nodemailer';\nexport const x = createTransport;\n",
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-016');
  });

  it('rejects a template that imports a business module', () => {
    const root = makeFixture({
      'src/shared/email/templates/email-templates.ts':
        "import { config } from '../../../modules/auth/services/security-notification.service.js';\nexport const x = config;\n",
      'src/modules/auth/services/security-notification.service.ts':
        'export const config = 1;\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-016');
  });

  it('rejects a template that reads the clock or uses randomness', () => {
    const root = makeFixture({
      'src/shared/email/templates/email-templates.ts':
        'export function at(): number {\n  return Date.now();\n}\nexport function pick(): number {\n  return Math.random();\n}\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-016');
  });

  it('rejects a template that logs', () => {
    const root = makeFixture({
      'src/shared/email/templates/email-templates.ts':
        'export function render(): string {\n  console.log("rendered");\n  return "x";\n}\n',
    });
    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ARCH-ENF-016');
  });

  it('does not flag prose that merely mentions a clock or a logger', () => {
    const root = makeFixture({
      'src/shared/email/templates/email-templates.ts':
        '/**\n * Templates never read the clock and never call a logger: a date would\n * make rendering non-deterministic.\n */\n' +
        PURE_TEMPLATE,
    });
    const result = runChecker(root);
    expect(result.output).toContain('PASS ARCH-ENF-016');
    expect(result.status).toBe(0);
  });

  it('does not constrain the adapter that calls templates', () => {
    const root = makeFixture({
      'src/shared/email/templates/email-templates.ts': PURE_TEMPLATE,
      'src/shared/email/templates/email-template-registry.ts':
        "export { renderEmailTemplate } from './email-templates.js';\n",
      'src/modules/auth/email/auth-email-mailers.ts':
        "import { config } from '../../../config/index.js';\nimport { renderEmailTemplate } from '../../../shared/email/templates/email-template-registry.js';\nexport const x = { config, renderEmailTemplate };\n",
      'src/config/index.ts': 'export const config = { nodeEnv: "test" };\n',
    });
    const result = runChecker(root);
    expect(result.output).toContain('PASS ARCH-ENF-016');
    expect(result.status).toBe(0);
  });
});

  it('fails closed on a missing root', () => {    const missing = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'arch-fixture-')),
      'does-not-exist',
    );
    tempDirs.push(path.dirname(missing));
    const result = runChecker(missing);
    expect(result.status).toBe(2);
    expect(result.output).toContain('ERROR');
  });

  it('produces deterministic output', () => {
    const first = runChecker(repoRoot);
    const second = runChecker(repoRoot);
    expect(first.status).toBe(0);
    expect(second.output).toBe(first.output);
  });
});
