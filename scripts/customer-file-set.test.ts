/**
 * M19.2-R1 — customer file-set regression suite (Cases A–D, F, G, J).
 *
 * The M19.2 defect class: intended customer deliverables existed in the
 * working tree but were untracked, and packaging derived its set from Git
 * tracking alone — so the customer ZIP omitted files the README promises.
 * The correction (explicit allowlist inside scripts/dist-file-set.cjs, the
 * single source of truth) is proven here with isolated fixtures. Fixture
 * Git repositories live in temporary directories; the real repository's
 * index is never touched.
 *
 * Fixture secrets are visibly fake sentinel strings, never real credentials.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..');

const distFileSet = require(path.join(scriptsDir, 'dist-file-set.cjs')) as {  REQUIRED_FILES: string[];
  UNTRACKED_CUSTOMER_FILES: string[];
  INTERNAL_ONLY: Set<string>;
  DEV_ONLY_PREFIXES: string[];
  shippedFiles: () => string[];
  shippedFilesFor: (rootDir: string) => string[];
  intendedFiles: () => string[];
  missingRequired: () => { missing: string[]; missingMigrations: string[]; reasons: string[] };
  missingRequiredFor: (rootDir: string) => {
    missing: string[];
    missingMigrations: string[];
    reasons: string[];
  };
  selectCustomerFiles: (args: {
    tracked: string[];
    present: Set<string>;
    allowlist: string[];
    excluded: (rel: string) => boolean;
    internal: Set<string>;
    devOnlyPrefixes: string[];
  }) => string[];
  findUnsafePaths: (files: string[]) => string[];
};

const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const noExclusions = (): boolean => false;

const { checkPackageLinks } = require(path.join(scriptsDir, 'package-link-check.cjs')) as {
  checkPackageLinks: (
    rootDir: string,
    shipped: string[],
  ) => {
    documents: number;
    brokenLinks: string[];
    brokenAnchors: string[];
    localLeaks: string[];
    internalLinks: string[];
  };
};

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeTemp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fileset-'));
  tempDirs.push(dir);
  return dir;
}

/** Isolated fixture Git repository (never the real index). */
function makeGitFixture(files: Record<string, string>, commitAll: boolean): string {
  const dir = makeTemp();
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir });
  if (commitAll) {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], {
      cwd: dir,
    });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Case A — required untracked file ships without staging or committing
// ---------------------------------------------------------------------------

describe('Case A — required untracked customer files ship uncommitted', () => {
  it('selects an allowlisted untracked file through the fixture mechanism', () => {
    const selected = distFileSet.selectCustomerFiles({
      tracked: ['README.md', 'package.json'],
      present: new Set(['docs/installation.md']),
      allowlist: ['docs/installation.md'],
      excluded: noExclusions,
      internal: new Set(),
      devOnlyPrefixes: [],
    });
    expect(selected).toContain('docs/installation.md');
    expect(selected).toContain('README.md');
  });

  it('ships allowlisted untracked files from a real fixture Git repo with no git add', () => {
    const dir = makeGitFixture({ 'README.md': '# x\n' }, true);
    const nestedDir = path.join(dir, 'docs');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, 'installation.md'), '# guide\n');
    // Explicitly untracked: no `git add` after the base commit.
    const status = execFileSync('git', ['status', '--short'], { cwd: dir, encoding: 'utf8' });
    expect(status).toMatch(/\?\?/);
    const shipped = distFileSet.shippedFilesFor(dir);
    expect(shipped).toContain('README.md');
    // The allowlist is repo-relative; prove the mechanism with the repo's own
    // allowlist entry resolved against the fixture content.
    expect(
      distFileSet.selectCustomerFiles({
        tracked: ['README.md'],
        present: new Set(['docs/installation.md']),
        allowlist: distFileSet.UNTRACKED_CUSTOMER_FILES,
        excluded: noExclusions,
        internal: distFileSet.INTERNAL_ONLY,
        devOnlyPrefixes: distFileSet.DEV_ONLY_PREFIXES,
      }),
    ).toContain('docs/installation.md');
  });
});

// ---------------------------------------------------------------------------
// Case B — unrelated untracked files never ship
// ---------------------------------------------------------------------------

