/**
 * Release-validator behavior against an EXTRACTED CUSTOMER ARTIFACT (M13.12 /
 * M1311-02).
 *
 * M1311-02: the shipped `release-validate.cjs` depends on `.distignore` and Git
 * metadata, neither of which ships in the customer ZIP, so running it from an
 * extracted artifact used to crash with `ENOENT`. The validator now:
 *   - computes the file set from the filesystem when `.git` is absent,
 *   - treats a missing `.distignore` as "no additional exclusions",
 *   - keeps every package-integrity check fail-closed,
 *   - skips only the SBOM-freshness gate (a release-PROCESS check) loudly.
 *
 * These tests build isolated fixture artifacts (a realistic copy of the four
 * validator `.cjs` scripts plus the required files, with NO `.distignore`, exactly
 * like an extracted ZIP), run the validator as a subprocess with its own ROOT, and
 * assert a valid artifact passes while missing-required-file, broken-import, and
 * forbidden-file fixtures fail closed. The real repository tree is never modified.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = 'release-validate.cjs';
const SCRIPTS_TO_SHIP = ['release-validate.cjs', 'dist-file-set.cjs', 'import-integrity.cjs', 'sbom-validate.cjs'];

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

/** Build an extracted-artifact-shaped fixture (no .distignore, no .git). */
function makeArtifact(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-artifact-'));
  tempDirs.push(dir);
  const put = (rel: string, content: string) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };
  // The validator scripts themselves ship in the artifact, so copy them in.
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const s of SCRIPTS_TO_SHIP) fs.copyFileSync(path.join(scriptsDir, s), path.join(dir, 'scripts', s));

  put('package.json', JSON.stringify({ name: 'oxyide-forge', version: '1.0.0', private: true }, null, 2));
  put('package-lock.json', JSON.stringify({ name: 'oxyide-forge', lockfileVersion: 3, packages: {} }));
  put('README.md', '# Oxyide Forge\n');
  put('LICENSE.txt', 'Commercial License\n');
  put('.env.example', 'JWT_SECRET=replace-with-a-32-char-minimum-secret\n');
  put('prisma/schema.prisma', 'generator client { provider = "prisma-client-js" }\n');
  put('Dockerfile', 'FROM node:20-alpine\nUSER node\n');
  put('.dockerignore', 'node_modules\n.env\n');
  put('docker-compose.yml', 'services:\n  app:\n    build: .\n');
  put('prisma/migrations/0001_init/migration.sql', 'CREATE TABLE "User" (id TEXT PRIMARY KEY);\n');
  // M19.2-R1 required onboarding and policy surface: a "valid artifact"
  // must contain everything REQUIRED_FILES demands, not just the container set.
  put('docs/installation.md', '# Fixture installation guide\n');
  put('setup.sh', '#!/usr/bin/env bash\n# fixture setup wrapper\n');
  put('scripts/setup.mjs', '#!/usr/bin/env node\n// fixture setup entry point\n');
  for (const doc of [
    'support.md',
    'versioning.md',
    'compatibility.md',
    'troubleshooting.md',
    'security.md',
    'observability.md',
  ]) {
    put(`docs/${doc}`, `# Fixture ${doc}\n`);
  }
  // A minimal, valid relative-import pair (NodeNext .js -> .ts convention).
  put('src/app.ts', 'export const app = 1;\n');
  put('src/main.ts', "import { app } from './app.js';\nexport const boot = app;\n");
  return dir;
}

function runValidator(dir: string): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', VALIDATOR)], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('release validator against an extracted customer artifact', () => {
  it('passes a valid artifact and skips only the release-process SBOM gate (loudly)', () => {
    const dir = makeArtifact();
    const { status, out, err } = runValidator(dir);
    expect(status).toBe(0);
    expect(out).toContain('Release validation PASS');
    expect(out).toContain('SBOM freshness not applicable to an extracted artifact'); // loud, not silent
    expect(out).not.toContain('undefined'); // no unrendered placeholders in the verdict
    expect(err).toBe(''); // no git "not a repository" / ENOENT noise
  });

  it('fails closed when a required file is missing from the artifact', () => {
    const dir = makeArtifact();
    fs.rmSync(path.join(dir, 'Dockerfile'));
    const { status, out } = runValidator(dir);
    expect(status).toBe(1);
    expect(out).toContain('Release validation FAIL');
    expect(out).toContain('Dockerfile');
  });

  it('fails closed on a broken relative import in the shipped set', () => {
    const dir = makeArtifact();
    fs.appendFileSync(path.join(dir, 'src', 'main.ts'), "import { gone } from './missing.js';\n");
    const { status, out } = runValidator(dir);
    expect(status).toBe(1);
    expect(out).toContain("'./missing.js'");
  });

  it('fails closed when forbidden key material is present in the artifact', () => {
    const dir = makeArtifact();
    fs.writeFileSync(path.join(dir, 'scripts', 'id_rsa.pem'), '-----BEGIN RSA PRIVATE KEY-----\nfake\n');
    const { status, out } = runValidator(dir);
    expect(status).toBe(1);
    expect(out).toMatch(/key material/i);
  });

  it('fails closed when a required onboarding file is missing from the artifact', () => {
    const dir = makeArtifact();
    fs.rmSync(path.join(dir, 'docs', 'installation.md'));
    const { status, out } = runValidator(dir);
    expect(status).toBe(1);
    expect(out).toContain('Release validation FAIL');
    expect(out).toContain('docs/installation.md');
  });
});

describe('release evidence integrity (Case H)', () => {
  it('records the actual lockfile SHA-256, not a placeholder', () => {
    const dir = makeArtifact();
    const evidencePath = path.join(dir, 'evidence.json');
    const run = spawnSync(
      process.execPath,
      [path.join(dir, 'scripts', VALIDATOR), '--evidence', evidencePath],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as {
      lockfileSha256: string;
    };
    // Full 64-hex digest, independently recomputed — never a shell
    // expression, placeholder, or truncated value.
    expect(evidence.lockfileSha256).toMatch(/^[0-9a-f]{64}$/);
    const actual = createHash('sha256')
      .update(fs.readFileSync(path.join(dir, 'package-lock.json')))
      .digest('hex');
    expect(evidence.lockfileSha256).toBe(actual);
  });

  it('detects a lockfile modified after evidence generation', () => {
    const dir = makeArtifact();
    const evidencePath = path.join(dir, 'evidence.json');
    const run = spawnSync(
      process.execPath,
      [path.join(dir, 'scripts', VALIDATOR), '--evidence', evidencePath],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    const before = (
      JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as { lockfileSha256: string }
    ).lockfileSha256;
    fs.appendFileSync(path.join(dir, 'package-lock.json'), '\n');
    const rerun = spawnSync(
      process.execPath,
      [path.join(dir, 'scripts', VALIDATOR), '--evidence', evidencePath],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(rerun.status).toBe(0);
    const after = (JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as { lockfileSha256: string })
      .lockfileSha256;
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
  });
});
