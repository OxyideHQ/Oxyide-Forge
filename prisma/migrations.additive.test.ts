/**
 * Migration additivity guard (M2.7 Expand / Contract Strategy).
 *
 * The committed migration history must stay additive-only so that fresh
 * deploys, repeat deploys, and status checks behave as documented in
 * docs/migrations.md. This test scans every committed `migration.sql` and
 * fails on any destructive or unclassified statement.
 *
 * A future contract-phase migration that intentionally removes or rewrites
 * schema (e.g. DROP COLUMN after the rollback window closed) is allowed ONLY
 * by adding its directory name to ACKNOWLEDGED_CONTRACT_MIGRATIONS below,
 * with its justification recorded alongside. That edit is itself the
 * contract gate: it forces the author to acknowledge the destructive step
 * instead of slipping it past review.
 *
 * Pure static analysis: no database, no Prisma client, deterministic.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// Migrations known to exist. History must only grow: removing a directory
// fails the inventory test below. New additive migrations pass without edits;
// only destructive contract work needs explicit acknowledgment above.
const KNOWN_MIGRATIONS = ['20260919145131_init', '20260919205337_add_role_to_user'];

// Contract-phase migrations whose destructive statements were explicitly
// reviewed and approved under the Expand / Contract Strategy gates.
// EMPTY: no contract migration exists yet. Do not add a name here without
// completing every contract gate in docs/migrations.md.
const ACKNOWLEDGED_CONTRACT_MIGRATIONS: string[] = [];

function listMigrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readMigrationSql(dir: string): string {
  const file = join(MIGRATIONS_DIR, dir, 'migration.sql');
  statSync(file);
  return readFileSync(file, 'utf8');
}

function stripComments(sql: string): string {
  // Drop only full-line `--` comments (the form Prisma generates). Inline
  // content is preserved untouched so comment handling can never hide a
  // destructive statement inside a string literal; at worst an inline comment
  // makes its statement unclassified, which fails loudly (safe direction).
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

function splitStatements(sql: string): string[] {
  return stripComments(sql)
    .split(';')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);
}

// Statements that never remove or rewrite existing schema or data.
function isAdditive(statement: string): boolean {
  const upper = statement.toUpperCase();
  return (
    upper.startsWith('CREATE TABLE ') ||
    upper.startsWith('CREATE UNIQUE INDEX ') ||
    upper.startsWith('CREATE INDEX ') ||
    /^ALTER TABLE \S+ ADD COLUMN /.test(upper) ||
    /^ALTER TABLE \S+ ADD CONSTRAINT /.test(upper)
  );
}

describe('migration history additivity (expand/contract strategy)', () => {
  it('contains the known migrations and history only grows', () => {
    const actual = listMigrationDirs();
    for (const known of KNOWN_MIGRATIONS) {
      expect(actual).toContain(known);
    }
  });

  it('every statement is additive unless its migration is an acknowledged contract', () => {
    const violations: string[] = [];
    for (const dir of listMigrationDirs()) {
      const acknowledged = ACKNOWLEDGED_CONTRACT_MIGRATIONS.includes(dir);
      for (const statement of splitStatements(readMigrationSql(dir))) {
        if (!isAdditive(statement) && !acknowledged) {
          violations.push(`${dir}: ${statement.slice(0, 80)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no contract migration exists yet', () => {
    expect(ACKNOWLEDGED_CONTRACT_MIGRATIONS).toEqual([]);
  });
});
