#!/usr/bin/env node
'use strict';

/**
 * M13.3 sanitiser pass 2 — repairs the punctuation orphaned by pass 1.
 *
 * Pass 1 removed milestone identifiers and, correctly, left their neighbouring
 * separators behind:
 *
 *     "Email subsystem (M11, frozen):"   ->  "Email subsystem (, frozen):"
 *     "(M7.3 pagination, M7.4 sorting)" ->  "(pagination, )"
 *
 * This pass removes a separator only when the neighbouring slot is empty, so a
 * comma between two real clauses is never touched:
 *
 *     "list, and remove"          -> unchanged
 *     "Email subsystem (, frozen)" -> "Email subsystem (frozen)"
 *     "(pagination, )"             -> "(pagination)"
 *
 * Run: node scripts/repair-doc-punctuation.cjs [--dry]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');

const TARGETS = [
  '.env.example',
  'README.md',
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
];

const REPAIRS = [
  // "(, frozen)" / "( — frozen)" : leading separator in a non-empty parenthetical
  [/\(\s*[,–—]\s+(?=\S)/g, '('],
  // "(pagination, )" / "(pagination,)" : trailing separator before the close
  [/\s*[,–—]\s*\)/g, ')'],
  // "(, )" / "( – )" : a parenthetical that is now empty
  [/\(\s*[,–—\s]+\)/g, ''],
  // ", )" left at the end of a list inside brackets: "…, )" handled above
  // Double separators produced by the above, e.g. "( , )"
  [/\(\s*[,–—]\s*[,–—]\s*/g, '('],
  // A space that now precedes an opening bracket after a removed clause.
  [/ +\(/g, ' ('],
];

function repair(text) {
  let out = text;
  for (const [re, to] of REPAIRS) out = out.replace(re, to);
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/ +\(/g, ' (')
    .replace(/\(,\)/g, '')
    .replace(/[ \t]+$/gm, '');
}

function main() {
  const files = [
    ...TARGETS.map((rel) => path.join(ROOT, rel)),
    ...fs
      .readdirSync(path.join(ROOT, 'docs', 'adr'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(ROOT, 'docs', 'adr', f)),
  ];

  let touched = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const original = fs.readFileSync(file, 'utf8');
    const fixed = repair(original);
    if (fixed !== original) {
      touched += 1;
      process.stdout.write(`  ${path.relative(ROOT, file)}\n`);
      if (!DRY) fs.writeFileSync(file, fixed);
    }
  }
  process.stdout.write(`${DRY ? '[dry run] ' : ''}repaired ${touched} file(s)\n`);
}

main();
