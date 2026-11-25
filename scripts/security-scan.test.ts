/**
 * Self-tests for scripts/security-scan.cjs (M5.8).
 *
 * Black-box tests: each case builds an isolated fixture tree under the OS
 * temporary directory, runs the scanner as a subprocess with --root
 * pointing at the fixture, and asserts the exit code plus the expected
 * rule ID. Production sources are never modified; no fixture lives
 * under src/.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(scriptsDir, 'security-scan.cjs');

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeFixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sast-fixture-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function runScanner(root: string, extra: string[] = []): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [checker, '--root', root, ...extra], {
    encoding: 'utf8',
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  return { status: result.status, output: `${stdout}${stderr}` };
}

describe('SEC-001 dynamic code execution', () => {
  it('rejects eval()', () => {
    const root = makeFixture({
      'src/app/worker.ts': 'export function run(code: string): unknown {\n  return eval(code);\n}\n',
    });
    const result = runScanner(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('SEC-001');
  });

  it('rejects new Function()', () => {
    const root = makeFixture({
      'src/app/worker.ts':
        'export function run(code: string): unknown {\n  return new Function(code)();\n}\n',
    });
    const result = runScanner(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('SEC-001');
  });
});

describe('SEC-002 command execution', () => {
  it('rejects child_process execSync', () => {
    const root = makeFixture({
      'src/app/worker.ts':
        "import { execSync } from 'node:child_process';\nexport function run(): string {\n  return execSync('ls').toString();\n}\n",
    });
    const result = runScanner(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('SEC-002');
  });
});

describe('SEC-003 insecure randomness', () => {
  it('rejects Math.random in production sources', () => {
    const root = makeFixture({
      'src/modules/auth/services/token.service.ts':
        'export function makeToken(): string {\n  return String(Math.random());\n}\n',
    });
    const result = runScanner(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('SEC-003');
  });

  it('ignores Math.random in test files', () => {
    const root = makeFixture({
      'src/modules/auth/services/token.service.test.ts':
        "import { expect, it } from 'vitest';\nit('works', () => {\n  expect(Math.random()).toBeDefined();\n});\n",
    });
    const result = runScanner(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS SEC-003');
  });
});

describe('SEC-004 weak hashing', () => {
  it('rejects md5 via createHash', () => {
    const root = makeFixture({
      'src/modules/auth/services/hash.service.ts':
        "import { createHash } from 'node:crypto';\nexport function h(v: string): string {\n  return createHash('md5').update(v).digest('hex');\n}\n",
    });
    const result = runScanner(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('SEC-004');
  });

  it('allows sha256', () => {
    const root = makeFixture({
      'src/modules/auth/services/hash.service.ts':
        "import { createHash } from 'node:crypto';\nexport function h(v: string): string {\n  return createHash('sha256').update(v).digest('hex');\n}\n",
    });
    const result = runScanner(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS SEC-004');
  });
});

describe('SEC-005 raw SQL interpolation', () => {
  it('rejects interpolated $executeRawUnsafe', () => {
    const root = makeFixture({
      'src/modules/users/user.repository.ts':
        'declare const prisma: { $executeRawUnsafe(q: string): Promise<unknown> };\nexport function byEmail(email: string): Promise<unknown> {\n  return prisma.$executeRawUnsafe(`SELECT * FROM "User" WHERE email = ${email}`);\n}\n',
    });
    const result = runScanner(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('SEC-005');
  });

  it('allows static raw SQL strings', () => {
    const root = makeFixture({
      'src/modules/users/user.repository.ts':
        'declare const prisma: { $executeRawUnsafe(q: string): Promise<unknown> };\nexport function ping(): Promise<unknown> {\n  return prisma.$executeRawUnsafe(`SELECT 1`);\n}\n',
    });
    const result = runScanner(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS SEC-005');
  });
});

describe('SEC-006 hardcoded secrets', () => {
  it('rejects a secret-like literal in a token variable', () => {
    const root = makeFixture({
      'src/modules/auth/services/token.service.ts':
        'const refreshToken = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4";\nexport { refreshToken };\n',
    });
    const result = runScanner(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('SEC-006');
  });

  it('allows DUMMY_ fixtures, self-mapped codes, and placeholders', () => {
    const root = makeFixture({
      'src/modules/auth/services/auth.service.ts':
        'export const DUMMY_PASSWORD_HASH = "$2b$12$kYUTOi/zqF0FHiFZUC8GNenAyXPlQwAKE4XeZ.pNxO1A.HD.bnmVm";\n',
      'src/shared/errors/error-codes.ts':
        'export const ErrorCodes = { AUTH_X: "AUTH_X" } as const;\n',
      'src/config/example.ts':
        'export const placeholder = "replace-with-real-secret";\n',
    });
    const result = runScanner(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PASS SEC-006');
  });

  it('allows closed event-name taxonomy values but still rejects real secrets', () => {
    const allowed = makeFixture({
      'src/modules/auth/services/auth-security-events.ts':
        'export const AuthSecurityEventName = { PASSWORD_RESET_REQUESTED: "auth.password_reset.requested" } as const;\n',
    });
    const allowedResult = runScanner(allowed);
    expect(allowedResult.status).toBe(0);
    expect(allowedResult.output).toContain('PASS SEC-006');

    const denied = makeFixture({
      'src/modules/auth/services/token.service.ts':
        'const passwordResetToken = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4";\nexport { passwordResetToken };\n',
    });
    const deniedResult = runScanner(denied);
    expect(deniedResult.status).toBe(1);
    expect(deniedResult.output).toContain('SEC-006');
  });
});

describe('scanner behavior', () => {
  it('reports clean repositories with exit 0', () => {
    const root = makeFixture({
      'src/app/app.ts': 'export function ok(): number {\n  return 1;\n}\n',
    });
    const result = runScanner(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('Security verification: PASS');
  });

  it('emits machine-readable JSON with --json', () => {
    const root = makeFixture({
      'src/app/app.ts': 'export function bad(code: string): unknown {\n  return eval(code);\n}\n',
    });
    const result = runScanner(root, ['--json']);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.output) as { status: string; findings: unknown[] };
    expect(parsed.status).toBe('findings');
    expect(parsed.findings).toHaveLength(1);
  });

  it('fails closed on a missing root', () => {
    const missing = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'sast-fixture-')),
      'does-not-exist',
    );
    tempDirs.push(path.dirname(missing));
    const result = runScanner(missing);
    expect(result.status).toBe(2);
    expect(result.output).toContain('ERROR');
  });
});
