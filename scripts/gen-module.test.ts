/**
 * Tests for scripts/gen-module.mjs (M17.2).
 *
 * Every case executes the real generator as a subprocess. Success cases
 * generate into a temporary sandbox module directory and assert the produced
 * files; failure cases assert a non-zero exit AND that no files were created.
 * The repository's own src/modules/ is never used as a write target except by
 * the single architecture-integration case, which is cleaned up afterwards.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = path.join(repoRoot, 'scripts', 'gen-module.mjs');

const temps: string[] = [];

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function run(args: string[], cwd = repoRoot): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [generator, ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Run the generator against an isolated copy of the module tree so a success
 * case never writes into the repository.
 */
function runInSandbox(name: string): { status: number; stdout: string; stderr: string; modulesDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-genmod-'));
  temps.push(dir);
  const modulesDir = path.join(dir, 'src', 'modules');
  fs.mkdirSync(modulesDir, { recursive: true });
  // The generator resolves MODULES_DIR relative to its own location, so point
  // it at a copy placed inside the sandbox's scripts/ directory.
  const scriptsDir = path.join(dir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(generator, path.join(scriptsDir, 'gen-module.mjs'));
  const result = spawnSync('node', [path.join(scriptsDir, 'gen-module.mjs'), name], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', modulesDir };
}

describe('gen-module.mjs — interface', () => {
  it('prints usage with --help and exits 0', () => {
    const { status, stdout } = run(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: node scripts/gen-module.mjs <name>');
    expect(stdout).toContain('never overwrites');
  });

  it('exits non-zero with usage when no name is given', () => {
    const { status, stdout } = run([]);
    expect(status).not.toBe(0);
    expect(stdout).toContain('Usage:');
  });

  it('exits 1 (invalid input, not filesystem error) for zero or several names', () => {
    expect(run([]).status).toBe(1);
    expect(run(['blog-posts', 'other']).status).toBe(1);
  });
});

describe('gen-module.mjs — valid generation', () => {
  it('creates the expected directory and file set', () => {
    const { status, modulesDir } = runInSandbox('blog-posts');
    expect(status).toBe(0);
    const files = fs
      .readdirSync(path.join(modulesDir, 'blog-posts'), { recursive: true } as { recursive: true })
      .map(String)
      .filter((entry) => !entry.endsWith(path.sep) && entry !== 'routes')
      .sort();
    expect(files).toEqual(
      [
        'blog-posts-response.ts',
        'blog-posts.repository.ts',
        'blog-posts.types.ts',
        'posts.service.ts',
        'routes/posts.routes.test.ts',
        'routes/posts.routes.ts',
      ].sort(),
    );
  });

  it('follows project conventions (routes/, register fn, /api/v1, requireAuth)', () => {
    const { status, modulesDir } = runInSandbox('blog-posts');
    expect(status).toBe(0);
    const routes = fs.readFileSync(path.join(modulesDir, 'blog-posts', 'routes', 'posts.routes.ts'), 'utf8');
    expect(routes).toContain('export async function registerBlogPostsRoutes');
    expect(routes).toContain("import { requireAuth } from '../../authorization/guards/require-auth.js'");
    expect(routes).toContain("preHandler: [requireAuth]");
    expect(routes).toContain("security: [{ bearerAuth: [] }]");
    expect(routes).toContain("'/api/v1/blog-posts'");
    expect(routes).toContain('additionalProperties: false');
    // routes must never import the repository directly (ARCH-ENF-013)
    expect(routes).not.toContain('.repository.js');
  });

  it('emits no Prisma import, no `any`, and no secret material', () => {
    const { status, modulesDir } = runInSandbox('blog-posts');
    expect(status).toBe(0);
    const dir = path.join(modulesDir, 'blog-posts');
    const all = ['blog-posts.types.ts', 'blog-posts-response.ts', 'blog-posts.repository.ts', 'posts.service.ts']
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    expect(all).not.toContain('@prisma/client');
    expect(all).not.toMatch(/\bany\b/);
    expect(all).not.toMatch(/password|secret\s*=|JWT_SECRET|api[_-]?key/i);
  });

  it('repository port fails loudly instead of returning fake data', () => {
    const { status, modulesDir } = runInSandbox('blog-posts');
    expect(status).toBe(0);
    const repo = fs.readFileSync(path.join(modulesDir, 'blog-posts', 'blog-posts.repository.ts'), 'utf8');
    expect(repo).toContain('not implemented yet');
    // no fake records returned
    expect(repo).not.toContain('id: \'fake');
  });

  it('prints the exact manual follow-ups without claiming checks ran', () => {
    const { status, stdout } = runInSandbox('blog-posts');
    expect(status).toBe(0);
    expect(stdout).toContain('Manual follow-ups');
    expect(stdout).toContain('src/app/routes.ts');
    expect(stdout).toContain('npm run architecture:check');
  });

  it('tells the user about both frozen tables a new route must update', () => {
    // docs/development.md rule 6: new routes must be added to
    // OPERATION_ERRORS (swagger.plugin.ts) and to the frozen contract sets
    // in openapi-contract.test.ts. Omitting these would silently mislead.
    const { status, stdout } = runInSandbox('blog-posts');
    expect(status).toBe(0);
    expect(stdout).toContain('OPERATION_ERRORS');
    expect(stdout).toContain('swagger.plugin.ts');
    expect(stdout).toContain('openapi-contract.test.ts');
  });

  it('uses a valid identifier when the module name is multi-segment', () => {
    const { status, modulesDir } = runInSandbox('blog-posts');
    expect(status).toBe(0);
    const repo = fs.readFileSync(path.join(modulesDir, 'blog-posts', 'blog-posts.repository.ts'), 'utf8');
    // camelCase, not kebab-case (which would be an invalid TS identifier)
    expect(repo).toContain('export const blogPostsRepository');
    expect(repo).not.toContain('blog-postsRepository');
  });
});

describe('gen-module.mjs — invalid input', () => {
  const rejected: Array<[string, string]> = [
    ['empty', ''],
    ['path traversal', '../evil'],
    ['nested traversal', 'a/../../b'],
    ['absolute path', '/etc/passwd'],
    ['separator', 'foo/bar'],
    ['backslash', 'foo\\bar'],
    ['underscore', 'my_module'],
    ['uppercase', 'MyModule'],
    ['leading digit', '9lives'],
    ['space', 'my module'],
    ['reserved auth', 'auth'],
    ['reserved notes', 'notes'],
    ['existing module', 'users'],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label} and writes nothing`, () => {
      const { status, stderr, modulesDir } = runInSandbox(value);
      expect(status).toBe(1);
      expect(stderr).toContain('gen-module:');
      expect(fs.readdirSync(modulesDir)).toEqual([]);
    });
  }
});

describe('gen-module.mjs — filesystem safety', () => {
  it('refuses to overwrite an existing module directory', () => {
    const first = runInSandbox('blog-posts');
    expect(first.status).toBe(0);
    const target = path.join(first.modulesDir, 'blog-posts');
    fs.writeFileSync(path.join(target, 'CUSTOM.txt'), 'do not lose me', 'utf8');

    // Re-run the generator inside the same sandbox: it must refuse.
    const sandboxRoot = path.join(first.modulesDir, '..', '..');
    const sandboxScript = path.join(sandboxRoot, 'scripts', 'gen-module.mjs');
    const rerun = spawnSync('node', [sandboxScript, 'blog-posts'], {
      cwd: sandboxRoot,
      encoding: 'utf8',
    });
    expect(rerun.status).toBe(1);
    expect(rerun.stderr).toContain('already exists');
    // Pre-existing file survives untouched.
    expect(fs.readFileSync(path.join(target, 'CUSTOM.txt'), 'utf8')).toBe('do not lose me');
  });

  it('writes only inside src/modules', () => {
    const { status, modulesDir } = runInSandbox('blog-posts');
    expect(status).toBe(0);
    const entries = fs.readdirSync(modulesDir);
    expect(entries).toEqual(['blog-posts']);
  });
});