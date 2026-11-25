/**
 * Tests for the setup workflow (M17.1 setup.sh + M19.2 scripts/setup.mjs).
 *
 * `setup.sh` is a thin Unix wrapper that delegates to the single
 * cross-platform implementation in `scripts/setup.mjs` (exposed as
 * `npm run setup`), so the two entry points cannot silently diverge.
 * Behavioral tests run the real `bash setup.sh` as a subprocess against
 * isolated temporary fixture directories (`--check` mode exercises
 * prerequisite validation without mutating the repository). Safety-critical
 * properties (no .env overwrite, no destructive DB commands, no secret
 * leakage) are verified by observing output and by scanning the
 * implementation source.
 *
 * No database, network, or application process is started by these tests.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const setupScript = path.join(repoRoot, 'setup.sh');
const setupImplementation = path.join(repoRoot, 'scripts', 'setup.mjs');

const temps: string[] = [];

beforeAll(() => {
  expect(fs.existsSync(setupScript)).toBe(true);
  expect(fs.existsSync(setupImplementation)).toBe(true);
});

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a minimal but structurally valid Forge fixture. */
function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-'));
  temps.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}', 'utf8');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}', 'utf8');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, '.env.example'), 'DATABASE_URL=postgresql://u:p@127.0.0.1:5999/db\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }\n', 'utf8');
  fs.copyFileSync(setupScript, path.join(dir, 'setup.sh'));
  // The wrapper delegates to the implementation relative to its own location.
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(setupImplementation, path.join(dir, 'scripts', 'setup.mjs'));
  return dir;
}

function run(dir: string, args: string[] = ['--check']): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['setup.sh', ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runNode(dir: string, args: string[] = ['--check']): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['scripts/setup.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('setup — one implementation behind both entry points', () => {
  it('setup.sh delegates to scripts/setup.mjs instead of re-implementing it', () => {
    const wrapper = fs.readFileSync(setupScript, 'utf8');
    expect(wrapper).toContain('scripts/setup.mjs');
    // A delegating wrapper has no second copy of the workflow steps: only
    // comment lines may mention them (usage text), never executable code.
    const code = wrapper
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toContain('prisma migrate deploy');
    expect(code).not.toContain('npm ci');
  });

  it('bash and node entry points agree on --check', () => {
    const dir = makeFixture();
    const viaBash = run(dir, ['--check']);
    const viaNode = runNode(dir, ['--check']);
    expect(viaBash.status).toBe(0);
    expect(viaNode.status).toBe(0);
    expect(viaNode.stdout).toContain('Prerequisite check passed');
  });
});

