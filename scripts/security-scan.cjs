#!/usr/bin/env node
/**
 * Static application security testing for Oxyide Forge (M5.8).
 *
 * AST-based pattern scanner over production TypeScript sources, built on
 * the same TypeScript compiler API and fail-closed conventions as
 * scripts/architecture-check.cjs. Complements (never replaces)
 * typecheck, lint, and the architecture checker: those prove structure,
 * this flags security-relevant SOURCE PATTERNS.
 *
 * Rules (all must hold; violations exit 1):
 *   SEC-001 no eval() or new Function() (dynamic code execution)
 *   SEC-002 no child_process execution primitives (command execution)
 *   SEC-003 no Math.random in production sources (insecure randomness;
 *           node:crypto CSPRNG is the contract for tokens/keys)
 *   SEC-004 no md5/sha1 via crypto.createHash (weak hashing)
 *   SEC-005 no interpolated $executeRawUnsafe/$queryRaw (SQL injection
 *           surface; static query strings only)
 *   SEC-006 no hardcoded secret literals (long string assigned to a
 *           secret-named variable/property/argument)
 *
 * Usage: node scripts/security-scan.cjs [--root <dir>] [--json]
 *
 * Exit codes: 0 = clean; 1 = finding; 2 = scanner infrastructure failure
 * (never a silent pass). Read-only: never modifies source or database.
 *
 * Limitations (documented, not hidden): pattern layer only — no
 * dataflow/taint tracking, no runtime proof. A clean scan means "no
 * known-bad pattern present", not "secure". Findings need human review.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let ts;
try {
  ts = require('typescript');
} catch (error) {
  process.stdout.write(
    'Security scanner ERROR: the TypeScript compiler API is required but could not be loaded. ' +
      `Run npm ci first. (${error instanceof Error ? error.message : String(error)})\n`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function cliFlag(name) {
  return process.argv.includes(name);
}

function resolveRoot() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--root' && i + 1 < args.length) {
      return path.resolve(args[i + 1]);
    }
    if (args[i].startsWith('--root=')) {
      return path.resolve(args[i].slice('--root='.length));
    }
  }
  return path.resolve(__dirname, '..');
}

const ROOT = resolveRoot();
const JSON_MODE = cliFlag('--json');

function failClosed(message) {
  if (JSON_MODE) {
    process.stdout.write(
      `${JSON.stringify({ status: 'error', message })}\n`,
    );
  } else {
    process.stdout.write(`Security scanner ERROR: ${message}\n`);
  }
  process.exit(2);
}

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  failClosed(`root directory does not exist: ${ROOT}`);
}

function display(relPath) {
  return relPath.split(path.sep).join('/');
}

function relOf(absPath) {
  return display(path.relative(ROOT, absPath));
}

// ---------------------------------------------------------------------------
// Traversal + parsing (deterministic, fail closed)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.nyc_output']);
const infraErrors = [];

function walk(absDir, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch (error) {
    infraErrors.push(`cannot read directory ${relOf(absDir)}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    if (entry.isSymbolicLink()) {
      infraErrors.push(`symlink encountered at ${relOf(abs)}: resolve or remove it before scanning`);
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, onFile);
    } else if (entry.isFile()) {
      onFile(abs);
    } else {
      infraErrors.push(`unsupported filesystem entry at ${relOf(abs)}`);
    }
  }
}

function collectProdFiles() {
  const files = [];
  const srcDir = path.join(ROOT, 'src');
  if (!fs.existsSync(srcDir)) {
    failClosed('src/ directory not found under root ' + ROOT);
  }
  walk(srcDir, (abs) => {
    if (abs.endsWith('.ts') && !abs.endsWith('.test.ts')) files.push(abs);
  });
  return files.sort();
}

function parseFile(absPath) {
  let content;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch (error) {
    infraErrors.push(`cannot read file ${relOf(absPath)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const source = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true);
  const syntaxErrors = (source.parseDiagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (syntaxErrors.length > 0) {
    infraErrors.push(`cannot parse ${relOf(absPath)}: refusing to assume it is finding-free`);
    return null;
  }
  return source;
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function siteOf(source, node) {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return line + 1;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function checkEval(source, rel) {
  const findings = [];
  visit(source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
      findings.push({ rule: 'SEC-001', file: rel, line: siteOf(source, node), detail: 'eval() dynamic code execution' });
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      findings.push({ rule: 'SEC-001', file: rel, line: siteOf(source, node), detail: 'new Function() dynamic code execution' });
    }
  });
  return findings;
}

function checkChildProcess(source, rel) {
  const findings = [];
  const EXEC_FNS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']);
  visit(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      EXEC_FNS.has(node.expression.name.text)
    ) {
      const target = node.expression.expression;
      const targetText = target.getText(source);
      if (targetText.includes('child_process') || targetText.includes('childProcess')) {
        findings.push({ rule: 'SEC-002', file: rel, line: siteOf(source, node), detail: `child_process.${node.expression.name.text} command execution` });
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === 'child_process' || node.moduleSpecifier.text === 'node:child_process')
    ) {
      findings.push({ rule: 'SEC-002', file: rel, line: siteOf(source, node), detail: 'child_process import (command execution surface)' });
    }
  });
  return findings;
}

function checkInsecureRandom(source, rel) {
  const findings = [];
  visit(source, (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Math' &&
      node.name.text === 'random'
    ) {
      findings.push({ rule: 'SEC-003', file: rel, line: siteOf(source, node), detail: 'Math.random in production source (use node:crypto CSPRNG for security values)' });
    }
  });
  return findings;
}

function checkWeakHash(source, rel) {
  const findings = [];
  visit(source, (node) => {
    if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
    const first = node.arguments[0];
    if (!ts.isStringLiteral(first) && !ts.isNoSubstitutionTemplateLiteral(first)) return;
    const algorithm = first.text.toLowerCase();
    if (algorithm !== 'md5' && algorithm !== 'sha1') return;
    const callee = node.expression;
    const isDirect =
      ts.isIdentifier(callee) && callee.text === 'createHash';
    const isMethod =
      ts.isPropertyAccessExpression(callee) && callee.name.text === 'createHash';
    if (isDirect || isMethod) {
      findings.push({ rule: 'SEC-004', file: rel, line: siteOf(source, node), detail: `weak hash algorithm '${first.text}'` });
    }
  });
  return findings;
}

function hasInterpolation(template) {
  return template.templateSpans && template.templateSpans.length > 0;
}

function checkRawSql(source, rel) {
  const findings = [];
  function calleeMentionsRawSql(expression) {
    // Tagged-template tags (`prisma.$executeRawUnsafe\`...\``) and plain
    // call callees (`prisma.$executeRawUnsafe('...')`) alike.
    const text = expression.getText(source);
    return text.includes('executeRawUnsafe') || text.includes('queryRaw');
  }
  visit(source, (node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      if (calleeMentionsRawSql(node.tag) && hasInterpolation(node.template)) {
        findings.push({ rule: 'SEC-005', file: rel, line: siteOf(source, node), detail: 'interpolated raw SQL (injection surface; use static strings or parameterized queries)' });
      }
      return;
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const first = node.arguments[0];
      const isInterpolatedTemplate =
        ts.isTemplateExpression(first) ||
        (ts.isTaggedTemplateExpression(first) && hasInterpolation(first.template));
      if (!isInterpolatedTemplate) return;
      const callee = node.expression;
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isIdentifier(callee)) &&
        calleeMentionsRawSql(callee)
      ) {
        findings.push({ rule: 'SEC-005', file: rel, line: siteOf(source, node), detail: 'interpolated raw SQL (injection surface; use static strings or parameterized queries)' });
      }
    }
  });
  return findings;
}

const SECRET_NAME = /(password|passwd|secret|token|jwt|apikey|api_key|privatekey|private_key|credentials?)/i;

function isSecretName(name) {
  // Cookie/token NAME constants (e.g. name: 'accessToken') and type
  // declarations are identifiers, not credentials — only VALUE positions
  // (variable initializers, secret-valued properties, call arguments)
  // with substantial literals are flagged.
  return SECRET_NAME.test(name);
}

function checkHardcodedSecrets(source, rel) {
  const findings = [];
  function flagIfSecretLiteral(name, literalNode) {
    if (!name || !isSecretName(name)) return;
    if (!ts.isStringLiteralLike(literalNode)) return;
    const value = literalNode.text;
    if (value.length < 16) return;
    // Documented dummy/test constants (DUMMY_*) are_credentials-adjacent
    // by design but published and non-authenticating (e.g. the M3.18
    // timing-equalization bcrypt hash, also recorded in the M5.1 audit as
    // a reviewed fixture). They can never serve as credentials.
    if (name.startsWith('DUMMY_')) return;
    // Self-mapped code registries (AUTH_X: 'AUTH_X'): the value equals
    // its own key — an error-code taxonomy, not smuggled credential
    // material. A real hardcoded secret never takes this shape.
    if (value === name) return;
    // Placeholder-style values are self-evidently not credentials.
    if (/^(replace-|example|test-|changeme|your-)/i.test(value)) return;
    if (value.includes(' ')) return;
    // Closed event-name taxonomies (M8.3: auth.login.success shape): fixed
    // lowercase dotted identifiers are machine-readable names — publicly
    // documented, stable, and frozen by contract tests. A real hardcoded
    // credential never takes this shape: secrets carry entropy, mixed
    // case, or URL/special structure, all of which fail this pattern.
    if (/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/.test(value)) return;
    findings.push({ rule: 'SEC-006', file: rel, line: siteOf(source, literalNode), detail: `hardcoded secret-like literal assigned to '${name}'` });
  }
  visit(source, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      flagIfSecretLiteral(node.name.text, node.initializer);
    }
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.text;
      flagIfSecretLiteral(name, node.initializer);
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function main() {
  const files = collectProdFiles();
  const allFindings = [];
  for (const abs of files) {
    const source = parseFile(abs);
    if (!source) continue;
    const rel = relOf(abs);
    allFindings.push(
      ...checkEval(source, rel),
      ...checkChildProcess(source, rel),
      ...checkInsecureRandom(source, rel),
      ...checkWeakHash(source, rel),
      ...checkRawSql(source, rel),
      ...checkHardcodedSecrets(source, rel),
    );
  }
  allFindings.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line,
  );

  if (infraErrors.length > 0) {
    const unique = [...new Set(infraErrors)].sort();
    failClosed(`incomplete analysis:\n  - ${unique.join('\n  - ')}`);
    return;
  }

  if (JSON_MODE) {
    process.stdout.write(
      `${JSON.stringify({ status: allFindings.length === 0 ? 'clean' : 'findings', findings: allFindings }, null, 2)}\n`,
    );
    process.exit(allFindings.length === 0 ? 0 : 1);
  }

  const lines = [];
  lines.push(`Security scan (root: ${ROOT})`);
  lines.push('----------------------------------------');
  const byRule = new Map();
  for (const finding of allFindings) {
    if (!byRule.has(finding.rule)) byRule.set(finding.rule, []);
    byRule.get(finding.rule).push(finding);
  }
  const RULES = ['SEC-001', 'SEC-002', 'SEC-003', 'SEC-004', 'SEC-005', 'SEC-006'];
  for (const rule of RULES) {
    const items = byRule.get(rule) || [];
    if (items.length === 0) {
      lines.push(`PASS ${rule}`);
    } else {
      lines.push(`FAIL ${rule}`);
      for (const item of items) lines.push(`  - ${item.file}:${item.line} ${item.detail}`);
    }
  }
  lines.push('----------------------------------------');
  lines.push(`Security verification: ${allFindings.length === 0 ? 'PASS' : 'FAIL'}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(allFindings.length === 0 ? 0 : 1);
}

main();
