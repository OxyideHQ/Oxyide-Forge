#!/usr/bin/env node
'use strict';

/**
 * M13.3 sanitiser pass 3 — removes references to documents that are classified
 * MUST NOT SHIP, so no shipped document points at a path the customer does not
 * receive.
 *
 * `docs/audits/`, `docs/milestones/` and `docs/MEMORY.md` are internal. A
 * customer package that links to them ships broken pointers, which is worse than
 * never having written them.
 *
 * Each rule is explicit rather than a blanket regex: some references are replaced
 * with the shipped document that now carries the contract, others are simply
 * dropped. Nothing is guessed.
 *
 * Run: node scripts/repair-dangling-doc-links.cjs [--dry]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');

const FILES = [
  'README.md',
  '.env.example',
  '.gitleaks.toml',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'docs/development.md',
  'docs/architecture.md',
  'docs/api-conventions.md',
  'docs/auth.md',
  'docs/authorization.md',
  'docs/deployment.md',
  'docs/engineering-standards.md',
  'docs/error-handling.md',
  'docs/migrations.md',
  'docs/production-logging.md',
  'docs/reference-module.md',
  'docs/release-contract.md',
  'docs/rollback-recovery.md',
  'docs/backup-recovery.md',
  'docs/transport-security.md',
  'docs/adr/003-redis.md',
  'docs/adr/008-authentication-session-architecture.md',
];

/** Ordered, explicit repairs. */
const RULES = [
  // Point at the shipped document that now owns the contract.
  [
    /Full trust-boundary policy: `docs\/audits\/m5-08-security-ci-supply-chain\.md`\./g,
    'Full trust-boundary policy: `docs/release-contract.md`.',
  ],
  [
    /Full policy: `docs\/audits\/m5-08-security-ci-supply-chain\.md`\./g,
    'Full policy: `docs/release-contract.md`.',
  ],
  [
    /policy: `docs\/audits\/m5-08-security-ci-supply-chain\.md`\./g,
    'policy: `docs/release-contract.md`.',
  ],
  [
    /See `src\/shared\/logging\/` and `docs\/audits\/m5-06-secure-logging\.md`\./g,
    'See `src/shared/logging/` and `docs/production-logging.md`.',
  ],
  [
    /Full contract: `docs\/audits\/m9-01-health-audit-contract\.md` §§5–7 and `api-conventions\.md` §6\.2\./g,
    'Full contract: `api-conventions.md` §6.2 and `docs/development.md` §6.',
  ],
  [
    /Full contract: `docs\/audits\/m9-01-health-audit-contract\.md` §§5–7 and `docs\/production-logging\.md` for operator guidance\./g,
    'Full contract: `api-conventions.md` §6.2; operator guidance in `docs/production-logging.md`.',
  ],
  [
    /and `docs\/audits\/m3-3-auth-session-architecture\.md`/g,
    '',
  ],
  [
    /see `docs\/audits\/m4-09-multiple-roles\.md` for the full decision record and trigger conditions/g,
    'see the recorded decision below for the full rationale and trigger conditions',
  ],
  [
    /\(record: `docs\/audits\/m11-5-final-email-verification-freeze\.md`\)/g,
    '',
  ],
  [
    / and update the freeze record and `docs\/MEMORY\.md`/g,
    ' and update the documentation',
  ],
  [
    /\| Past decisions and milestone state \| `docs\/MEMORY\.md`, `docs\/adr\/` \|/g,
    '| Architecture decisions and their rationale | `docs/adr/` |',
  ],
  [
    /# docs\/audits\/m5-08 for the pinning \+ update policy\./g,
    '# (documented in docs/release-contract.md)',
  ],
  [
    /# see docs\/audits\/m5-08\./g,
    '# see docs/release-contract.md.',
  ],
  [
    /\s*and `docs\/audits\/m5-08-security-ci-supply-chain\.md`/g,
    '',
  ],
  // The en-dash orphan left by pass 1 when "M3.3-dependency map" lost its prefix.
  [/\bthe\s+–dependency map\b/g, 'the dependency map'],
  [/\bthe\s+—dependency map\b/g, 'the dependency map'],
];

function main() {
  let touched = 0;
  for (const rel of FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const original = fs.readFileSync(file, 'utf8');
    let out = original;
    for (const [re, to] of RULES) out = out.replace(re, to);
    out = out.replace(/[ \t]+$/gm, '').replace(/ +\n/g, '\n');
    if (out !== original) {
      touched += 1;
      process.stdout.write(`  ${rel}\n`);
      if (!DRY) fs.writeFileSync(file, out);
    }
  }
  process.stdout.write(`${DRY ? '[dry run] ' : ''}repaired ${touched} file(s)\n`);
}

main();
