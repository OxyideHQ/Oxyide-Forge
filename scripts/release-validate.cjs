#!/usr/bin/env node
/**
 * Release validation for Oxyide Forge (M5.8).
 *
 * Validates that a customer release is safe to ship WITHOUT executing the
 * release itself:
 *   1. forbidden entries (real env files, keys, internal records,
 *      generated artifacts, VCS/dependency/build debris) are excluded;
 *   2. required customer files are present — including the normative
 *      production container artifact (M131-F02) — and the COMPLETE on-disk
 *      migration history ships (M131-F03);
 *   3. version consistency (package.json vs --tag vX.Y.Z when given);
 *   4. a fresh SBOM exists and re-validates (regenerate freshness is
 *      proven by running `security:sbom` first in the pipeline);
 *   5. writes machine-readable release evidence (version, revision,
 *      toolchain, lockfile/SBOM hashes, file inventory, timestamp).
 *
 * M13.2 — the shipped set is no longer computed inline. It comes from
 * `scripts/dist-file-set.cjs`, which `scripts/package.sh` also consumes, so
 * validation and packaging genuinely cannot drift (M131-F01). This script used
 * to build its own `git ls-files` copy while the packager copied the working
 * tree; the two sets disagreed, so required files that were untracked shipped
 * without ever being validated and release validation still reported PASS.
 *
 * Usage: node scripts/release-validate.cjs [--tag vX.Y.Z] [--evidence <path>]
 * Exit codes: 0 = releasable; 1 = blocked (lists reasons); 2 = infra failure.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  REQUIRED_FILES,
  shippedFiles,
  missingRequired,
  onDiskMigrationDirectories,
} = require('./dist-file-set.cjs');
const { findBrokenRelativeImports } = require('./import-integrity.cjs');

function fail(reasons) {
  process.stdout.write('Release validation FAIL (release BLOCKED):\n');
  for (const reason of reasons) process.stdout.write(`  - ${reason}\n`);
  process.exit(1);
}

function failClosed(message) {
  process.stdout.write(`Release validation ERROR: ${message}\n`);
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');

function cliValue(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return null;
}

const TAG = cliValue('--tag');
const EVIDENCE_PATH = cliValue('--evidence') || path.join(ROOT, 'release-evidence.json');

function sha256File(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch (error) {
    failClosed(`cannot hash ${abs}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return '';
}

// --- Shipped set: single source of truth (scripts/dist-file-set.cjs) --------
let shipped;
try {
  shipped = shippedFiles();
} catch (error) {
  failClosed(
    `cannot compute the shipped file set: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const reasons = [];

// --- 1. Forbidden entries ---------------------------------------------------
const FORBIDDEN = [
  '.env',
  'personal/',
  'docs/audits/',
  'docs/milestones/',
  'sbom.cyclonedx.json',
  'release-evidence.json',
  'node_modules/',
  'dist/',
  'coverage/',
  '.git/',
];
for (const entry of FORBIDDEN) {
  const hit = shipped.filter((rel) => rel === entry || rel.startsWith(entry.endsWith('/') ? entry : `${entry}/`) || rel === entry.replace(/\/$/, ''));
  if (entry === '.env') {
    // Exact-file match only: .env.example MUST ship.
    if (shipped.includes('.env')) {
      reasons.push('real environment file .env would ship to customers');
    }
    continue;
  }
  if (hit.length > 0) {
    reasons.push(`excluded ${entry} would ship (${hit.length} file(s), e.g. ${hit[0]})`);
  }
}
const keyLike = shipped.filter((rel) => /\.(pem|key|p12|pfx|jks)$/i.test(rel));
if (keyLike.length > 0) {
  reasons.push(`key material would ship: ${keyLike.join(', ')}`);
}

// --- 2. Required files ------------------------------------------------------
// M131-F02/M131-F03: the previous gate required a fixed list that omitted the
// container artifact entirely, and asserted only that *some* Prisma migration
// shipped — which the two tracked migrations satisfied while eight were
// missing, so a customer could never reach schema. Both are now enforced here
// from the same module the packager consumes.
const { missing, missingMigrations } = missingRequired();
for (const required of REQUIRED_FILES) {
  if (missing.includes(required)) {
    reasons.push(
      `required customer file is not in the shipped set (untracked or excluded): ${required}`,
    );
  }
}
if (missingMigrations.length > 0) {
  const names = missingMigrations
    .map((dir) => dir.replace('prisma/migrations/', '').replace(/\/$/, ''))
    .join(', ');
  reasons.push(
    `${missingMigrations.length} Prisma migration(s) would not ship — a customer could not reach schema via the documented 'npx prisma migrate deploy': ${names}`,
  );
}
if (onDiskMigrationDirectories().length === 0) {
  reasons.push('no Prisma migrations exist on disk');
}

// --- 3. Version consistency ---------------------------------------------------
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch (error) {
  failClosed(`cannot read package.json: ${error instanceof Error ? error.message : String(error)}`);
}
if (TAG !== null) {
  const match = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(TAG);
  if (!match) {
    reasons.push(`tag ${JSON.stringify(TAG)} is not a valid release tag (expected vX.Y.Z)`);
  } else if (match[1] !== pkg.version) {
    reasons.push(`tag version ${match[1]} does not match package.json version ${pkg.version}`);
  }
}

// An extracted customer artifact carries no `.distignore` (packager config,
// deliberately excluded); a source checkout always has it. This flag scopes the
// SBOM-freshness gate, which is a release-PROCESS check, not a package-integrity
// check — the customer ZIP legitimately never contains the SBOM. Every integrity
// check below (required files, forbidden files, key material, migrations, import
// integrity) stays fail-closed in both contexts.
const isExtractedArtifact = !fs.existsSync(path.join(ROOT, '.distignore'));

// --- 4. SBOM freshness --------------------------------------------------------
const sbomPath = path.join(ROOT, 'sbom.cyclonedx.json');
const sbomPresent = fs.existsSync(sbomPath);
if (!sbomPresent) {
  if (isExtractedArtifact) {
    // LOUD skip, never silent: freshness is proven in the source checkout via
    // `npm run security:sbom && npm run release:check`. An absent SBOM in an
    // extracted artifact is expected and is NOT a package-integrity violation.
    process.stdout.write(
      'NOTE sbom.cyclonedx.json absent — SBOM freshness not applicable to an extracted artifact (a source-release gate); integrity checks below are still enforced.\n',
    );
  } else {
    reasons.push('sbom.cyclonedx.json missing (run npm run security:sbom before release)');
  }
} else {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'sbom-validate.cjs'), sbomPath], {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    reasons.push(`SBOM re-validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- 5. Import integrity -----------------------------------------------------
// M14.2: a shipped `.ts` file that imports a module which does not also ship
// produces a customer package that cannot compile. Walk every shipped `.ts`
// file's relative imports and fail (with the importing file and the unresolved
// target) when one resolves outside the shipped set. The resize/read step is
// injected as a small closure so the gate stays a pure, unit-testable function
// in scripts/import-integrity.cjs.
const importBroken = findBrokenRelativeImports(
  new Set(shipped),
  (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'),
);
for (const entry of importBroken) {
  reasons.push(
    `shipped file ${entry.source} imports '${entry.specifier}' which does not resolve to any shipped file`,
  );
}

if (reasons.length > 0) {
  fail(reasons);
}

// --- 5. Evidence --------------------------------------------------------------
let revision = '';
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  revision = 'unknown';
}
const sbom = sbomPresent ? JSON.parse(fs.readFileSync(sbomPath, 'utf8')) : null;
const evidence = {
  artifact: `oxyide-forge-v${pkg.version}`,
  version: pkg.version,
  tag: TAG,
  revision,
  node: process.version,
  packageManager: 'npm',
  lockfileSha256: sha256File(path.join(ROOT, 'package-lock.json')),
  sbom: sbomPresent
    ? {
        file: 'sbom.cyclonedx.json',
        sha256: sha256File(sbomPath),
        format: bomFormatOf(sbom),
        components: Array.isArray(sbom.components) ? sbom.components.length : 0,
      }
    : { file: null, note: 'SBOM not present in extracted artifact' },
  shippedFiles: shipped.length,
  producedAt: new Date().toISOString(),
};

function bomFormatOf(bom) {
  return `${bom.bomFormat || 'unknown'} ${bom.specVersion || ''}`.trim();
}

try {
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  failClosed(`cannot write evidence file: ${error instanceof Error ? error.message : String(error)}`);
}

process.stdout.write(
  `Release validation PASS: ${evidence.artifact} releasable (${shipped.length} files, SBOM ${evidence.sbom.components ?? 'n/a (extracted artifact)'} components, revision ${revision.slice(0, 12)}).\nEvidence: ${EVIDENCE_PATH}\n`,
);
process.exit(0);
