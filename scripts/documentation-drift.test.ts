import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { envSchema } from '../src/config/env.schema.js';

const require = createRequire(import.meta.url);
const { shippedFiles } = require('../scripts/dist-file-set.cjs') as { shippedFiles: () => string[] };

/**
 * Documentation drift protection (M12.8).
 *
 * The starter documentation promises a runnable onboarding: real files behind
 * documented paths, real commands behind documented invocations, and a real
 * schema behind documented variables. This suite pins that those promises
 * resolve to the actual repository — existence and membership only, never
 * prose or formatting. It is the lightweight regression guard required by the
 * M12.8 milestone: canonical docs exist, links are valid, commands exist, and
 * stale references are absent.
 */

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

function schemaVariables(): Set<string> {
  const inner = (envSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })
    ._def.schema;
  return new Set(Object.keys(inner.shape));
}

describe('canonical documentation files exist', () => {
  const canonical = [
    'docs/development.md',
    'docs/architecture.md',
    'docs/engineering-standards.md',
    'docs/deployment.md',
    'docs/reference-module.md',
    'docs/api-conventions.md',
    'docs/auth.md',
    'docs/authorization.md',
    'docs/migrations.md',
    'docs/error-handling.md',
    'docs/production-logging.md',
    'docs/transport-security.md',
    'docs/release-contract.md',
    'docs/backup-recovery.md',
    'docs/rollback-recovery.md',
    'README.md',
    '.env.example',
  ];

  it('every canonical documentation file is present', () => {
    const missing = canonical.filter(
      (path) => !existsSync(new URL(`../${path}`, import.meta.url)),
    );
    expect(missing, `missing canonical docs: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('README links point to existing files', () => {
  it('every relative markdown link in README resolves', () => {
    const readme = read('../README.md');
    const links = new Set<string>();
    for (const match of readme.matchAll(/\[.*?\]\((.*?)\)/g)) {
      const link = match[1];
      if (link.startsWith('http') || link.startsWith('#')) continue;
      links.add(link);
    }
    expect(links.size, 'README must contain links').toBeGreaterThan(0);
    const missing = [...links].filter(
      (link) => !existsSync(new URL(`../${link}`, import.meta.url)),
    );
    expect(missing, `README links missing files: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('documented commands exist', () => {
  it('every npm script named in the development guide exists in package.json', () => {
    const pkg = JSON.parse(read('../package.json')) as { scripts: Record<string, string> };
    const guide = read('../docs/development.md');
    const named = new Set<string>();
    for (const match of guide.matchAll(/`npm run ([a-z:]+)`/g)) {
      named.add(match[1]);
    }
    expect(named.size, 'guide must name npm scripts').toBeGreaterThan(0);
    const unknown = [...named].filter((name) => !(name in pkg.scripts));
    expect(unknown, `guide names unknown scripts: ${unknown.join(', ')}`).toEqual([]);
  });

  it('the canonical M12.3 commands are documented and exist', () => {
    const pkg = JSON.parse(read('../package.json')) as { scripts: Record<string, string> };
    const guide = read('../docs/development.md');
    for (const cmd of ['check', 'validate', 'test', 'typecheck', 'lint', 'build']) {
      expect(pkg.scripts, `package.json must define ${cmd}`).toHaveProperty(cmd);
      expect(guide, `guide must document ${cmd}`).toContain(cmd);
    }
  });
});

describe('reference module path exists', () => {
  it('the documented reference module path is real', () => {
    expect(
      existsSync(new URL('../src/modules/notes/', import.meta.url)),
      'src/modules/notes/ must exist',
    ).toBe(true);
    const guide = read('../docs/development.md');
    expect(guide).toContain('src/modules/notes');
  });
});

describe('.env.example remains synchronized', () => {
  it('every schema variable has an entry in .env.example', () => {
    const schema = schemaVariables();
    const example = read('../.env.example');
    const present = new Set<string>();
    for (const match of example.matchAll(/(?:^|\n)(?:#\s*Example:\s*)?([A-Z_]+)=/g)) {
      present.add(match[1]);
    }
    const missing = [...schema].filter((name) => !present.has(name));
    expect(missing, `.env.example missing schema variables: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('health endpoints referenced by docs exist', () => {
  it('the documented health endpoints exist in the health route', () => {
    const route = read('../src/modules/health/health.route.ts');
    const guide = read('../docs/development.md');
    for (const path of ['/health/live', '/health/ready']) {
      expect(route, `health route must serve ${path}`).toContain(path);
      expect(guide, `guide must document ${path}`).toContain(path);
    }
  });
});

describe('stale references are absent', () => {
  it('no stale prisma:seed in live docs', () => {
    const live = [
      read('../README.md'),
      read('../docs/development.md'),
      read('../docs/architecture.md'),
      read('../docs/deployment.md'),
      read('../docs/engineering-standards.md'),
    ].join('\n');
    expect(live).not.toContain('prisma:seed');
  });

  it('no stale db:migrate shortcut in live docs', () => {
    const live = [
      read('../README.md'),
      read('../docs/development.md'),
      read('../docs/architecture.md'),
      read('../docs/deployment.md'),
    ].join('\n');
    expect(live).not.toContain('db:migrate');
    expect(live).not.toContain('db:reset');
    expect(live).not.toContain('db:push');
  });

  it('no SMTP_FROM documentation (sender derives from APP_BASE_URL)', () => {
    const schema = schemaVariables();
    expect(schema.has('SMTP_FROM'), 'schema must not define SMTP_FROM').toBe(false);
    const guide = read('../docs/development.md');
    // SMTP_FROM is documented as intentionally absent — the one name allowed
    // to appear without existing. Asserting the absence keeps the M12.2
    // "no second sender source" decision pinned.
    expect(guide).toContain('SMTP_FROM');
  });
});

/**
 * Internal-milestone-identifier hygiene (M13.10).
 *
 * Customer-facing documentation must never expose internal milestone
 * identifiers (for example `M13.10`, `M131-F05`, `M137-N01`). These are
 * engineering-only coordinates that mean nothing to a buyer and can narrate
 * pre-release internal state. The detector is proven with a disposable fixture
 * so the positive check cannot pass merely because the pattern never matches.
 */
describe('customer documentation carries no internal milestone identifiers', () => {
  // A milestone identifier is `M` + digits, an optional `.N` sub-number, and an
  // optional `-LETTERS-digits` finding suffix (M13.10, M14.1, M131-F05, M137-N01).
  const MILESTONE_ID = /\bM[0-9]+(\.[0-9]+)?(-[A-Z]+[0-9]+)?/g;

  it('no internal milestone identifier appears in any shipped customer document', () => {
    const shippedDocs = shippedFiles().filter((f) => /\.(md|txt)$/.test(f));
    expect(shippedDocs.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const doc of shippedDocs) {
      const hits = read(`../${doc}`).match(MILESTONE_ID);
      if (hits) offenders.push(`${doc}: ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders, `internal milestone IDs must not ship:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('flags an internal-milestone identifier inside an isolated fixture (negative control)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-hygiene-'));
    try {
      const fixture = join(dir, 'leaky-doc.md');
      writeFileSync(fixture, 'Resolved in M131-F05; verified through M13.10 and M137-N01.\n', 'utf8');
      const hits = readFileSync(fixture, 'utf8').match(MILESTONE_ID);
      expect(hits).toEqual(['M131-F05', 'M13.10', 'M137-N01']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
