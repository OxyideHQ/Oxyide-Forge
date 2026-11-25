#!/usr/bin/env node
/**
 * Automated architecture enforcement for Oxyide Forge (M1.7).
 *
 * Verifies the invariants established by M1.1-M1.6 against the working tree:
 * module boundaries, transaction ownership, PrismaClient ownership,
 * process.env ownership, leaf-layer isolation, legacy roots, import cycles,
 * placeholder policy, and integration-test DB gating.
 *
 * Usage: node scripts/architecture-check.cjs [--root <dir>]
 *
 * Exit codes: 0 = all rules pass; 1 = architecture violation;
 * 2 = checker infrastructure failure (never a silent pass).
 *
 * The checker is read-only: it never modifies source files or the database
 * and requires no external services.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let ts;
try {
  ts = require('typescript');
} catch (error) {
  process.stdout.write(
    'Architecture checker ERROR: the TypeScript compiler API is required but could not be loaded. ' +
      `Run npm ci first. (${error instanceof Error ? error.message : String(error)})\n`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// CLI / root handling
// ---------------------------------------------------------------------------

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

function failClosed(message) {
  process.stdout.write(`Architecture checker ERROR: ${message}\n`);
  process.exit(2);
}

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  failClosed(`root directory does not exist: ${ROOT}`);
}

// Display paths with forward slashes so output is stable across platforms.
function display(relPath) {
  return relPath.split(path.sep).join('/');
}

function relOf(absPath) {
  return display(path.relative(ROOT, absPath));
}

function segmentsOf(relPath) {
  return relPath.split('/');
}

function isUnder(relPath, prefixSegments) {
  const segments = segmentsOf(relPath);
  if (segments.length < prefixSegments.length) return false;
  return prefixSegments.every((segment, index) => segments[index] === segment);
}

// ---------------------------------------------------------------------------
// Filesystem traversal (deterministic, symlink-safe)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.nyc_output']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

// Walk `dirAbs`, invoking `onFile(absPath)` for every regular file.
// Records an infrastructure error for symlinks (fail closed: never silently
// skip repository content) and for unreadable entries.
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
      infraErrors.push(`symlink encountered at ${relOf(abs)}: resolve or remove it before checking`);
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, onFile);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      onFile(abs);
    } else {
      infraErrors.push(`unsupported filesystem entry at ${relOf(abs)}`);
    }
  }
}

function collectTsFiles() {
  const files = [];
  const srcDir = path.join(ROOT, 'src');
  if (!fs.existsSync(srcDir)) {
    failClosed('src/ directory not found under root ' + ROOT);
  }
  walk(srcDir, (abs) => {
    if (abs.endsWith('.ts')) files.push(abs);
  });
  return files.sort();
}

// ---------------------------------------------------------------------------
// TypeScript parsing (fail closed on syntax errors)
// ---------------------------------------------------------------------------

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
    infraErrors.push(`cannot parse ${relOf(absPath)}: refusing to assume it is violation-free`);
    return null;
  }
  return source;
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

// ---------------------------------------------------------------------------
// Import extraction + resolution
// ---------------------------------------------------------------------------

function rawImportSpecifiers(source) {
  const specifiers = [];
  visit(source, (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) specifiers.push(spec.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(callee) && callee.text === 'require' && node.arguments.length === 1;
      if ((isDynamicImport || isRequire) && node.arguments.length === 1) {
        const first = node.arguments[0];
        if (ts.isStringLiteral(first)) specifiers.push(first.text);
      }
    }
  });
  return specifiers;
}

// Resolve a relative specifier to an absolute .ts path inside ROOT.
// Returns { kind: 'external' } for bare specifiers,
// { kind: 'resolved', abs } on success, { kind: 'unresolvable' } otherwise.
function resolveSpecifier(fromAbs, specifier) {
  if (!specifier.startsWith('.')) return { kind: 'external' };
  const base = path.resolve(path.dirname(fromAbs), specifier);
  const candidates = [];
  if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts');
  if (base.endsWith('.ts')) candidates.push(base);
  candidates.push(`${base}.ts`);
  candidates.push(path.join(base, 'index.ts'));
  for (const candidate of candidates) {
    let stat = null;
    try {
      stat = fs.statSync(candidate);
    } catch {
      stat = null;
    }
    if (stat && stat.isFile()) {
      const rel = path.relative(ROOT, candidate);
      if (rel === '' || rel.startsWith('..')) return { kind: 'unresolvable' };
      return { kind: 'resolved', abs: candidate };
    }
  }
  return { kind: 'unresolvable' };
}

function moduleOf(relPath) {
  const segments = segmentsOf(relPath);
  if (segments[0] === 'src' && segments[1] === 'modules' && segments[2]) return segments[2];
  return null;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const rules = [];

function defineRule(id, name, run) {
  rules.push({ id, name, run });
}

// ARCH-ENF-001: a domain module must not import another module's repository.
defineRule('ARCH-ENF-001', 'Cross-module repository imports', (ctx) => {
  const violations = [];
  for (const file of ctx.prodFiles) {
    const fromRel = relOf(file.abs);
    const fromModule = moduleOf(fromRel);
    for (const edge of file.edges) {
      if (edge.kind !== 'resolved') continue;
      const toRel = relOf(edge.abs);
      const toModule = moduleOf(toRel);
      if (!toModule) continue;
      if (!segmentsOf(toRel).includes('repositories')) continue;
      if (fromModule !== toModule) {
        violations.push(
          `${fromRel} -> ${toRel} (modules may only use another module's public service contract)`,
        );
      }
    }
  }
  return violations;
});

// ARCH-ENF-002: $transaction belongs to services (and tests), nowhere else.
defineRule('ARCH-ENF-002', 'Transaction ownership', (ctx) => {
  const violations = [];
  for (const file of ctx.prodFiles) {
    const fromRel = relOf(file.abs);
    const segments = segmentsOf(fromRel);
    const base = segments[segments.length - 1];
    // Ownership by layer/convention, not by filename: transaction boundaries
    // belong to service (or use-case) files. The repository follows role-suffix
    // file naming (engineering standards section 2/3), so a service file is a
    // *.service.ts file or anything under a services/ (or use-cases/) directory.
    const isServiceFile =
      segments[0] === 'src' &&
      segments[1] === 'modules' &&
      (segments.includes('services') ||
        segments.includes('use-cases') ||
        base.endsWith('.service.ts') ||
        base.endsWith('.use-case.ts'));
    if (isServiceFile) continue;
    let callsTransaction = false;
    visit(file.source, (node) => {
      if (callsTransaction) return;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === '$transaction'
      ) {
        callsTransaction = true;
      }
    });
    if (callsTransaction) {
      violations.push(
        `${fromRel} calls $transaction (transaction boundaries belong to services/use-cases; see ADR-006)`,
      );
    }
  }
  return violations;
});

// ARCH-ENF-003: PrismaClient is constructed in exactly one production place.
defineRule('ARCH-ENF-003', 'PrismaClient ownership', (ctx) => {
  const violations = [];
  for (const file of ctx.allSrcFiles) {
    const fromRel = relOf(file.abs);
    const allowed =
      fromRel === 'src/platform/database/prisma.ts' || file.abs.endsWith('.integration.test.ts');
    if (allowed) continue;
    let constructs = false;
    visit(file.source, (node) => {
      if (constructs) return;
      if (ts.isNewExpression(node)) {
        const target = node.expression;
        if (ts.isIdentifier(target) && target.text === 'PrismaClient') constructs = true;
        if (ts.isPropertyAccessExpression(target) && target.name.text === 'PrismaClient') {
          constructs = true;
        }
      }
    });
    if (constructs) {
      violations.push(
        `${fromRel} constructs PrismaClient (import the shared client from src/platform/database/prisma.ts instead)`,
      );
    }
  }
  return violations;
});

// ARCH-ENF-004: src/config is the sole production consumer of process.env.
defineRule('ARCH-ENF-004', 'process.env ownership', (ctx) => {
  const violations = [];
  for (const file of ctx.allSrcFiles) {
    const fromRel = relOf(file.abs);
    if (isUnder(fromRel, ['src', 'config'])) continue;
    if (file.abs.endsWith('.test.ts')) continue;
    let usesEnv = false;
    let useSite = '';
    visit(file.source, (node) => {
      if (usesEnv) return;
      const { line } = file.source.getLineAndCharacterOfPosition(node.getStart(file.source));
      const site = `${fromRel}:${line + 1}`;
      // process.env / process?.env
      if (ts.isPropertyAccessExpression(node)) {
        const target = node.expression;
        const isProcess =
          ts.isIdentifier(target) && target.text === 'process';
        if (isProcess && node.name.text === 'env') {
          usesEnv = true;
          useSite = site;
        }
      }
      // process['ANYTHING'] / process["ANYTHING"] — any element access on
      // process reads the environment.
      if (ts.isElementAccessExpression(node)) {
        const target = node.expression;
        if (ts.isIdentifier(target) && target.text === 'process') {
          usesEnv = true;
          useSite = site;
        }
      }
      // const { env } = process / const { env: alias } = process
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        node.initializer.text === 'process' &&
        ts.isObjectBindingPattern(node.name)
      ) {
        const bindsEnv = node.name.elements.some((element) => {
          if (!ts.isBindingElement(element)) return false;
          if (element.propertyName && ts.isIdentifier(element.propertyName)) {
            return element.propertyName.text === 'env';
          }
          return ts.isIdentifier(element.name) && element.name.text === 'env';
        });
        if (bindsEnv) {
          usesEnv = true;
          useSite = site;
        }
      }
    });
    if (usesEnv) {
      violations.push(`${useSite} reads process.env (use the validated config layer instead)`);
    }
  }
  return violations;
});

// ARCH-ENF-005: leaf/infrastructure layers must not depend on business modules.
defineRule('ARCH-ENF-005', 'Leaf-layer isolation', (ctx) => {
  const violations = [];
  const forbiddenPrefixes = [
    ['src', 'modules'],
    ['src', 'app'],
    ['src', 'platform'],
    ['src', 'plugins'],
  ];
  for (const file of ctx.allSrcFiles) {
    const fromRel = relOf(file.abs);
    const isTypesFile = isUnder(fromRel, ['src', 'types']);
    const isSharedFile = isUnder(fromRel, ['src', 'shared']);
    const isPlatformFile = isUnder(fromRel, ['src', 'platform']);
    if (!isTypesFile && !isSharedFile && !isPlatformFile) continue;
    for (const edge of file.edges) {
      if (edge.kind !== 'resolved') continue;
      const toRel = relOf(edge.abs);
      if (isTypesFile) {
        if (forbiddenPrefixes.some((prefix) => isUnder(toRel, prefix))) {
          violations.push(`${fromRel} -> ${toRel} (src/types must stay independent of business modules)`);
        }
      } else {
        // src/shared and src/platform must not reach into business modules.
        if (isUnder(toRel, ['src', 'modules'])) {
          violations.push(`${fromRel} -> ${toRel} (infrastructure layers must not depend on business modules)`);
        }
      }
    }
  }
  return violations;
});

// ARCH-ENF-006: legacy roots stay gone (filesystem + imports).
defineRule('ARCH-ENF-006', 'Legacy root prohibition', (ctx) => {
  const violations = [];
  const legacyDirs = ['src/common', 'src/db', 'src/cache', 'src/logging', 'src/docs'].map((dir) =>
    dir.split('/'),
  );
  for (const prefix of legacyDirs) {
    const abs = path.join(ROOT, ...prefix);
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = null;
    }
    if (stat) {
      violations.push(`${prefix.join('/')} exists (legacy root forbidden by AGENTS.md hard rule 5)`);
    }
  }
  for (const file of ctx.allSrcFiles) {
    const fromRel = relOf(file.abs);
    for (const edge of file.edges) {
      if (edge.kind !== 'resolved') continue;
      const toRel = relOf(edge.abs);
      if (legacyDirs.some((prefix) => isUnder(toRel, prefix))) {
        violations.push(`${fromRel} -> ${toRel} (import into a forbidden legacy root)`);
      }
    }
  }
  return violations;
});

// ARCH-ENF-007: zero production dependency cycles, with full paths.
defineRule('ARCH-ENF-007', 'Circular dependency prohibition', (ctx) => {
  const adjacency = new Map();
  for (const file of ctx.prodFiles) {
    const fromRel = relOf(file.abs);
    const targets = [];
    for (const edge of file.edges) {
      if (edge.kind !== 'resolved') continue;
      targets.push(relOf(edge.abs));
    }
    targets.sort();
    adjacency.set(fromRel, targets);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...adjacency.keys()].map((key) => [key, WHITE]));
  const stack = [];
  const cycles = [];
  function dfs(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adjacency.get(node) || []) {
      if (!adjacency.has(next)) continue;
      const nextColor = color.get(next);
      if (nextColor === GRAY) {
        const start = stack.indexOf(next);
        cycles.push([...stack.slice(start), next].join(' -> '));
      } else if (nextColor === WHITE) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }
  for (const node of [...adjacency.keys()].sort()) {
    if (color.get(node) === WHITE) dfs(node);
  }
  cycles.sort();
  return cycles.map((cycle) => `dependency cycle: ${cycle}`);
});

// ARCH-ENF-008: zero zero-byte files in the working tree.
defineRule('ARCH-ENF-008', 'Zero-byte file prohibition', (ctx) => {
  void ctx;
  const violations = [];
  walk(ROOT, (abs) => {
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      return;
    }
    if (stat.isFile() && stat.size === 0) {
      violations.push(`${relOf(abs)} is empty (placeholder files are forbidden)`);
    }
  });
  violations.sort();
  return violations;
});

// ARCH-ENF-009: zero .gitkeep files.
defineRule('ARCH-ENF-009', '.gitkeep prohibition', (ctx) => {
  void ctx;
  const violations = [];
  walk(ROOT, (abs) => {
    if (path.basename(abs) === '.gitkeep') {
      violations.push(`${relOf(abs)} (empty-directory placeholder files are prohibited)`);
    }
  });
  violations.sort();
  return violations;
});

// ARCH-ENF-010: deterministic speculative-scaffolding detection.
defineRule('ARCH-ENF-010', 'Speculative scaffolding detection', (ctx) => {
  const violations = [];
  for (const top of ['src', 'prisma', 'scripts']) {
    const absTop = path.join(ROOT, top);
    if (!fs.existsSync(absTop)) continue;
    const queue = [absTop];
    while (queue.length > 0) {
      const dir = queue.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        infraErrors.push(`cannot read directory ${relOf(dir)}`);
        continue;
      }
      if (entries.length === 0 && dir !== absTop) {
        violations.push(`${relOf(dir)}/ is an empty architecture directory`);
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
      }
    }
  }
  for (const file of ctx.checkedTsFiles) {
    if (file.source.statements.length === 0) {
      violations.push(`${relOf(file.abs)} contains no statements (comment-only placeholder)`);
    }
  }
  violations.sort();
  return violations;
});

// ARCH-ENF-011: integration tests must gate DB availability explicitly.
defineRule('ARCH-ENF-011', 'Integration DB gating', (ctx) => {
  const violations = [];
  for (const file of ctx.integrationTestFiles) {
    const fromRel = relOf(file.abs);
    let gated = false;
    visit(file.source, (node) => {
      if (gated) return;
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'beforeAll' &&
        node.arguments.length > 0
      ) {
        const hook = node.arguments[0];
        if (ts.isArrowFunction(hook) || ts.isFunctionExpression(hook)) {
          visit(hook.body, (inner) => {
            if (gated) return;
            if (
              ts.isCallExpression(inner) &&
              ts.isPropertyAccessExpression(inner.expression) &&
              inner.expression.name.text === 'skip'
            ) {
              gated = true;
            }
            if (ts.isThrowStatement(inner)) gated = true;
          });
        }
      }
    });
    if (!gated) {
      violations.push(
        `${fromRel} has no explicit DB gate in beforeAll (use ctx.skip() or throw so a missing database cannot silently pass)`,
      );
    }
  }
  return violations;
});

// ARCH-ENF-012: authorization policies stay decoupled from persistence,
// HTTP, and transactions. Policies decide on trusted inputs (AuthContext,
// identifiers, service contracts); they must not reach Prisma, repositories,
// or Fastify, and must never own a transaction boundary.
defineRule('ARCH-ENF-012', 'Policy boundary isolation', (ctx) => {
  const violations = [];
  for (const file of ctx.prodFiles) {
    const fromRel = relOf(file.abs);
    if (!isUnder(fromRel, ['src', 'modules', 'authorization', 'policies'])) continue;
    for (const edge of file.edges) {
      if (edge.kind !== 'resolved') continue;
      const toRel = relOf(edge.abs);
      if (
        isUnder(toRel, ['src', 'platform', 'database']) ||
        segmentsOf(toRel).includes('repositories')
      ) {
        violations.push(
          `${fromRel} -> ${toRel} (authorization policies must decide on trusted inputs, not reach persistence)`,
        );
      }
    }
    for (const specifier of rawImportSpecifiers(file.source)) {
      if (specifier === 'fastify' || specifier === '@prisma/client') {
        violations.push(
          `${fromRel} imports ${specifier} (authorization policies must not depend on HTTP or persistence clients)`,
        );
      }
    }
    let callsTransaction = false;
    visit(file.source, (node) => {
      if (callsTransaction) return;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === '$transaction'
      ) {
        callsTransaction = true;
      }
    });
    if (callsTransaction) {
      violations.push(
        `${fromRel} calls $transaction (policies evaluate decisions; services own transactions)`,
      );
    }
  }
  return violations;
});

// ARCH-ENF-013: route-layer files must not reach persistence. Routes declare
// authentication/authorization and delegate to services; importing a
// repository (own module's or another's) would bypass the service layer —
// and with it guards, policies, and transaction ownership. ARCH-ENF-001
// covers cross-module repository imports; this rule closes the remaining
// gap for route files regardless of which module owns the repository.
// Repositories are identified by the mandatory `.repository.ts` role suffix
// (engineering standards §3.2), not by directory layout, so both
// `repositories/` directories and module-root repository files match.
defineRule('ARCH-ENF-013', 'Route-layer persistence isolation', (ctx) => {
  const violations = [];
  for (const file of ctx.prodFiles) {
    const fromRel = relOf(file.abs);
    if (!segmentsOf(fromRel).includes('routes')) continue;
    for (const edge of file.edges) {
      if (edge.kind !== 'resolved') continue;
      const toRel = relOf(edge.abs);
      if (toRel.endsWith('.repository.ts')) {
        violations.push(
          `${fromRel} -> ${toRel} (routes must use service contracts, never repositories directly)`,
        );
      }
    }
  }
  return violations;
});

// ARCH-ENF-014: no console logging bypass in production sources. All
// output must flow through the centralized Pino pipeline (M5.6), where
// serializers and redaction apply. A direct console.* call would emit
// unredacted text outside that boundary. Test files are excluded by the
// prodFiles convention (they assert on output, not through it).
defineRule('ARCH-ENF-014', 'Console logging prohibition', (ctx) => {  const violations = [];
  for (const file of ctx.prodFiles) {
    const fromRel = relOf(file.abs);
    const sites = [];
    visit(file.source, (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'console'
      ) {
        const { line } = file.source.getLineAndCharacterOfPosition(node.getStart(file.source));
        sites.push(`${fromRel}:${line + 1}`);
      }
    });
    for (const site of sites.sort()) {
      violations.push(`${site} calls console.* (use the centralized Pino pipeline instead)`);
    }
  }
  return violations;
});

// ARCH-ENF-015: public error envelopes originate in exactly one module.
// The problem-details `type` URL (docs.oxyide.com/errors/...) may be
// constructed only inside src/shared/errors/error-mapper.ts (M6.2): routes,
// guards, plugins, and services throw errors — they never build response
// bodies. Test files are excluded by the prodFiles convention (they assert
// on expected bodies, never emit them).
defineRule('ARCH-ENF-015', 'Error envelope ownership', (ctx) => {
  const violations = [];
  for (const file of ctx.prodFiles) {
    const fromRel = relOf(file.abs);
    if (fromRel === 'src/shared/errors/error-mapper.ts') continue;
    visit(file.source, (node) => {
      if (!ts.isPropertyAssignment(node)) return;
      const name = node.name;
      const isTypeKey =
        (ts.isIdentifier(name) && name.text === 'type') ||
        (ts.isStringLiteral(name) && name.text === 'type');
      if (!isTypeKey) return;
      const init = node.initializer;
      let text = null;
      if (ts.isStringLiteralLike(init)) {
        text = init.text;
      } else if (ts.isTemplateExpression(init) || ts.isTaggedTemplateExpression(init)) {
        try {
          text = init.getText(file.source);
        } catch {
          text = null;
        }
      }
      if (typeof text === 'string' && text.includes('docs.oxyide.com/errors')) {
        const { line } = file.source.getLineAndCharacterOfPosition(node.getStart(file.source));
        violations.push(
          `${fromRel}:${line + 1} constructs a public error envelope (build errors via the centralized mapper instead)`,
        );
      }
    });
  }
  return violations;
});

// ARCH-ENF-016: email templates are pure functions of their data (M11.4).
// A template turns typed data into subject/text/html. The moment it can reach
// configuration, the environment, the clock, randomness, persistence, HTTP, a
// logger, or the SMTP transport, rendering stops being deterministic and
// testable, and message content starts depending on where it ran. Each of
// those is a separate failure mode a reviewer should not have to remember:
//   - config / process.env -> a template that renders differently per deployment
//   - Date / Math.random  -> output that cannot be asserted or diffed
//   - Prisma / repos       -> an email body coupled to the database schema
//   - Fastify              -> a template that needs a request, so it cannot run
//                             from a job, a CLI, or a test
//   - logger / console     -> message content (and a one-time URL) in a log
//   - platform/email       -> the template layer learning the transport
// Scoped to src/shared/email/templates only. Test files are excluded by the
// prodFiles convention (they assert on output; they do not produce it), and the
// adapters that CALL templates keep full access to config and the transport.
defineRule('ARCH-ENF-016', 'Email template purity', (ctx) => {
  const violations = [];
  const FORBIDDEN_SPECIFIERS = ['config', 'fastify', '@prisma/client', 'platform/', 'nodemailer'];
  const IMPURE_CALLS = [
    { pattern: /\bnew Date\s*\(/, reason: 'reads the clock (pass preformatted values as template data)' },
    { pattern: /\bDate\.now\s*\(/, reason: 'reads the clock (pass preformatted values as template data)' },
    { pattern: /\bMath\.random\s*\(/, reason: 'uses randomness (templates must be deterministic)' },
  ];
  for (const file of ctx.prodFiles) {
    const fromRel = relOf(file.abs);
    if (!isUnder(fromRel, ['src', 'shared', 'email', 'templates'])) continue;

    for (const specifier of rawImportSpecifiers(file.source)) {
      for (const forbidden of FORBIDDEN_SPECIFIERS) {
        if (specifier.includes(forbidden)) {
          violations.push(
            `${fromRel} -> ${specifier} (email templates must be pure functions of their data)`,
          );
        }
      }
      if (specifier.includes('modules')) {
        violations.push(
          `${fromRel} -> ${specifier} (email templates must not depend on business modules)`,
        );
      }
    }

    // Call-shape scan over the AST rather than raw text: prose that merely
    // mentions a clock must not fail the rule.
    visit(file.source, (node) => {
      if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
      let name = null;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        name = `${node.expression.expression.getText(file.source)}.${node.expression.name.text}`;
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        name = node.expression.text;
      }
      if (name === null) return;
      for (const { pattern, reason } of IMPURE_CALLS) {
        if (pattern.test(`new ${name}()`) || pattern.test(`${name}()`)) {
          const { line } = file.source.getLineAndCharacterOfPosition(node.getStart(file.source));
          violations.push(`${fromRel}:${line + 1} ${reason}`);
        }
      }
      if (name === 'console.log' || name === 'console.error' || name === 'console.warn') {
        const { line } = file.source.getLineAndCharacterOfPosition(node.getStart(file.source));
        violations.push(`${fromRel}:${line + 1} logs from a template (message content must never be logged)`);
      }
    });
  }
  return violations;
});

// ---------------------------------------------------------------------------
// Context construction (single traversal, cached parsing)
// ---------------------------------------------------------------------------

function buildContext() {
  const tsFiles = collectTsFiles();
  const allSrcFiles = [];
  for (const abs of tsFiles) {
    const source = parseFile(abs);
    if (!source) continue;
    const edges = [];
    for (const specifier of rawImportSpecifiers(source)) {
      const resolved = resolveSpecifier(abs, specifier);
      if (resolved.kind === 'resolved') {
        edges.push(resolved);
      } else if (resolved.kind === 'unresolvable') {
        infraErrors.push(
          `cannot resolve import ${JSON.stringify(specifier)} from ${relOf(abs)}: refusing to assume the graph is complete`,
        );
      }
    }
    allSrcFiles.push({ abs, source, edges });
  }
  const prodFiles = allSrcFiles.filter((file) => !file.abs.endsWith('.test.ts'));

  const integrationTestFiles = [];
  const checkedTsFiles = [...allSrcFiles];
  const extraDirs = ['scripts', 'prisma'].map((dir) => path.join(ROOT, dir)).filter((dir) => fs.existsSync(dir));
  for (const dir of extraDirs) {
    walk(dir, (abs) => {
      if (!abs.endsWith('.ts')) return;
      if (checkedTsFiles.some((file) => file.abs === abs)) return;
      const source = parseFile(abs);
      if (!source) return;
      checkedTsFiles.push({ abs, source, edges: [] });
    });
  }
  for (const file of checkedTsFiles) {
    if (file.abs.endsWith('.integration.test.ts')) integrationTestFiles.push(file);
  }
  return { allSrcFiles, prodFiles, checkedTsFiles, integrationTestFiles };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function main() {
  const ctx = buildContext();
  const lines = [];
  lines.push(`Architecture checks (root: ${ROOT})`);
  lines.push('----------------------------------------');
  let failed = false;
  for (const rule of rules) {
    let violations;
    try {
      violations = [...rule.run(ctx)].sort();
    } catch (error) {
      failClosed(`${rule.id} ${rule.name} threw: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      return;
    }
    if (violations.length === 0) {
      lines.push(`PASS ${rule.id} ${rule.name}`);
    } else {
      failed = true;
      lines.push(`FAIL ${rule.id} ${rule.name}`);
      for (const violation of violations) lines.push(`  - ${violation}`);
    }
  }
  if (infraErrors.length > 0) {
    const unique = [...new Set(infraErrors)].sort();
    failClosed(`incomplete analysis:\n  - ${unique.join('\n  - ')}`);
    return;
  }
  lines.push('----------------------------------------');
  lines.push(`Architecture verification: ${failed ? 'FAIL' : 'PASS'}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(failed ? 1 : 0);
}

main();
