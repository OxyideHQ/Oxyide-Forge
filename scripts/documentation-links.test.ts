/**
 * Customer documentation link and leakage protection (M19.2, M19.2-R1).
 *
 * The checking logic lives in scripts/package-link-check.cjs so the SAME
 * implementation verifies the source checkout (here) and an extracted
 * customer ZIP (`node scripts/package-link-check.cjs --root <dir>`). This
 * suite pins the repository behavior plus the V1 package-membership
 * contract; the extracted-artifact run happens during release validation.
 *
 * Structural assertions only (existence, membership, patterns) — never prose.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, '..');

const { intendedFiles, shippedFiles } = require('./dist-file-set.cjs') as {
  intendedFiles: () => string[];
  shippedFiles: () => string[];
};
const { checkPackageLinks, relativeLinks } = require('./package-link-check.cjs') as {
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
  relativeLinks: (markdown: string) => string[];
};

const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('package link check over the source checkout', () => {
  it('reports zero findings across every shipped customer document', () => {
    const shipped = shippedFiles();
    expect(shipped.length, 'expected shipped files to check').toBeGreaterThan(0);
    const findings = checkPackageLinks(root, shipped);
    expect(findings.documents, 'expected shipped customer documents').toBeGreaterThan(0);
    expect(
      [...findings.brokenLinks, ...findings.brokenAnchors, ...findings.localLeaks, ...findings.internalLinks],
      'package link findings must be empty',
    ).toEqual([]);
  });

  it('fails closed on an unreadable document (negative control)', () => {
    const bad = checkPackageLinks(root, ['docs/does-not-exist-here.md']);
    expect(bad.brokenLinks.length).toBeGreaterThan(0);
    // Broken-link detection itself is proven by Case E fixtures in
    // scripts/customer-file-set.test.ts; this pins the fail-closed read path.
  });
});

describe('README targets are V1 package members (shipped-vs-intended honesty)', () => {  it('every README relative link target is in the intended set', () => {
    const intended = new Set(intendedFiles());
    const missing: string[] = [];
    for (const link of relativeLinks(read('README.md'))) {
      const target = link.split('#')[0];
      if (target === '') continue;
      if (!intended.has(target)) missing.push(target);
    }
    expect(
      missing,
      `README links outside the intended V1 package: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('the canonical installation guide is intended package content', () => {
    expect(intendedFiles()).toContain('docs/installation.md');
  });

  it('the cross-platform setup entry point is intended package content', () => {
    expect(intendedFiles()).toContain('scripts/setup.mjs');
  });

  it('every README relative link target ships (no ZIP-dead links)', () => {
    // M19.2-R1: intended-but-untracked files now ship via the allowlist, so
    // this asserts SHIPPED membership, not merely intended membership. The two
    // formerly dead references (AGENTS.md, CHANGELOG.md) were delinked at the
    // source with an explicit source-only note instead of being allowlisted.
    const shipped = new Set(shippedFiles());
    const missing: string[] = [];
    for (const link of relativeLinks(read('README.md'))) {
      const target = link.split('#')[0];
      if (target === '') continue;
      if (!shipped.has(target)) missing.push(target);
    }
    expect(missing, `README links missing from the shipped set: ${missing.join(', ')}`).toEqual(
      [],
    );
  });
});

describe('detectors prove themselves on hostile snippets (negative controls)', () => {
  it('flags developer-machine locations inside an isolated snippet', () => {
    const { LOCAL_PATTERNS, relativeLinks: rel } = require('./package-link-check.cjs') as {
      LOCAL_PATTERNS: string[];
      relativeLinks: (markdown: string) => string[];
    };
    const snippet = [
      'see file+.vscode-resource.vscode-cdn.net/x for a screenshot,',
      'or open vscode-webview://abc, or C:\\Users\\dev\\shot.png,',
      'or sandbox:/mnt/data/export.zip.',
    ].join('\n');
    expect(LOCAL_PATTERNS.filter((pattern) => snippet.includes(pattern)).length).toBeGreaterThan(
      0,
    );
    expect(rel('[x](docs/milestones/M19.2/notes.md)')).toEqual([
      'docs/milestones/M19.2/notes.md',
    ]);
  });
});
