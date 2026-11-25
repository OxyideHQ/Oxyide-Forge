import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Developer-command contract (M12.3).
 *
 * Every documented developer workflow must correspond to a real executable
 * repository command. This suite pins that correspondence without parsing
 * prose: it asserts set membership (a command is named / it exists), never
 * formatting. Wording, order, and examples may change freely; the command
 * inventory may change only deliberately, in which case this file is updated
 * in the same change.
 *
 * What is intentionally NOT asserted: script bodies (implementation detail),
 * output text, timing, or anything requiring a database, Docker, or network.
 */

// Canonical commands a developer is told to run. Each must exist in
// package.json scripts. npm builtins (`test`, `start`) map to same-named
// scripts; everything else is invoked as `npm run <name>`.
const CANONICAL_COMMANDS = [
  'dev',
  'test',
  'test:watch',
  'typecheck',
  'lint',
  'build',
  'architecture:check',
  'check',
  'validate',
  'security:dependencies',
  'security:secrets',
  'security:sast',
  'security:sbom',
  'security:all',
  'release:check',
  'verify:deployment',
  'db:seed',
  'format',
] as const;

// Names that must never appear in developer docs: scripts that never existed
// or were removed. Their presence would send a developer to a dead end.
const STALE_COMMANDS = ['prisma:seed', 'db:migrate', 'db:generate', 'test:run', 'tests:watch'];

function packageScripts(): Record<string, string> {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts?: Record<string, string> };
  return manifest.scripts ?? {};
}

function developerDocs(): string {
  return (
    readFileSync(new URL('../README.md', import.meta.url), 'utf8') +
    '\n' +
    readFileSync(new URL('../docs/development.md', import.meta.url), 'utf8')
  );
}

describe('developer-command contract', () => {
  it('every canonical command exists in package.json', () => {
    const scripts = packageScripts();
    const missing = CANONICAL_COMMANDS.filter((name) => !(name in scripts));

    expect(missing, `documented commands missing from package.json: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('the fast composite runs exactly the documented pre-commit trio, in order', () => {
    const check = packageScripts()['check'] ?? '';

    // Structural, not string-equal: extra flags would still satisfy this, but
    // dropping or reordering a gate would not.
    for (const gate of ['typecheck', 'lint', 'architecture:check']) {
      expect(check, '`check` must invoke ' + gate).toContain(gate);
    }
    const order = ['typecheck', 'lint', 'architecture:check'].map((gate) => check.indexOf(gate));
    expect(order, '`check` must run typecheck, then lint, then architecture:check').toEqual(
      [...order].sort((a, b) => a - b),
    );
    // Failures must propagate: only `&&` chaining. A `;` separator would run
    // the next gate after a failure; `||` would swallow failures entirely.
    expect(check, '`check` must not use `;` separators').not.toContain(';');
    expect(check, '`check` must not swallow failures with `||`').not.toContain('||');
  });

  it('the full composite reuses existing gates instead of duplicating them', () => {
    const validate = packageScripts()['validate'] ?? '';

    for (const gate of [
      'security:all',
      'migrate status',
      'security:sbom',
      'release:check',
      'verify:deployment',
    ]) {
      expect(validate, '`validate` must invoke ' + gate).toContain(gate);
    }
    // verify:deployment needs everything else built and checked first.
    expect(validate.indexOf('verify:deployment')).toBeGreaterThan(
      validate.indexOf('security:all'),
    );
  });

  it('no stale command name survives in developer docs', () => {
    const docs = developerDocs();
    const survivors = STALE_COMMANDS.filter((name) => docs.includes(name));

    expect(
      survivors,
      `stale command references in README/development guide: ${survivors.join(', ')}`,
    ).toEqual([]);
  });

  it('every `npm run X` named in developer docs exists in package.json', () => {
    const docs = developerDocs();
    const scripts = packageScripts();
    const referenced = new Set<string>();
    for (const match of docs.matchAll(/npm run ([\w:.-]+)/g)) {
      referenced.add(match[1]);
    }
    // npm builtins used bare in docs (`npm test`, `npm start`) resolve to
    // same-named scripts; cover both invocation forms.
    for (const match of docs.matchAll(/npm (test|start)\b(?!:)/g)) {
      referenced.add(match[1]);
    }
    const unknown = [...referenced].filter((name) => !(name in scripts));

    expect(
      unknown,
      `docs reference commands missing from package.json: ${unknown.join(', ')}`,
    ).toEqual([]);
  });

  it('documents the release composite it actually runs', () => {
    // `security:all` runs far more than "security" suggests (typecheck, lint,
    // full tests, build, architecture). The composition must stay documented
    // in the development guide so the name cannot mislead.
    const guide = readFileSync(new URL('../docs/development.md', import.meta.url), 'utf8');

    for (const gate of ['typecheck', 'lint', 'architecture:check']) {
      expect(guide, `development guide must document that security:all includes ${gate}`).toContain(
        gate,
      );
    }
    expect(guide).toContain('security:all');
  });
});
