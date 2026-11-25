#!/usr/bin/env node
'use strict';

/**
 * M13.2 — the single source of truth for the customer-distribution file set.
 * M19.2-R1 — intended-but-untracked customer files ship without a commit.
 *
 * Why this exists (M131-F01, CRITICAL)
 * ------------------------------------
 * Before this module, the set of files that ship to a customer was computed
 * TWICE, two different ways:
 *
 *   - `scripts/release-validate.cjs` used `git ls-files`  (tracked files only)
 *   - `scripts/package.sh` used `tar cf -` over the working tree
 *
 * Those sets differ whenever a file exists on disk but is untracked, which is
 * exactly the M13.1 condition: 118 tracked vs 179 untracked, including the
 * entire container package (Dockerfile, .dockerignore, docker-compose.yml) and
 * 8 of 10 Prisma migrations. Release validation consequently reported PASS on a
 * tree whose customer artifact was missing its production container entirely.
 *
 * `release-validate.cjs`'s own header claimed validation and packaging "cannot
 * drift apart". They could, and did. This module is what makes that claim true:
 * both now call `shippedFiles()` and nothing else computes the set.
 *
 * Why tracked files, and not the working tree
 * -------------------------------------------
 * Shipping the working tree would sweep in local scratch files, uncommitted
 * experiments, and anything an operator left behind — none of which validation
 * ever inspected. That is the unshippable-file failure mode. Shipping the
 * tracked set makes the artifact exactly the set the release reviewed.
 *
 * The consequence is deliberate and loud rather than silent: a required file
 * that is untracked now makes `release:check` FAIL. That is correct. It converts
 * the M131-F01 false green into a true red and keeps it red until the file is
 * actually part of the repository.
 *
 * M19.2-R1 — untracked customer files (Approach A: explicit allowlist)
 * --------------------------------------------------------------------
 * Tracked-only selection has a second failure mode, found in M19.2: intended
 * customer deliverables (the installation guide, the setup entry points, the
 * customer policy docs) exist in the working tree but are untracked, so the
 * customer ZIP omits files the README promises. Requiring a commit before an
 * artifact can be produced makes packaging depend on index/history state.
 *
 * The correction is an explicit, reviewed allowlist
 * (`UNTRACKED_CUSTOMER_FILES`) integrated HERE — not a second manifest:
 * untracked files listed here ship from the verified working tree; untracked
 * files NOT listed here never ship. Arbitrary scratch, hook infrastructure,
 * and ignored secrets stay out by construction, while every allowlisted path
 * is validated (present, ordinary file, inside the root, no traversal, no
 * case-collision) before it can enter the set. A missing required file still
 * fails loudly with the exact relative path and remediation.
 *
 * Usage:
 *   node scripts/dist-file-set.cjs --list        # one shipped path per line
 *   node scripts/dist-file-set.cjs --required    # required paths that are missing
 *   node scripts/dist-file-set.cjs --json        # { shipped, required, missing }
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Files that MUST be present in a customer release.
 *
 * `docs/deployment.md` and `docs/release-contract.md` §5 both declare the
 * container artifact normative, so the container files are required: without
 * them a customer receives source they cannot build or run as documented. This
 * list is the enforcement point that M131-F02 lacked
 * (`grep -c Dockerfile scripts/release-validate.cjs` returned 0 before M13.2).
 *
 * M19.2-R1: the README-promised onboarding and policy surface is required too.
 * Every entry below is linked from `README.md` or invoked by a documented
 * `npm run` command — its absence would ship a package whose own documentation
 * fails on first use (the M19.2 criteria 9/22 defect class).
 */
const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'LICENSE.txt',
  '.env.example',
  'prisma/schema.prisma',
  // M131-F02 — the normative production container artifact.
  'Dockerfile',
  '.dockerignore',
  'docker-compose.yml',
  // M19.2-R1 — the promised onboarding surface.
  'docs/installation.md',
  'setup.sh',
  'scripts/setup.mjs',
  'docs/support.md',
  'docs/versioning.md',
  'docs/compatibility.md',
  'docs/troubleshooting.md',
  'docs/security.md',
  'docs/observability.md',
];

/**
 * Intended customer deliverables that may ship WITHOUT being tracked.
 *
 * Each entry was reviewed for purpose and sensitivity before listing:
 * customer guides linked from the README, setup entry points invoked by
 * documented commands, deployment examples validated as customer-facing, and
 * release/script tooling consistent with the scripts/ shipping precedent
 * (M131-F04). Untracked files NOT listed here — scratch notes, hook
 * infrastructure, ignored secrets, anything an operator left behind — never
 * ship, by construction.
 *
 * This list is the ONLY untracked source. There is no second manifest.
 */
