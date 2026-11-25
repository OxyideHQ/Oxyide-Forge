#!/usr/bin/env node
/**
 * Import-integrity gate (M14.2).
 *
 * Ensures that every relative import originating in a shipped TypeScript file
 * resolves to another file that is also in the shipped set. A customer package
 * whose shipped `.ts` files import modules that do not ship cannot be loaded
 * or compiled by the buyer, so the release gate must refuse it with an
 * actionable diagnostic identifying the importing file and the unresolved
 * target.
 *
 * Scope is deliberately narrow and matches the release contract:
 *   - Only relative imports (`./`, `../`) are checked. Bare specifiers
 *     (`fastify`, `pino`, `@fastify/jwt`, ...) are package dependencies and are
 *     validated by the dependency lockfile, not by this gate.
 *   - Only shipped `.ts` files are walked — the customer distribution is TypeScript
 *     source compiled on the customer's machine.
 *   - Resolution follows the project's `NodeNext` convention: a `.js` specifier
 *     maps to a `.ts` source, and extension-less specifiers resolve to `.ts` or
 *     an `index.ts` inside the directory.
 *
 * The core (`findBrokenRelativeImports`) is a pure function that takes an
 * injectable file reader, so the mutation tests exercise it against isolated
 * fixture trees and never touch the real working-tree sources. The CLI below
 * powers the release gate and the black-box subprocess tests.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Split TypeScript/JavaScript source into alternating `code` and `string`
 * tokens. Comments are folded into the surrounding code as a single space so
 * that a `from` keyword separated from its specifier by a comment still links
 * to that specifier. String and template-literal contents are emitted verbatim
 * as their own tokens — critically, an import specifier written inside another
 * string (e.g. a test fixture `writeFileSync(p, "...from './b.js'")`) is part
 * of that outer string's value and is therefore never mistaken for a real
 * import statement.
 *
 * @param {string} source
 * @returns {{ type: 'code' | 'string', value: string }[]}
 */
