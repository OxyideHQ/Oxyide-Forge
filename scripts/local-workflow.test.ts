import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { envSchema } from '../src/config/env.schema.js';

/**
 * Local-workflow contract (M12.6).
 *
 * The development guide promises a runnable local workflow: health probes a
 * developer can curl, a reference module a developer can open, and SMTP
 * variable names a developer can copy. This suite pins that those promises
 * resolve to real code — endpoint literals in the health route, real files
 * behind documented paths, real schema fields behind documented variable
 * names. Asserts existence and membership only, never prose or formatting.
 */

function healthRoute(): string {
  return readFileSync(new URL('../src/modules/health/health.route.ts', import.meta.url), 'utf8');
}

function guide(): string {
  return readFileSync(new URL('../docs/development.md', import.meta.url), 'utf8');
}

function schemaVariables(): Set<string> {
  const inner = (envSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })
    ._def.schema;
  return new Set(Object.keys(inner.shape));
}

describe('local-workflow contract', () => {
  it('the documented health endpoints exist in the health route', () => {
    const route = healthRoute();

    for (const path of ['/health/live', '/health/ready']) {
      expect(route, `health route must serve ${path}`).toContain(path);
      expect(guide(), `development guide must document ${path}`).toContain(path);
    }
  });

  it('the reference-module guide exists and names real module paths', () => {
    const reference = new URL('../docs/reference-module.md', import.meta.url);

    expect(existsSync(reference), 'docs/reference-module.md must exist').toBe(true);
    expect(guide()).toContain('docs/reference-module.md');

    const documented = readFileSync(reference, 'utf8');
    const paths = new Set<string>();
    for (const match of documented.matchAll(/`((?:src|prisma)\/[A-Za-z0-9_./-]+)`/g)) {
      paths.add(match[1].replace(/\/$/, ''));
    }
    expect(paths.size, 'reference guide must name real paths').toBeGreaterThan(0);
    const missing = [...paths].filter(
      (path) => !existsSync(new URL(`../${path}`, import.meta.url)),
    );
    expect(missing, `reference guide names missing paths: ${missing.join(', ')}`).toEqual([]);
  });

  it('every SMTP variable named in the guide exists in the schema', () => {
    const schema = schemaVariables();
    const named = new Set<string>();
    for (const match of guide().matchAll(/\b(SMTP_[A-Z]+)\b/g)) {
      named.add(match[1]);
    }

    expect(named.size, 'guide must name SMTP variables').toBeGreaterThan(0);
    // SMTP_FROM is documented as intentionally absent (sender derives from
    // APP_BASE_URL) — the one name allowed to appear without existing.
    // Asserting the absence here keeps the M12.2 "no second sender source"
    // decision pinned: adding SMTP_FROM later must update this test first.
    expect(named.has('SMTP_FROM'), 'guide must document the no-SMTP_FROM decision').toBe(true);
    expect(schema.has('SMTP_FROM'), 'schema must not define SMTP_FROM').toBe(false);
    named.delete('SMTP_FROM');
    const unknown = [...named].filter((name) => !schema.has(name));
    expect(unknown, `guide names unknown SMTP variables: ${unknown.join(', ')}`).toEqual([]);
  });
});