const UNTRACKED_CUSTOMER_FILES = [
  // Required onboarding and policy surface (also in REQUIRED_FILES).
  'docs/installation.md',
  'setup.sh',
  'scripts/setup.mjs',
  'docs/support.md',
  'docs/versioning.md',
  'docs/compatibility.md',
  'docs/troubleshooting.md',
  'docs/security.md',
  'docs/observability.md',
  'docs/refunds.md',
  'docs/updates.md',
  // Deployment examples: validated customer-facing starting points.
  'fly.toml',
  'render.yaml',
  // Module generator and dashboards: invoked by documented README/npm commands.
  'scripts/gen-module.mjs',
  'scripts/gen-module.test.ts',
  'scripts/generate-dashboards.cjs',
  'scripts/generate-dashboards.test.ts',
  // Release tooling consistent with the shipped release-validate.cjs precedent.
  'scripts/release-gate.cjs',
  'scripts/release-gate-env.test.ts',
  'scripts/policy-docs.test.cjs',
  // Setup and documentation suites (scripts/*.test.ts ships by precedent).
  'scripts/setup.test.ts',
  'scripts/setup-mjs.test.ts',
  'scripts/documentation-links.test.ts',
  'scripts/customer-file-set.test.ts',
  'scripts/package-link-check.cjs',
  // Colocated application tests ship by precedent (135 already ship).
  'src/app/startup-path.test.ts',
  // Dashboard source for the documented `npm run dashboards` workflow.
  'observability/grafana/dashboards/manifest.json',
  'observability/grafana/dashboards/oxyide-forge.json',
];

/**
 * Developer-only working-tree material: present and non-ignored, but never
 * customer content. `.husky/` is git-hook infrastructure (useless without
 * `.git`, regenerated by `npx husky`); it is neither internal engineering
 * record nor shippable product.
 */
const DEV_ONLY_PREFIXES = ['.husky/'];

/**
 * Prisma migration directories that must ship.
 *
 * M131-F03: the old gate asserted only that *some* migration ships, which the
 * two tracked migrations satisfied while eight were missing. A customer running
 * the documented `npx prisma migrate deploy` could never reach schema. Every
 * on-disk migration directory must therefore be in the shipped set.
 */
function onDiskMigrationDirectoriesFor(rootDir) {
  const dir = path.join(rootDir, 'prisma', 'migrations');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `prisma/migrations/${entry.name}/`);
}

function onDiskMigrationDirectories() {
  return onDiskMigrationDirectoriesFor(ROOT);
}

function readDistignorePatternsFor(rootDir) {
  const distignorePath = path.join(rootDir, '.distignore');
  // An extracted customer artifact deliberately does not ship `.distignore`
  // (it is packager configuration). Absent there means "no additional
  // exclusions" — the packager already applied them when it built the archive,
  // so the artifact contains exactly the intended files. In a source checkout
  // the file is present and behaves exactly as before.
  if (!fs.existsSync(distignorePath)) return [];
  const raw = fs.readFileSync(distignorePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'));
}

function readDistignorePatterns() {
  return readDistignorePatternsFor(ROOT);
}

function globToRegExp(pattern) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

function makeExcluder(patterns) {
  return function excluded(relativePath) {
    const normalized = relativePath.split(path.sep).join('/');
    return patterns.some((pattern) => {
      if (pattern.endsWith('/')) {
        const base = pattern.slice(0, -1);
        return normalized === base || normalized.startsWith(pattern);
      }
      if (pattern.includes('*')) return globToRegExp(pattern).test(normalized);
      return normalized === pattern || normalized.startsWith(`${pattern}/`);
    });
  };
}

/**
 * Internal-only records: never customer documentation, never shipped, and —
 * unlike `.distignore` (packager configuration) — also removed from the
 * INTENDED set so the manifest never presents them as V1 content.
 * M19.2-R1 adds the commercial price analysis and the release-gate
 * implementation notes: neither is README-promised customer documentation.
 */
const INTERNAL_ONLY = new Set([
  'docs/MEMORY.md',
  'docs/customer-package.md',
  'docs/price_analysis.md',
  'docs/release-gate.md',
]);

/**
 * Filesystem enumeration of every file under a root (repo-relative POSIX
 * paths), skipping VCS/dependency trees. This is the fallback used when Git
 * metadata is unavailable — the extracted-customer-artifact case, where the
 * archive contains only the shipped files and there is no `.git`. It is never
 * used when Git is present, so the canonical source-repository behaviour is
 * unchanged.
 */
function filesystemFilesFor(rootDir) {
  const results = [];
  const walk = (abs, relPrefix) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        walk(path.join(abs, entry.name), rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  walk(rootDir, '');
  return results;
}

function trackedFilesFor(rootDir) {
  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean);
  } catch {
    // No `.git` or no git binary (e.g., an extracted customer artifact): fall
    // back to the actual on-disk file set. Required-file, forbidden-file, and
    // import-integrity checks downstream still run over this set and fail closed.
    return filesystemFilesFor(rootDir);
  }
}