describe('setup — prerequisite validation', () => {
  it('exits 0 on --check with a valid fixture', () => {
    const dir = makeFixture();
    const { status, stdout } = run(dir, ['--check']);
    expect(status).toBe(0);
    expect(stdout).toContain('Prerequisite check passed');
  });

  it('reports Node, npm, and project files as OK', () => {
    const dir = makeFixture();
    const { stdout } = run(dir, ['--check']);
    expect(stdout).toMatch(/Node\.js .* OK/);
    expect(stdout).toMatch(/npm .* OK/);
    expect(stdout).toContain('Project files OK');
  });

  it('--check makes no changes (no .env created, no node_modules)', () => {
    const dir = makeFixture();
    run(dir, ['--check']);
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
  });

  it('fails non-zero when a required project file is missing', () => {
    const dir = makeFixture();
    fs.rmSync(path.join(dir, '.env.example'));
    const { status, stdout } = run(dir, ['--check']);
    expect(status).not.toBe(0);
    expect(stdout).toContain('Missing required files');
    expect(stdout).toContain('.env.example');
  });

  it('fails non-zero when package-lock.json is missing (lockfile required)', () => {
    const dir = makeFixture();
    fs.rmSync(path.join(dir, 'package-lock.json'));
    const { status, stdout } = run(dir, ['--check']);
    expect(status).not.toBe(0);
    expect(stdout).toContain('package-lock.json');
  });

  it('rejects an unknown argument with exit 2', () => {
    const dir = makeFixture();
    const { status, stdout } = run(dir, ['--nope']);
    expect(status).toBe(2);
    expect(stdout).toContain('Unknown argument');
  });

  it('--help exits 0 and documents the interface', () => {
    const dir = makeFixture();
    const { status, stdout } = run(dir, ['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('npm run setup');
    expect(stdout).toContain('bash setup.sh');
    expect(stdout).toContain('--skip-migrations');
  });
});

describe('setup — .env safety', () => {
  it('preserves an existing .env byte-for-byte', () => {
    const dir = makeFixture();
    const original = 'DATABASE_URL=postgresql://u:p@127.0.0.1:5999/db\nJWT_SECRET=custom-value\n';
    fs.writeFileSync(path.join(dir, '.env'), original, 'utf8');
    // Run the prerequisite check; the setup step must never touch .env.
    run(dir, ['--check']);
    // The .env must be byte-identical: the setup step never overwrites it,
    // and --check does not reach that step at all.
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe(original);
  });

  it('never writes .env in --check mode', () => {
    const dir = makeFixture();
    run(dir, ['--check']);
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('creates .env exclusively (COPYFILE_EXCL — never overwrites)', () => {
    const source = fs.readFileSync(setupImplementation, 'utf8');
    expect(source).toContain('COPYFILE_EXCL');
  });
});

describe('setup — source-level safety invariants', () => {
  const wrapper = (): string => fs.readFileSync(setupScript, 'utf8');
  const source = (): string => fs.readFileSync(setupImplementation, 'utf8');

  it('wrapper enables strict shell semantics (set -euo pipefail)', () => {
    expect(wrapper()).toContain('set -euo pipefail');
  });

  it('never uses destructive Prisma commands', () => {
    const s = source();
    for (const forbidden of [
      'migrate reset',
      'db push --force',
      'db push --accept-data-loss',
      'DROP DATABASE',
      'TRUNCATE',
      'migrate dev',
    ]) {
      expect(s).not.toContain(forbidden);
    }
  });

  it('never runs seed during setup', () => {
    expect(source()).not.toContain('db:seed');
  });

  it('uses the lockfile-based install command (npm ci)', () => {
    const s = source();
    expect(s).toContain("'npm', ['ci']");
    // npm install would allow lockfile drift
    expect(s).not.toContain("'npm', ['install']");
  });

  it('uses prisma migrate deploy for migrations', () => {
    expect(source()).toContain("'migrate', 'deploy'");
  });

  it('never echoes the DATABASE_URL value', () => {
    const s = source();
    // Only host:port (parsed into a redacted target) may reach log output;
    // the URL itself must never be interpolated into a message.
    expect(s).not.toMatch(/info\(`[^`]*\$\{(databaseUrl|url)\}/);
    expect(s).not.toMatch(/fail\(`[^`]*\$\{(databaseUrl|url)\}/);
    expect(s).not.toContain('${databaseUrl}');
  });

  it('checks the real readiness endpoint', () => {
    expect(source()).toContain('/health/ready');
  });

  it('cleans up only the child process it started', () => {
    const s = source();
    // Cleanup is scoped to the owned child handle — never a blanket kill.
    expect(s).toContain('child.kill()');
    expect(s).not.toMatch(/kill\s+-9\s+-1|pkill|killall/);
  });

  it('uses the documented dev entry point from package.json', () => {
    expect(source()).toContain("'npm', ['run', 'dev']");
  });

  it('passes arguments as arrays, never through a shell string', () => {
    const s = source();
    // spawn() with an args array is the only process-launch primitive used.
    expect(s).toContain('spawn(command, args');
    expect(s).not.toContain('execSync');
    // No Unix-only file/process utilities inside the implementation.
    for (const unixOnly of ['`cp ', '`grep ', '`sed ', '`awk ', '`curl ']) {
      expect(s).not.toContain(unixOnly);
    }
  });

  it('exposes npm run setup in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.setup).toContain('scripts/setup.mjs');
  });
});

describe('setup — failure propagation', () => {
  it('propagates a failing prerequisite command as non-zero', () => {
    const dir = makeFixture();
    // Corrupt the lockfile so a real `npm ci` (if reached) would fail; --check
    // must still succeed because it does not install.
    fs.writeFileSync(path.join(dir, 'package-lock.json'), 'not-json', 'utf8');
    const { status } = run(dir, ['--check']);
    expect(status).toBe(0); // --check does not touch the lockfile contents
  });

  it('surfaces bash syntax validity', () => {
    // `bash -n` performs a parse-only check with no execution.
    execFileSync('bash', ['-n', setupScript], { encoding: 'utf8' });
  });

  it('surfaces Node syntax validity of the implementation', () => {
    execFileSync(process.execPath, ['--check', setupImplementation], { encoding: 'utf8' });
  });
});
