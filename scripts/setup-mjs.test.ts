/**
 * Unit tests for the pure helpers in scripts/setup.mjs (M19.2).
 *
 * No subprocesses, no filesystem, no network: string in, value out.
 * Behavioral coverage (flags, .env safety, failure propagation) lives in
 * scripts/setup.test.ts, which executes the real entry points.
 */
import { describe, expect, it } from 'vitest';

import {
  databaseUrlFromEnvFile,
  meetsMinimumNode,
  parseArgs,
  parseDatabaseTarget,
} from './setup.mjs';

describe('parseArgs', () => {
  it('defaults to a full run on the loopback host and port 3000', () => {
    expect(parseArgs([])).toEqual({
      help: false,
      options: { checkOnly: false, skipMigrations: false, port: '3000', host: '127.0.0.1' },
    });
  });

  it('parses every supported flag', () => {
    const parsed = parseArgs(['--check', '--skip-migrations', '--port', '4000', '--host', '0.0.0.0']);
    expect(parsed.options).toMatchObject({
      checkOnly: true,
      skipMigrations: true,
      port: '4000',
      host: '0.0.0.0',
    });
  });

  it('rejects an unknown argument with a usage error', () => {
    let caught: unknown;
    try {
      parseArgs(['--nope']);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { code?: string }).code).toBe('SETUP_BAD_USAGE');
  });

  it('rejects a flag missing its value', () => {
    expect(() => parseArgs(['--port'])).toThrow('--port requires a value');
  });
});

describe('meetsMinimumNode', () => {
  it('accepts the floor and newer versions', () => {
    expect(meetsMinimumNode('v20.19.0')).toBe(true);
    expect(meetsMinimumNode('v20.19.2')).toBe(true);
    expect(meetsMinimumNode('v21.0.0')).toBe(true);
    expect(meetsMinimumNode('22.14.0')).toBe(true);
  });

  it('rejects anything below the floor and anything unparseable', () => {
    expect(meetsMinimumNode('v20.18.9')).toBe(false);
    expect(meetsMinimumNode('v18.20.0')).toBe(false);
    expect(meetsMinimumNode('not-a-version')).toBe(false);
    expect(meetsMinimumNode('')).toBe(false);
  });
});

describe('parseDatabaseTarget', () => {
  it('returns host, port, and database without userinfo or parameters', () => {
    const target = parseDatabaseTarget(
      'postgresql://forge:s3cret@db.internal:5433/oxyide_starter?sslmode=require',
    );
    expect(target).toEqual({ host: 'db.internal', port: '5433', database: 'oxyide_starter' });
  });

  it('defaults the port to 5432 when absent', () => {
    expect(parseDatabaseTarget('postgresql://u:p@localhost/db').port).toBe('5432');
  });

  it('rejects non-PostgreSQL schemes', () => {
    expect(() => parseDatabaseTarget('mysql://u:p@localhost/db')).toThrow('postgresql://');
  });

  it('rejects unparseable input', () => {
    expect(() => parseDatabaseTarget('not a url')).toThrow();
  });
});

describe('databaseUrlFromEnvFile', () => {
  it('finds DATABASE_URL among other entries', () => {
    const text = 'HOST=0.0.0.0\nDATABASE_URL=postgresql://u:p@127.0.0.1:5433/db\nJWT_SECRET=x\n';
    expect(databaseUrlFromEnvFile(text)).toBe('postgresql://u:p@127.0.0.1:5433/db');
  });

  it('returns empty when the variable is absent', () => {
    expect(databaseUrlFromEnvFile('JWT_SECRET=x\n')).toBe('');
  });

  it('ignores commented lines', () => {
    expect(databaseUrlFromEnvFile('# DATABASE_URL=postgresql://u:p@h/db\n')).toBe('');
  });
});