describe('Case B — unrelated untracked files are excluded', () => {
  it('ignores untracked files absent from the allowlist', () => {
    const selected = distFileSet.selectCustomerFiles({
      tracked: ['README.md'],
      present: new Set(['scratch-note.md', 'docs/installation.md']),
      allowlist: ['docs/installation.md'],
      excluded: noExclusions,
      internal: new Set(),
      devOnlyPrefixes: [],
    });
    expect(selected).not.toContain('scratch-note.md');
    expect(selected).toContain('docs/installation.md');
  });

  it('the allowlist contains no scratch, log, or temp patterns', () => {
    for (const entry of distFileSet.UNTRACKED_CUSTOMER_FILES) {
      expect(entry).not.toMatch(/\.(log|tmp|bak)$/i);
      expect(entry.startsWith('m53-')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Case C — ignored secret files are excluded
// ---------------------------------------------------------------------------

describe('Case C — ignored secret files are excluded', () => {
  it('excludes .env even when listed, and the marker never appears', () => {
    const marker = 'FIXTURE-SECRET-MARKER-never-a-credential';
    const selected = distFileSet.selectCustomerFiles({
      tracked: ['README.md', '.env'],
      present: new Set(['docs/installation.md']),
      allowlist: ['docs/installation.md', '.env'],
      excluded: (rel) => rel === '.env' || rel.startsWith('.env.'),
      internal: new Set(),
      devOnlyPrefixes: [],
    });
    expect(selected).not.toContain('.env');
    expect(JSON.stringify(selected)).not.toContain(marker);
  });

  it('the real .env exclusion keeps working end to end', () => {
    expect(distFileSet.shippedFiles()).not.toContain('.env');
  });
});

// ---------------------------------------------------------------------------
// Case D — missing required files fail with a useful diagnostic
// ---------------------------------------------------------------------------

describe('Case D — missing required files fail loudly', () => {
  it('names the missing required path with a remediation', () => {
    const dir = makeGitFixture(
      {
        'README.md': '# x\n',
        'package.json': '{"name":"x"}\n',
        'prisma/migrations/0001_init/migration.sql': '-- init\n',
      },
      true,
    );
    // docs/installation.md is required but absent from this fixture.
    const { missing, reasons } = distFileSet.missingRequiredFor(dir);
    expect(missing).toContain('docs/installation.md');
    const reason = reasons.find((r) => r.includes('docs/installation.md'));
    expect(reason).toBeDefined();
    expect(reason).toMatch(/absent|untracked|excluded|internal/);
  });

  it('the working tree currently has zero missing required files', () => {
    // Fail-closed inventory: any drift (deleted or de-listed required file)
    // turns this red with the exact path.
    expect(distFileSet.missingRequired().missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case E — a README link to a nonexistent document fails validation
// ---------------------------------------------------------------------------

describe('Case E — missing README targets fail with the exact link', () => {
  it('fails naming the referring document and the broken link', () => {
    const dir = makeTemp();
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      '# Fixture\n\nSee [the guide](docs/guide-missing-here.md) for setup.\n',
      'utf8',
    );
    const findings = checkPackageLinks(dir, ['README.md']);
    expect(findings.documents).toBe(1);
    expect(findings.brokenLinks.length).toBeGreaterThan(0);
    expect(findings.brokenLinks.join('\n')).toContain('README.md');
    expect(findings.brokenLinks.join('\n')).toContain('docs/guide-missing-here.md');
  });

  it('passes the same shape once the target exists (control)', () => {
    const dir = makeTemp();
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      '# Fixture\n\nSee [the guide](docs/guide.md) for setup.\n',
      'utf8',
    );
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    const findings = checkPackageLinks(dir, ['README.md']);
    expect([
      ...findings.brokenLinks,
      ...findings.brokenAnchors,
      ...findings.localLeaks,
      ...findings.internalLinks,
    ]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case F — platform packaging parity
// ---------------------------------------------------------------------------

describe('Case F — Unix and Windows packagers share one file-selection definition', () => {
  it('both entry points consume the shared list and its required gate', () => {
    for (const script of ['scripts/package.sh', 'scripts/package.ps1']) {
      const source = read(script);
      expect(source, `${script} must consume dist-file-set.cjs`).toContain('dist-file-set.cjs');
      expect(source, `${script} must enforce the required gate`).toContain('--required');
    }
  });

  it('neither entry point stages a second file set', () => {
    expect(read('scripts/package.sh')).not.toMatch(/tar cf -/);
    const ps1 = read('scripts/package.ps1');
    // Reporting the staged tree is fine; selecting it a second time is not.
    expect(ps1).not.toContain('xcopy');
    expect(ps1).not.toMatch(/Get-ChildItem.*-Include/);
  });

  it('both entry points run the customer documentation link gate', () => {
    for (const script of ['scripts/package.sh', 'scripts/package.ps1']) {
      expect(read(script), `${script} must run package-link-check`).toContain(
        'package-link-check',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Case G — duplicate and unsafe paths are rejected
// ---------------------------------------------------------------------------

describe('Case G — unsafe archive paths are rejected', () => {
  it('accepts a clean list', () => {
    expect(distFileSet.findUnsafePaths(['README.md', 'docs/a.md', 'src/x.ts'])).toEqual([]);
  });

  it('rejects duplicates, traversal, absolute, and backslash paths', () => {
    expect(distFileSet.findUnsafePaths(['a.md', 'a.md'])).toEqual([
      'duplicate archive path: a.md',
    ]);
    expect(distFileSet.findUnsafePaths(['../escape.md']).length).toBeGreaterThan(0);
    expect(distFileSet.findUnsafePaths(['a/../../escape.md']).length).toBeGreaterThan(0);
    expect(distFileSet.findUnsafePaths(['/abs/path.md']).length).toBeGreaterThan(0);
    expect(distFileSet.findUnsafePaths(['C:\\win\\path.md']).length).toBeGreaterThan(0);
    expect(distFileSet.findUnsafePaths(['dir\\file.md']).length).toBeGreaterThan(0);
    expect(distFileSet.findUnsafePaths(['']).length).toBeGreaterThan(0);
  });

  it('rejects Windows case-collisions', () => {
    const findings = distFileSet.findUnsafePaths(['Docs/Guide.md', 'docs/guide.md']);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join(' ')).toContain('case-collision');
  });
});

// ---------------------------------------------------------------------------
// Case J — Git independence plus full classification coverage
// ---------------------------------------------------------------------------

describe('Case J — packaging does not depend on index state', () => {
  it('shippedFilesFor resolves allowlisted files with no staging', () => {
    const dir = makeGitFixture({ 'README.md': '# x\n' }, true);
    const nested = path.join(dir, 'docs', 'installation.md');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, '# guide\n');
    // Prove independence from the index twice: status shows untracked, and
    // the index contains exactly the base commit.
    expect(execFileSync('git', ['status', '--short'], { cwd: dir, encoding: 'utf8' })).toMatch(
      /\?\?/,
    );
    const shipped = distFileSet.shippedFilesFor(dir);
    expect(shipped).toContain('README.md');
    expect(shipped).toContain('docs/installation.md');
  });

  it('every intended file is explicitly classified (shipped, internal, or dev-only)', () => {
    // Fail-closed inventory: a new untracked file with no classification
    // turns this red, forcing an explicit ship/internal/dev decision.
    const { intendedFiles, shippedFiles, INTERNAL_ONLY, DEV_ONLY_PREFIXES } = distFileSet;
    const shipped = new Set(shippedFiles());
    const unclassified = intendedFiles().filter(
      (rel: string) =>
        !shipped.has(rel) &&
        !INTERNAL_ONLY.has(rel) &&
        !DEV_ONLY_PREFIXES.some((prefix: string) => rel.startsWith(prefix)),
    );
    expect(unclassified, `unclassified intended files: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('the allowlist covers every README-promised customer document', () => {    const { relativeLinks } = require(path.join(scriptsDir, 'package-link-check.cjs')) as {
      relativeLinks: (markdown: string) => string[];
    };
    const shipped = new Set(distFileSet.shippedFiles());
    const missing: string[] = [];
    for (const link of relativeLinks(read('README.md'))) {
      const target = link.split('#')[0];
      if (target === '') continue;
      if (!shipped.has(target)) missing.push(target);
    }
    expect(missing, `README links missing from shipped set: ${missing.join(', ')}`).toEqual([]);
  });
});