function tokenize(source) {
  const tokens = [];
  let mode = 'code';
  let buf = '';
  let i = 0;
  const n = source.length;

  const push = (type, value) => {
    if (value) tokens.push({ type, value });
  };

  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];
    if (mode === 'code') {
      if (c === '/' && c2 === '/') {
        // Line comment -> a single space so keyword adjacency survives.
        buf += ' ';
        i += 2;
        while (i < n && source[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && c2 === '*') {
        buf += ' ';
        i += 2;
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        push('code', buf);
        buf = '';
        mode = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl';
        i++;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    // Inside a string/template literal: collect raw value (escape-aware),
    // treating `${...}` in templates as opaque so fixture text never leaks.
    const close = mode === 'sq' ? "'" : mode === 'dq' ? '"' : '`';
    if (c === '\\') {
      buf += c + (c2 || '');
      i += 2;
      continue;
    }
    if (c === close) {
      push('string', buf);
      buf = '';
      mode = 'code';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  push('code', buf);
  return tokens;
}

/**
 * Extract every *real* relative import specifier from a source file. A string
 * token counts as an import specifier only when the immediately preceding code
 * token ends in `from`, is a bare `import`, or ends in `import(` — i.e. it is
 * an actual import/export statement, not string-literal content.
 *
 * @param {string} source
 * @returns {string[]} specifiers beginning with `.` or `..`
 */
function extractRelativeImports(source) {
  const tokens = tokenize(source);
  const specs = new Set();
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.type !== 'string') continue;
    const prev = tokens[k - 1];
    if (!prev || prev.type !== 'code') continue;
    const code = prev.value;
    // Collapse trailing whitespace/newlines so `from\n  'x'` still matches.
    const trimmed = code.replace(/\s+$/, '');
    let isSpecifier = false;
    if (/\bfrom\s*$/.test(trimmed)) isSpecifier = true; // import/export ... from 'x'
    else if (/^\s*import\s*$/.test(code) || /(^|[;{}])\s*import\s*$/.test(code)) isSpecifier = true; // side-effect import 'x'
    else if (/\bimport\s*\(\s*$/.test(trimmed)) isSpecifier = true; // dynamic import('x')
    if (isSpecifier && token.value.startsWith('.')) specs.add(token.value);
  }
  return [...specs];
}

/**
 * Resolve a relative import specifier to the candidate shipped paths it could
 * denote under NodeNext, relative to the repository root.
 *
 * @param {string} fromFileRel importing file, POSIX-relative to root (e.g. `src/app/app.ts`)
 * @param {string} spec relative specifier (e.g. `../config/index.js`)
 * @returns {string[]} candidate POSIX-relative shipped paths (deduplicated, no leading `./`)
 */
function resolveCandidates(fromFileRel, spec) {
  const fromDir = path.posix.dirname(fromFileRel);
  const joined = path.posix.normalize(path.posix.join(fromDir, spec));
  const candidates = [];
  const add = (p) => {
    const clean = p.replace(/^\.\//, '');
    if (clean && clean !== '.' && !candidates.includes(clean)) candidates.push(clean);
  };

  // NodeNext: `.js` specifiers denote the emitted name of a `.ts` source.
  if (joined.endsWith('.js')) add(joined.slice(0, -3) + '.ts');
  // Exact file target (e.g. an already-`.ts` specifier, or a checked-in `.cjs`).
  add(joined);
  // Extension-less module: `foo` -> `foo.ts`.
  add(`${joined}.ts`);
  // Extension-less directory module: `foo` -> `foo/index.ts`.
  if (!joined.endsWith('.ts') && !joined.endsWith('.js') && !joined.endsWith('.cjs')) {
    add(path.posix.join(joined, 'index.ts'));
  }
  return candidates;
}

/**
 * Find shipped files whose relative imports do not resolve inside the set.
 *
 * @param {Set<string>} shippedSet POSIX-relative shipped paths
 * @param {(rel: string) => string} readFile reads a shipped file's source by its relative path
 * @returns {{ source: string, specifier: string, candidates: string[] }[]}
 */
function findBrokenRelativeImports(shippedSet, readFile) {
  const broken = [];
  const tsFiles = [...shippedSet].filter((f) => f.endsWith('.ts')).sort();
  for (const file of tsFiles) {
    let source;
    try {
      source = readFile(file);
    } catch {
      // An unreadable shipped file is a missing-file defect the release
      // validator already fails on; this gate only judges import resolution.
      continue;
    }
    for (const spec of extractRelativeImports(source)) {
      const candidates = resolveCandidates(file, spec);
      if (!candidates.some((c) => shippedSet.has(c))) {
        broken.push({ source: file, specifier: spec, candidates });
      }
    }
  }
  return broken;
}

/**
 * Compute the shipped set for a root using the shared distribution module.
 * Only valid against a real repository checkout (the module uses Git).
 *
 * @param {string} root repository root
 * @returns {Set<string>}
 */
function shippedSetFor(root) {
  // Resolve relative to this script's location so the module is found whether
  // or not root is the current working directory.
  const distFileSet = require(path.join(root, 'scripts', 'dist-file-set.cjs'));
  return new Set(distFileSet.shippedFiles());
}

/**
 * CLI entry: gate a shipped set and exit nonzero on any broken import.
 * Supports `--root` and `--files` (a newline-separated shipped-file list) so the
 * mutation tests can run the same program against isolated fixtures.
 */
function main(argv) {
  let root = process.cwd();
  let filesListPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i];
    else if (argv[i] === '--files') filesListPath = argv[++i];
  }

  let shippedSet;
  try {
    if (filesListPath) {
      const content = fs.readFileSync(filesListPath, 'utf8');
      shippedSet = new Set(content.split('\n').map((s) => s.trim()).filter(Boolean));
    } else {
      shippedSet = shippedSetFor(root);
    }
  } catch (error) {
    process.stderr.write(`IMPORT-INTEGRITY: cannot determine shipped set: ${error.message}\n`);
    return 2;
  }

  const readFile = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const broken = findBrokenRelativeImports(shippedSet, readFile);

  if (broken.length > 0) {
    // Deterministic, actionable diagnostics grouped by importing file.
    for (const entry of broken.sort((a, b) => a.source.localeCompare(b.source))) {
      process.stderr.write(
        `IMPORT-INTEGRITY: ${entry.source} imports '${entry.specifier}' which does not resolve to any shipped file (tried: ${entry.candidates.join(', ')})\n`,
      );
    }
    process.stderr.write(`IMPORT-INTEGRITY: ${broken.length} unresolvable relative import(s) in the shipped set\n`);
    return 1;
  }
  return 0;
}

module.exports = { extractRelativeImports, resolveCandidates, findBrokenRelativeImports, shippedSetFor };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