/**
 * Every file the V1 package is INTENDED to contain: tracked plus untracked,
 * minus `.distignore` exclusions.
 *
 * This is deliberately NOT what ships. `shippedFiles()` is the shipping truth,
 * and it is tracked-plus-allowlisted on purpose. `intendedFiles()` exists so
 * the release checklist can name every file that still has to become part of
 * the repository — the gap between the two is exactly the work the next
 * milestone performs.
 *
 * Non-tracked-but-not-ignored files that are NOT intended for the package
 * (local scratch, internal working notes, dev-only hook infrastructure) are
 * removed here so the manifest reports the intended product, not every loose
 * file in the worktree.
 *
 * @returns {string[]} sorted, repo-relative, POSIX-separated paths
 */
function intendedFilesFor(rootDir) {
  const excluded = makeExcluder(readDistignorePatternsFor(rootDir));
  let listed;
  try {
    listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    // Extracted artifact (no git): every file present is intended.
    listed = filesystemFilesFor(rootDir);
  }
  return listed
    .filter((rel) => !excluded(rel))
    .filter((rel) => !INTERNAL_ONLY.has(rel))
    .filter((rel) => !DEV_ONLY_PREFIXES.some((prefix) => rel.startsWith(prefix)))
    .filter((rel) => !/^m[\d]+-.*\.txt$/.test(rel))
    .sort();
}

function intendedFiles() {
  return intendedFilesFor(ROOT);
}

/**
 * Reject archive-unsafe or out-of-root selections. Pure: string list in,
 * findings out. Every finding names the offending path.
 *
 * @param {string[]} files repo-relative POSIX paths proposed for the archive
 * @returns {string[]} human-readable findings (empty means safe)
 */
function findUnsafePaths(files) {
  const findings = [];
  const seen = new Set();
  const lowered = new Map();
  for (const rel of files) {
    if (typeof rel !== 'string' || rel === '') {
      findings.push('empty archive path');
      continue;
    }
    if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) {
      findings.push(`absolute archive path: ${rel}`);
      continue;
    }
    const segments = rel.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      findings.push(`traversal or empty segment in archive path: ${rel}`);
      continue;
    }
    if (rel.includes('\\')) {
      findings.push(`backslash in archive path (not portable): ${rel}`);
      continue;
    }
    if (seen.has(rel)) {
      findings.push(`duplicate archive path: ${rel}`);
      continue;
    }
    seen.add(rel);
    // Windows extracts case-insensitively: two paths differing only by case
    // would collide there while looking distinct here.
    const key = rel.toLowerCase();
    if (lowered.has(key)) {
      findings.push(`case-collision after Windows normalization: ${rel} vs ${lowered.get(key)}`);
      continue;
    }
    lowered.set(key, rel);
  }
  return findings;
}

/**
 * Pure selection core: the unit-testable heart of `shippedFilesFor`.
 * No git, no filesystem reads for membership (presence is injected) —
 * fixtures drive it with synthetic lists.
 *
 * @param {object} args
 * @param {string[]} args.tracked tracked repo-relative paths
 * @param {Set<string>} args.present untracked allowlisted paths present on disk
 * @param {string[]} args.allowlist UNTRACKED_CUSTOMER_FILES
 * @param {(rel: string) => boolean} args.excluded distignore predicate
 * @param {Set<string>} args.internal INTERNAL_ONLY
 * @param {string[]} args.devOnlyPrefixes DEV_ONLY_PREFIXES
 * @returns {string[]} sorted shipped paths
 */
function selectCustomerFiles({ tracked, present, allowlist, excluded, internal, devOnlyPrefixes }) {
  const shipped = new Set();
  for (const rel of tracked) {
    if (excluded(rel)) continue;
    if (internal.has(rel)) continue;
    shipped.add(rel);
  }
  for (const rel of allowlist) {
    if (!present.has(rel)) continue;
    if (excluded(rel)) continue;
    if (internal.has(rel)) continue;
    shipped.add(rel);
  }
  void devOnlyPrefixes;
  return [...shipped].sort();
}

