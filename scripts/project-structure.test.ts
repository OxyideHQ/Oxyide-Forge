import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Project-structure contract (M12.4).
 *
 * Pins the structural facts a new-module developer relies on: the major
 * directories exist, the reference module still has the shape the guide
 * describes, and every route file is actually wired into the application.
 * Asserts existence and membership only — never file contents, formatting,
 * or prose — so refactoring inside a file cannot break this suite.
 *
 * Import matching uses import SPECIFIERS only (the M78-F04 rule: a substring
 * scan would flag identifiers that merely mention a path).
 */

const ROOT = new URL('../', import.meta.url);
const ROOT_PATH = new URL(ROOT).pathname.replace(/\/$/, '');
const APP_DIR = join(ROOT_PATH, 'src', 'app');
const MODULES_DIR = join(ROOT_PATH, 'src', 'modules');

function routeFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.routes\.ts$/.test(entry) && !entry.endsWith('.test.ts')) {
        found.push(path);
      }
    }
  };
  walk(MODULES_DIR);
  return found;
}

describe('project-structure contract', () => {
  it('major source directories exist', () => {
    const dirs = [
      'src/app',
      'src/modules',
      'src/shared',
      'src/platform',
      'src/plugins',
      'src/config',
      'src/types',
      'prisma/migrations',
      'scripts',
      'docs',
    ];

    for (const dir of dirs) {
      expect(existsSync(new URL(`${dir}/`, ROOT)), `missing directory: ${dir}`).toBe(true);
    }
  });

  it('the reference module keeps the shape the guide describes', () => {
    // development.md §8 names these exact files as the copy target. If the
    // module is ever restructured, the guide must change in the same commit —
    // this test fails until it does.
    const expected = [
      'src/modules/notes/routes/note.routes.ts',
      'src/modules/notes/notes.service.ts',
      'src/modules/notes/note.repository.ts',
      'src/modules/notes/note-response.ts',
      'src/modules/notes/note.types.ts',
    ];

    for (const file of expected) {
      expect(existsSync(new URL(file, ROOT)), `reference module lost ${file}`).toBe(true);
    }
  });

  it('every route file is registered in src/app/routes.ts', () => {
    // An unregistered route file never serves and silently rots. The OpenAPI
    // bidirectional tests would catch a *served* undocumented route; this
    // catches the opposite failure: a written-but-unwired module.
    const registration = readFileSync(new URL('src/app/routes.ts', ROOT), 'utf8');
    const imported = new Set<string>();
    for (const match of registration.matchAll(
      /^[ \t]*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm,
    )) {
      imported.add(match[1].replace(/\.js$/, ''));
    }

    // A route file at src/modules/notes/routes/note.routes.ts is imported
    // from src/app/ as ../modules/notes/routes/note.routes(.js).
    const unregistered = routeFiles()
      .map((abs) => relative(APP_DIR, abs).replace(/\.ts$/, ''))
      .filter((specifier) => !imported.has(specifier));

    expect(unregistered).toEqual([]);
  });

  it('tests stay colocated — no separate test root', () => {
    for (const dir of ['test/', 'tests/', '__tests__/', 'src/test/']) {
      expect(existsSync(new URL(dir, ROOT)), `unexpected test root: ${dir}`).toBe(false);
    }
  });
});
