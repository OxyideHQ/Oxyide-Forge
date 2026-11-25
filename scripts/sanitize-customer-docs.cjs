#!/usr/bin/env node
'use strict';

/**
 * M13.3 sanitiser — removes internal milestone / audit identifiers from
 * customer-facing documentation.
 *
 * Run:  node scripts/sanitize-customer-docs.cjs [--dry]
 *
 * WHY THIS IS A SCRIPT AND NOT A REGEX ONE-LINER
 * ----------------------------------------------
 * The ~530 internal references (M3.16, M7.9, M131-F02 …) appear in prose, not
 * in data. Deleting the token blindly produces broken sentences:
 *
 *   "implemented in M3.6, general revocation"  ->  "implemented in , general"
 *
 * So removal is ordered from the safest shape to the most context-sensitive,
 * and every rule below preserves the surrounding words. The script reports what
 * it changed and what it deliberately left, because a leftover reference is a
 * documentation defect while a mangled sentence is a worse one.
 *
 * ORDER MATTERS. Parentheticals go first (self-contained), then appositives
 * whose head noun is kept, then list attributes, and only then the bare
 * subject-position ones — which are the ones most likely to need a human.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');

// A milestone or audit identifier. M13.2-N01 style suffixes included.
const ID = String.raw`M\d{1,2}(?:\.\d+)?(?:-F\d+)?`;

/** The customer-facing set: shipped docs + .env.example. */
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

const ADR_DIR = path.join(ROOT, 'docs', 'adr');

/**
 * Ordered rules. Each returns [replacement] or null to leave the line alone.
 * `note` explains why the shape is safe to rewrite.
 */
const RULES = [
  // 1. A parenthetical that contains only milestone IDs and separators:
  //    " (M3.16)", " (M5.4)", " (M131-F02)"  ->  ""
  {
    note: 'pure-ID parenthetical',
    re: new RegExp(String.raw`\s*\(\s*${ID}(?:\s*[,;/]\s*${ID})*\s*\)`, 'g'),
    to: () => '',
  },
  // 2. Parenthetical where every ID is followed by a descriptive noun that must
  //    survive: " (M7.3 pagination, M7.4 sorting)" -> " (pagination, sorting)"
  {
    note: 'ID + noun inside parentheses',
    re: new RegExp(String.raw`\(\s*${ID}\s+([A-Za-z][\w ()/-]{1,40}?)\s*(?=[,)]|$)`, 'g'),
    to: (_m, noun) => `(${noun.trim()}`,
  },
  // 3. "the M9.3 amendment" / "an M5.8 rule" — keep the head noun.
  {
    note: 'ID as appositive before a noun',
    re: new RegExp(String.raw`\b(?:the|a|an|its|per)\s+${ID}\s+([a-z][\w-]{2,})`, 'g'),
    to: (_m, noun) => `the ${noun}`,
  },
  // 4. "frozen M7.10" / "recorded M95-F04" — the adjective/verb carries meaning.
  {
    note: 'ID after a participle',
    re: new RegExp(String.raw`\b(frozen|recorded|carried|per|under|via)\s+${ID}\b`, 'g'),
    to: (_m, word) => word,
  },
  // 5. "M7.3 pagination, M7.4 sorting, and M7.5 filtering" -> "pagination, sorting,
  //    and filtering"  (inline attribute lists)
  {
    note: 'inline attribute list',
    re: new RegExp(String.raw`\b${ID}\s+(?=[a-z][\w-]+)`, 'g'),
    to: () => '',
  },
  // 6. "in M3.6," / "since M7.9;" / "by M11 —" — ID after a preposition,
  //    followed by punctuation or a non-lowercase word.
  {
    note: 'ID after preposition',
    re: new RegExp(String.raw`\b(in|since|from|by|during|per|at)\s+${ID}\b(?=[\s,.;:)—-]|$)`, 'g'),
    to: (_m, prep) => prep,
  },
  // 7. Bare ID as a sentence subject: "M3 has no requirement" -> "The product has
  //    no requirement" is too much to assume, so the ID is dropped and the
  //    sentence capitalised only when it opened the line.
  {
    note: 'bare ID token',
    re: new RegExp(String.raw`\b${ID}\b`, 'g'),
    to: () => '',
  },
];

function sanitise(text) {
  let out = text;
  const applied = [];
  for (const rule of RULES) {
    let hits = 0;
    out = out.replace(rule.re, (...args) => {
      // Count only real replacements.
      hits += 1;
      return rule.to(...args);
    });
    if (hits > 0) applied.push(`${rule.note}: ${hits}`);
  }
  return { out, applied };
}

/** Tidy the whitespace and punctuation orphaned by removal. */
function tidy(text) {
  return text
    .replace(/[ \t]{2,}/g, ' ')                       // doubled spaces
    .replace(/ +\n/g, '\n')                            // trailing space
    .replace(/ +([,.;:)])/g, '$1')                     // space before punctuation
    .replace(/\(\s*\)/g, '')                           // emptied parentheses
    .replace(/,\s*\./g, '.')                           // ", ." -> "."
    .replace(/,\s*,/g, ',')                             // ", ," -> ","
    .replace(/\n{3,}/g, '\n\n')                        // triple blank lines
    .replace(/^(#+)\s*$/gm, '$1')                       // bare heading markers
    .replace(/[ \t]+$/gm, '');                          // trailing whitespace
}

function main() {
  const files = [
    ...TARGETS.map((rel) => path.join(ROOT, rel)),
    ...fs
      .readdirSync(ADR_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(ADR_DIR, f)),
  ];

  let totalBefore = 0;
  let totalAfter = 0;
  const summary = [];

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const original = fs.readFileSync(file, 'utf8');
    const before = (original.match(new RegExp(String.raw`\b${ID}\b`, 'g')) || []).length;
    const { out, applied } = sanitise(original);
    const cleaned = tidy(out);
    const after = (cleaned.match(new RegExp(String.raw`\b${ID}\b`, 'g')) || []).length;

    totalBefore += before;
    totalAfter += after;

    if (before > 0) {
      summary.push(
        `  ${path.relative(ROOT, file).padEnd(48)} ${String(before).padStart(4)} -> ${String(after).padStart(3)}  [${applied.join(', ') || 'no rule matched'}]`,
      );
      if (!DRY && cleaned !== original) fs.writeFileSync(file, cleaned);
    }
  }

  process.stdout.write(`${DRY ? '[dry run] ' : ''}internal identifiers: ${totalBefore} -> ${totalAfter}\n`);
  process.stdout.write(`${summary.join('\n')}\n`);
}

main();
