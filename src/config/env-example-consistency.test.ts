import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { envSchema } from './env.schema.js';

/**
 * Schema ↔ .env.example consistency (M12.2).
 *
 * Three hand-maintained surfaces describe the same contract — the Zod schema
 * (authoritative), `.env.example` (human starting point), and the prose
 * tables in `docs/development.md` / `docs/deployment.md`. The schema and the
 * example file are machine-checked against each other here so they cannot
 * silently drift: a new schema variable without example coverage fails, and a
 * stale or invented variable in the example fails. The prose tables stay
 * human-maintained (wording changes must never break a test), with the
 * schema as the arbiter on any conflict.
 *
 * Parsing rules, deliberately narrow:
 *
 * - A line counts as "documenting" a variable when it starts with `NAME=` or
 *   `# Example: NAME=` (optional whitespace, optional leading `#`). Bare
 *   `# NAME=` comment-assignments (e.g. the disabled CORS line) count too.
 * - `DATABASE_URL` query-parameter examples (`?connection_limit=…`) are part
 *   of the URL value, not variables — the parser only reads the leading name.
 * - Tool-only inputs (`POSTGRES_PASSWORD` for compose, `*_TEST_URL` for
 *   opt-in test databases, script `--url` flags) are NOT application
 *   configuration and must NOT appear here; `POSTGRES_PASSWORD` in
 *   particular would teach developers to put a real credential next to app
 *   config. Its absence is asserted.
 */
function exampleVariables(): Set<string> {
  const source = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const names = new Set<string>();
  for (const line of source.split('\n')) {
    const match = /^\s*#?\s*(?:Example:\s*)?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

function schemaVariables(): Set<string> {
  // envSchema is a ZodEffects (object + superRefine), so the object shape
  // lives one level in — not on `.shape` directly.
  const inner = (envSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })
    ._def.schema;
  return new Set(Object.keys(inner.shape));
}

describe('configuration consistency: schema ↔ .env.example', () => {
  it('documents every schema variable in .env.example', () => {
    const missing = [...schemaVariables()].filter((name) => !exampleVariables().has(name));

    expect(missing, `schema variables missing from .env.example: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('contains no variable the schema does not define', () => {
    const stale = [...exampleVariables()].filter((name) => !schemaVariables().has(name));

    expect(
      stale,
      `stale or invented variables in .env.example (remove, or add to the schema first): ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps tool-only inputs out of the application example file', () => {
    const example = exampleVariables();

    // Compose-only credential and opt-in test-database URLs are documented
    // where they are used (docker-compose.yml, migration/backup docs), never
    // beside application configuration.
    for (const toolOnly of [
      'POSTGRES_PASSWORD',
      'POSTGRES_USER',
      'POSTGRES_DB',
      'BACKUP_DATABASE_URL',
      'OXYIDE_MIGRATION_TEST_URL',
      'SMTP_FROM',
    ]) {
      expect(example.has(toolOnly), `${toolOnly} must not appear in .env.example`).toBe(false);
    }
  });

  it('uses safe placeholders, never real secrets', () => {
    const source = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    // Comment lines are documentation, not configuration — scan only active
    // assignments (the M114-F01 rule: measure code, never prose).
    const active = source
      .split('\n')
      .filter((line) => !/^\s*#/.test(line) && line.trim() !== '');

    for (const line of active) {
      const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!match) continue;
      const [, name, value] = match;
      if (name === 'JWT_SECRET') {
        expect(value, 'JWT_SECRET placeholder must be obviously fake').toMatch(/replace-with/i);
      }
      if (name === 'DATABASE_URL') {
        expect(value, 'DATABASE_URL must use the test:test fixture').toContain('test:test@');
      }
      // No active assignment may even name a password: credentials live in
      // the deployment environment, never in a committed file. (The
      // DATABASE_URL fixture carries `test:test@`, which contains no such word.)
      expect(line, `${name} must not name a password`).not.toMatch(/password/i);
    }
    expect(active.length).toBeGreaterThan(0);
  });
});