/**
 * The shipped file set: tracked files plus allowlisted untracked customer
 * files, minus `.distignore` exclusions and internal-only records. Every
 * selected path is verified present as an ordinary file inside the root, and
 * the whole set passes archive-safety validation — violations throw with the
 * offending path named, failing packaging and validation closed.
 *
 * @param {string} rootDir repository root (defaults to this checkout)
 * @returns {string[]} sorted, repo-relative, POSIX-separated paths
 */
function shippedFilesFor(rootDir) {
  const excluded = makeExcluder(readDistignorePatternsFor(rootDir));
  const tracked = trackedFilesFor(rootDir);
  const present = new Set();
  for (const rel of UNTRACKED_CUSTOMER_FILES) {
    const abs = path.join(rootDir, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isFile()) present.add(rel);
  }
  const selected = selectCustomerFiles({
    tracked,
    present,
    allowlist: UNTRACKED_CUSTOMER_FILES,
    excluded,
    internal: INTERNAL_ONLY,
    devOnlyPrefixes: DEV_ONLY_PREFIXES,
  });
  // Presence as ordinary files inside the root (no traversal smuggling a
  // directory or an outside path into the archive).
  for (const rel of selected) {
    const abs = path.resolve(rootDir, rel);
    const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
    if (abs !== rootDir && !abs.startsWith(rootWithSep)) {
      throw new Error(`shipped path escapes the repository root: ${rel}`);
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new Error(`shipped file is not present on disk: ${rel}`);
    }
    if (!stat.isFile()) {
      throw new Error(`shipped path is not an ordinary file: ${rel}`);
    }
  }
  const unsafe = findUnsafePaths(selected);
  if (unsafe.length > 0) {
    throw new Error(`unsafe shipped paths rejected: ${unsafe.join('; ')}`);
  }
  return selected;
}

function shippedFiles() {
  return shippedFilesFor(ROOT);
}

/**
 * Required paths absent from the shipped set.
 *
 * A migration directory counts as shipped when at least one of its files is in
 * the set — the shipped list holds file paths, not directory paths.
 *
 * @returns {{missing: string[], missingMigrations: string[], reasons: string[]}}
 * reasons names each missing path with its cause and remediation.
 */
function missingRequiredFor(rootDir) {
  const shipped = shippedFilesFor(rootDir);
  const shippedSet = new Set(shipped);
  const missing = REQUIRED_FILES.filter((rel) => !shippedSet.has(rel));
  const missingMigrations = onDiskMigrationDirectoriesFor(rootDir).filter(
    (dir) => !shipped.some((file) => file.startsWith(dir)),
  );
  // Actionable reasons: absent from disk vs untracked-and-unlisted vs excluded.
  let trackedSet = null;
  const reasons = [];
  for (const rel of missing) {
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs)) {
      reasons.push(
        `required customer file is absent from the working tree: ${rel} — create it (see docs/installation.md) or remove it from REQUIRED_FILES with an ADR`,
      );
      continue;
    }
    if (trackedSet === null) {
      try {
        trackedSet = new Set(trackedFilesFor(rootDir));
      } catch {
        trackedSet = new Set();
      }
    }
    if (!trackedSet.has(rel) && !UNTRACKED_CUSTOMER_FILES.includes(rel)) {
      reasons.push(
        `required customer file is untracked and not allowlisted: ${rel} — add it to UNTRACKED_CUSTOMER_FILES in scripts/dist-file-set.cjs`,
      );
      continue;
    }
    reasons.push(
      `required customer file is not in the shipped set (excluded or internal): ${rel} — check .distignore and the internal-only classification`,
    );
  }
  return { missing, missingMigrations, reasons };
}

function missingRequired() {
  return missingRequiredFor(ROOT);
}

module.exports = {
  ROOT,
  REQUIRED_FILES,
  UNTRACKED_CUSTOMER_FILES,
  DEV_ONLY_PREFIXES,
  INTERNAL_ONLY,
  shippedFiles,
  shippedFilesFor,
  intendedFiles,
  intendedFilesFor,
  missingRequired,
  missingRequiredFor,
  onDiskMigrationDirectories,
  onDiskMigrationDirectoriesFor,
  readDistignorePatterns,
  readDistignorePatternsFor,
  selectCustomerFiles,
  findUnsafePaths,
};

if (require.main === module) {
  const shipped = shippedFiles();
  const { missing, missingMigrations } = missingRequired();

  if (process.argv.includes('--required')) {
    for (const rel of [...missing, ...missingMigrations]) process.stdout.write(`${rel}\n`);
    process.exit(0);
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          shippedCount: shipped.length,
          missingRequired: missing,
          missingMigrations,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(0);
  }

  for (const rel of shipped) process.stdout.write(`${rel}\n`);
}
