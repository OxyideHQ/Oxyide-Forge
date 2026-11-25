/**
 * M13.2 — distribution artifact integrity regression suite.
 *
 * M13.1 audited the production package and found two CRITICAL defects, both
 * structural: release validation computed one file set while the packager
 * computed another (M131-F01), and the normative container artifact plus eight
 * of ten migrations could never ship because they were untracked (M131-F02,
 * M131-F03). `npm run release:check` reported PASS throughout.
 *
 * These tests pin the fixes so the class cannot return:
 *
 *   1. `scripts/dist-file-set.cjs` is the ONE place the shipped set is computed,
 *      and both `release-validate.cjs` and `package.sh` consume it — no second
 *      computation anywhere (M131-F01).
 *   2. The container artifact is a required shipped file, not merely present on
 *      disk (M131-F02).
 *   3. Every on-disk migration must ship, not "at least one" (M131-F03).
 *   4. The documented command surface resolves inside the package (M131-F04).
 *   5. Deployment verification cannot report PASS on a half-run, and does not
 *      assume a loopback database (M131-F07, M131-F11).
 *   6. The Compose stack matches what the documentation states (M131-F05, F06).
 *
 * Assertions are structural (source text, file existence, module behaviour),
 * matching the M12.8 documentation-drift approach: they pin the contract without
 * re-implementing it. Every test here corresponds to a recorded M13.2 finding.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..');

const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const distFileSet = require(path.join(scriptsDir, 'dist-file-set.cjs')) as {
  REQUIRED_FILES: string[];
  shippedFiles: () => string[];
  missingRequired: () => { missing: string[]; missingMigrations: string[] };
  onDiskMigrationDirectories: () => string[];
};

// ---------------------------------------------------------------------------
// 1. Single source of truth for the shipped file set (M131-F01)
// ---------------------------------------------------------------------------

describe('the shipped file set is computed in exactly one place', () => {
  it('release-validate.cjs consumes the shared module', () => {
    const source = read('scripts/release-validate.cjs');
    expect(source).toContain("require('./dist-file-set.cjs')");
  });

  it('release-validate.cjs no longer computes its own file list', () => {
    const source = read('scripts/release-validate.cjs');
    // A second computation is exactly what made validation and packaging
    // disagree while both reported success.
    expect(source).not.toMatch(/git\(\['ls-files'\]/);
    expect(source).not.toMatch(/\.split\('\\n'\)\s*\.filter\(Boolean\)/);
    expect(source).not.toMatch(/distignore\s*$/m);
  });

  it('package.sh stages the shared list instead of tarring the working tree', () => {
    const source = read('scripts/package.sh');
    expect(source).toContain('dist-file-set.cjs');
    // The original copied the whole working tree, which is how 179 untracked
    // files would have reached the artifact.
    expect(source).not.toMatch(/tar cf -/);
  });

  it('package.sh refuses to package a set release validation would block', () => {
    const source = read('scripts/package.sh');
    expect(source).toContain('--required');
    expect(source).toMatch(/PACKAGING BLOCKED|Packaging BLOCKED/);
  });

  it('the module is the only definer of the required shipped files', () => {
    // `required` must not be re-declared in the validator, or the two drift.
    const source = read('scripts/release-validate.cjs');
    expect(source).toContain('REQUIRED_FILES');
    expect(source).not.toMatch(/const REQUIRED\s*=\s*\[/);
  });
});

// ---------------------------------------------------------------------------
// 2. The container artifact must ship (M131-F02)
// ---------------------------------------------------------------------------

describe('the production container artifact is required in the release', () => {
  it('declares Dockerfile, .dockerignore, and docker-compose.yml as required', () => {
    for (const file of ['Dockerfile', '.dockerignore', 'docker-compose.yml']) {
      expect(distFileSet.REQUIRED_FILES).toContain(file);
    }
  });

  it('release validation names a container file when one is missing', () => {
    const { missing } = distFileSet.missingRequired();
    // Whichever of the three are currently untracked, validation must SEE them.
    // This test asserts detection, not the current repository state, so it keeps
    // passing once the files are tracked.
    for (const file of ['Dockerfile', '.dockerignore', 'docker-compose.yml']) {
      const isShipped = distFileSet.shippedFiles().includes(file);
      if (!isShipped) expect(missing).toContain(file);
    }
  });

  it('actually reports every untracked container file rather than none', () => {
    // Guards against the detection silently returning an empty list (the exact
    // M131-F01 failure shape: a gate that cannot fail).
    const shipped = new Set(distFileSet.shippedFiles());
    const untrackedContainers = ['Dockerfile', '.dockerignore', 'docker-compose.yml'].filter(
      (f) => !shipped.has(f),
    );
    const { missing } = distFileSet.missingRequired();
    expect(missing.sort()).toEqual(untrackedContainers.sort());
  });
});

// ---------------------------------------------------------------------------
// 3. The complete migration history must ship (M131-F03)
// ---------------------------------------------------------------------------

describe('the complete migration history ships', () => {
  it('every on-disk migration directory is considered', () => {
    const dirs = distFileSet.onDiskMigrationDirectories();
    // Guards the `.length === 0` branch from firing on a populated tree.
    expect(dirs.length).toBeGreaterThan(0);
  });

  it('any migration absent from the shipped set is reported', () => {
    const shipped = distFileSet.shippedFiles();
    const { missingMigrations } = distFileSet.missingRequired();
    for (const dir of distFileSet.onDiskMigrationDirectories()) {
      const hasFile = shipped.some((f) => f.startsWith(dir));
      if (!hasFile) expect(missingMigrations).toContain(dir);
    }
  });

  it('the schema migration itself is required', () => {
    expect(distFileSet.REQUIRED_FILES).toContain('prisma/schema.prisma');
  });
});

// ---------------------------------------------------------------------------
// 4. Documented commands resolve inside the package (M131-F04)
// ---------------------------------------------------------------------------

describe('the shipped set supports every documented npm script', () => {
  it('.distignore no longer excludes scripts/', () => {
    const distignore = read('.distignore').split('\n').map((l) => l.trim());
    expect(distignore).not.toContain('scripts/');
  });

  it('no npm script resolves to a path excluded from the release', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const rules = read('.distignore')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('!'))
      .map((rule) => (rule.endsWith('/') ? rule.slice(0, -1) : rule));

    const referenced = new Set<string>();
    for (const command of Object.values(pkg.scripts)) {
      for (const match of command.matchAll(/(?:^|[\s&|])(scripts\/[\w.-]+)/g)) {
        referenced.add(match[1]);
      }
    }
    expect(referenced.size, 'package.json must reference scripts/ somewhere').toBeGreaterThan(0);

    for (const rel of referenced) {
      const hidden = rules.some((rule) => rel === rule || rel.startsWith(`${rule}/`));
      expect(hidden, `${rel} is referenced by a documented command but excluded from the release`).toBe(
        false,
      );
    }
  });

  it('development.md still documents the deployment command', () => {
    expect(read('docs/development.md')).toContain('npm run verify:deployment');
  });
});

// ---------------------------------------------------------------------------
// 5. Deployment verification cannot half-pass (M131-F07, M131-F11)
// ---------------------------------------------------------------------------

describe('deployment verification is honest about what it ran', () => {
  it('fails when the live leg cannot run and no opt-in is given', () => {
    const result = spawnSync(process.execPath, [path.join(scriptsDir, 'verify-deployment.cjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '', VERIFICATION_STATIC_ONLY: '' },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('DATABASE_URL is not set');
    // The old behaviour exited 0 here with the static count alone.
    expect(output).not.toMatch(/Deployment verification: PASS/);
  });

  it('allows an explicit definitions-only run', () => {
    const result = spawnSync(process.execPath, [path.join(scriptsDir, 'verify-deployment.cjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '', VERIFICATION_STATIC_ONLY: '1' },
    });
    const output = `${result.stdout}${result.stderr}`;
    // M18.2 / RUNTIME-002: the opt-in still runs, but it now exits 2 (INCOMPLETE)
    // instead of 0. Exit 0 meant a definitions-only run was indistinguishable
    // from a full one, so `npm run validate` could chain a deployment step that
    // never booted the application and still report success. The assertion is
    // strengthened, not relaxed: it now pins a non-zero, distinct outcome.
    expect(result.status).toBe(2);
    // Even the opt-in must say out loud that the lifecycle was not exercised.
    expect(output).toContain('was NOT exercised');
    // And it must never be summarised as PASS.
    expect(output).not.toMatch(/Deployment verification: PASS/);
    expect(output).toContain('Deployment verification: INCOMPLETE');
  });

  it('distinguishes all three outcomes by exit code (M18.2 / RUNTIME-002)', () => {
    // 0 = complete (static + live), 1 = a check failed, 2 = incomplete (live leg
    // never ran). A definitions-only run must not be able to masquerade as a
    // full verification in a shell `if` or a chained `npm run validate`.
    const source = read('scripts/verify-deployment.cjs');
    expect(source).toContain("verdict = 'INCOMPLETE'");
    expect(source).toContain('exitCode = 2');
    expect(source).toContain('liveLegRan = true');
  });

  it('states the scope of what actually ran (M18.2)', () => {
    const result = spawnSync(process.execPath, [path.join(scriptsDir, 'verify-deployment.cjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '', VERIFICATION_STATIC_ONLY: '1' },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('STATIC repository/configuration checks ONLY');
    expect(output).toContain('This is NOT a complete deployment verification');
  });

  it('documents bare docker run readiness gating (M18.2 / RUNTIME-001)', () => {
    const deployment = read('docs/deployment.md');
    expect(deployment).toContain('## Running the container directly (`docker run`)');
    // The requirement, not merely a mention in a failure table.
    expect(deployment).toContain('A running container is not a usable application');
    // Traffic gating must be tied to readiness, never to container state.
    expect(deployment).toMatch(/Gate traffic on `\/health\/ready`/);
    expect(deployment).toMatch(/never route traffic on this/);
    // Migrations are a separate step, and destructive commands are forbidden.
    expect(deployment).toContain('The container never migrates');
    expect(deployment).toContain('npx prisma migrate deploy');
    expect(deployment).toContain('prisma migrate reset');
  });

  it('does not hardcode a loopback database upstream (M131-F07)', () => {
    const source = read('scripts/verify-deployment.cjs');
    // The proxy must forward to the host taken from DATABASE_URL. A hardcoded
    // 127.0.0.1 upstream made every non-loopback database fail deterministically.
    expect(source).toMatch(/startProxy\(databaseHost, databasePort\)/);
    expect(source).toContain('databaseTarget.hostname');
    expect(source).not.toMatch(/net\.connect\(targetPort, '127\.0\.0\.1'\)/);
  });

  it('still points the child at the proxy over loopback', () => {
    const source = read('scripts/verify-deployment.cjs');
    // The proxy is local, so the child must address it on loopback.
    expect(source).toMatch(/parsed\.hostname = '127\.0\.0\.1'/);
  });
});

// ---------------------------------------------------------------------------
// 6. Compose matches the documented contract (M131-F05, M131-F06)
// ---------------------------------------------------------------------------

describe('the compose stack matches the documentation', () => {
  const compose = read('docker-compose.yml');
  const postgresService = compose.split('  postgres:')[1]?.split('\n  app:')[0] ?? '';

  it('publishes a host port for PostgreSQL', () => {
    // Without this the bundled database was unreachable from the app container.
    expect(postgresService).toMatch(/^\s*ports:/m);
  });

  it('publishes onto 5433 by default, matching .env.example', () => {
    expect(postgresService).toContain('${POSTGRES_HOST_PORT:-5433}:5432');
  });

  it('pins a PostgreSQL version at or above the documented minimum', () => {
    const image = /image:\s*postgres:(\d+)/.exec(postgresService);
    expect(image).not.toBeNull();
    expect(Number(image?.[1])).toBeGreaterThanOrEqual(17);
  });

  it('explains the two-address host distinction', () => {
    expect(compose).toContain('postgres:5432');
    expect(compose).toContain('127.0.0.1:5433');
  });

  it('deployment.md documents both addresses', () => {
    const deployment = read('docs/deployment.md');
    expect(deployment).toContain('postgres:5432');
    expect(deployment).toContain('127.0.0.1:5433');
  });

  it('development.md no longer calls 5433 the local-compose mapping', () => {
    // The original claim was false: compose published no postgres port at all.
    expect(read('docs/development.md')).not.toContain('is the local-compose mapping');
  });

  it('still requires secrets from the environment', () => {
    expect(compose).toContain('${DATABASE_URL:?');
    expect(compose).toContain('${JWT_SECRET:?');
    expect(compose).toContain('${POSTGRES_PASSWORD:?');
  });

  it('still forwards signals and allows a graceful stop', () => {
    expect(compose).toMatch(/^\s*init:\s*true$/m);
    expect(compose).toMatch(/stop_grace_period:\s*\d+s/);
  });
});

// ---------------------------------------------------------------------------
// 7. Documentation accuracy (M131-F08)
// ---------------------------------------------------------------------------

describe('release contract states the enforced rule count', () => {
  it('release-contract.md agrees with the architecture checker', () => {
    const architecture = spawnSync(
      process.execPath,
      [path.join(scriptsDir, 'architecture-check.cjs')],
      { cwd: root, encoding: 'utf8' },
    );
    const ruleCount = (architecture.stdout.match(/^PASS ARCH-ENF-/gm) ?? []).length;
    expect(ruleCount).toBeGreaterThan(0);

    const contract = read('docs/release-contract.md');
    const stated = /Architecture \((\d+) rules\)/.exec(contract);
    expect(stated).not.toBeNull();
    expect(Number(stated?.[1])).toBe(ruleCount);
  });
});

// ---------------------------------------------------------------------------
// 8. Shipped shell scripts must be executable (M13.2 finding)
// ---------------------------------------------------------------------------

describe('shipped shell scripts are runnable', () => {
  it('no shipped .sh file carries CRLF line endings', () => {
    // A CRLF-terminated POSIX shell script is not runnable: `set -euo pipefail\r`
    // is parsed as an option name plus a stray command. The packager was in this
    // state and failed before doing any work, silently yielding no artifact.
    const shipped = distFileSet
      .shippedFiles()
      .filter((rel) => rel.endsWith('.sh'))
      .concat(['scripts/package.sh']);

    expect(shipped.length, 'expected at least one shell script to check').toBeGreaterThan(0);

    for (const rel of new Set(shipped)) {
      const contents = fs.readFileSync(path.join(root, rel), 'utf8');
      expect(contents.includes('\r\n'), `${rel} must use LF line endings`).toBe(false);
    }
  });

  it('the packager passes a shell syntax check', () => {
    const result = spawnSync('bash', ['-n', path.join(root, 'scripts/package.sh')], {
      encoding: 'utf8',
    });
    expect(`${result.stderr}`).toBe('');
    expect(result.status).toBe(0);
  });
});
