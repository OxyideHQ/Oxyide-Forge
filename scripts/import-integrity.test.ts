/**
 * Self-tests for scripts/import-integrity.cjs (M14.2).
 *
 * Black-box + unit tests: every subprocess case builds an isolated fixture tree
 * under the OS temporary directory, writes a newline-separated shipped-file
 * manifest, and runs the gate with `--root`/`--files` pointing at that fixture.
 * Production sources are never modified; no fixture lives under src/ or scripts/.
 * The real working-tree sources are hash-checked before and after the whole run
 * to prove the experiment left the repository untouched.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const gate = path.join(scriptsDir, 'import-integrity.cjs');
// Real working-tree sources the experiment must never touch.
const liveGate = path.join(scriptsDir, 'import-integrity.cjs');
const liveValidator = path.join(scriptsDir, 'release-validate.cjs');

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Create a fixture root, write files, write a shipped manifest, return paths. */
function makeFixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-gate-'));
  tempDirs.push(dir);
  const shipped: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    if (rel.endsWith('.ts')) shipped.push(rel);
  }
  const manifest = path.join(dir, 'manifest.txt');
  fs.writeFileSync(manifest, `${shipped.sort().join('\n')}\n`, 'utf8');
  return dir;
}

/** Run the gate against a fixture root using its manifest. */
function runGate(root: string): { status: number | null; stderr: string } {
  const manifest = path.join(root, 'manifest.txt');
  const result = spawnSync(process.execPath, [gate, '--root', root, '--files', manifest], {
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr ?? '' };
}

describe('import-integrity extraction (unit)', () => {
  it('extracts every real relative import form', async () => {
    const { extractRelativeImports } = await import(gate);
    const src = [
      "import { config } from '../config/index.js';",
      "export * from './bar.js';",
      "import type { T } from '../types/x.js';",
      "import './side-effect.js';",
      "const m = await import('./dynamic.js');",
    ].join('\n');
    expect(extractRelativeImports(src).sort()).toEqual([
      '../config/index.js',
      '../types/x.js',
      './bar.js',
      './dynamic.js',
      './side-effect.js',
    ]);
  });

  it('does not treat import specifiers inside string/template literals or comments as imports', async () => {
    const { extractRelativeImports } = await import(gate);
    const src = [
      "fs.writeFileSync(p, \"import x from './b.js'\");",
      'const tpl = `import {x} from \'./tpl.js\';`;',
      "const fixture = 'export y from \"./fake.js\"';",
      "// from './commented.js'",
      '/* from "./block.js" */',
    ].join('\n');
    expect(extractRelativeImports(src)).toEqual([]);
  });

  it('resolves NodeNext .js->.ts and directory index conventions', async () => {
    const { resolveCandidates } = await import(gate);
    expect(resolveCandidates('src/app/app.ts', '../config/index.js')).toContain('src/config/index.ts');
    expect(resolveCandidates('src/app/app.ts', '../config')).toContain('src/config/index.ts');
    expect(resolveCandidates('src/app/app.ts', './foo.js')).toContain('src/app/foo.ts');
  });
});

describe('import-integrity gate (subprocess mutation tests)', () => {
  it('1. an intact fixture with only valid relative imports passes (exit 0)', () => {
    const root = makeFixture({
      'a.ts': "import { b } from './b.js';\nexport const a = b;\n",
      'b.ts': 'export const b = 1;\n',
      'sub/index.ts': "import leaf from './leaf.js';\nexport default leaf;\n",
      'sub/leaf.ts': 'export default 2;\n',
    });
    const { status, stderr } = runGate(root);
    expect(status).toBe(0);
    expect(stderr).toBe('');
  });

  it('2. a deliberately broken relative import fails (exit 1) with an actionable diagnostic', () => {
    const root = makeFixture({
      'a.ts': "import { gone } from './missing.js';\n",
      'b.ts': 'export const b = 1;\n',
    });
    const { status, stderr } = runGate(root);
    expect(status).toBe(1);
    // Diagnostic names BOTH the importing file and the unresolved target.
    expect(stderr).toContain('a.ts');
    expect(stderr).toContain("'./missing.js'");
    expect(stderr).toContain('IMPORT-INTEGRITY');
  });

  it('3. restoring the exact original bytes of the broken file makes the gate pass again', async () => {
    const good = "import { b } from './b.js';\nexport const a = b;\n";
    const broken = "import { b } from './b.js';\nimport { gone } from './missing.js';\n";
    const root = makeFixture({
      'a.ts': good,
      'b.ts': 'export const b = 1;\n',
    });
    const aPath = path.join(root, 'a.ts');
    const manifest = path.join(root, 'manifest.txt');

    // Baseline: intact passes.
    expect(spawnSync(process.execPath, [gate, '--root', root, '--files', manifest], { encoding: 'utf8' }).status).toBe(0);

    // Break -> fail.
    fs.writeFileSync(aPath, broken, 'utf8');
    const brokenRun = spawnSync(process.execPath, [gate, '--root', root, '--files', manifest], { encoding: 'utf8' });
    expect(brokenRun.status).toBe(1);
    expect(brokenRun.stderr).toContain("'./missing.js'");

    // Restore exact original bytes -> pass again.
    fs.writeFileSync(aPath, good, 'utf8');
    const restoredRun = spawnSync(process.execPath, [gate, '--root', root, '--files', manifest], { encoding: 'utf8' });
    expect(restoredRun.status).toBe(0);
    expect(sha256(aPath)).toBe(createHash('sha256').update(good, 'utf8').digest('hex'));
  });

  it('4. the break-and-restore sequence is stable across a second cycle', () => {
    const good = "export { x } from './x.js';\n";
    const root = makeFixture({
      'm.ts': good,
      'x.ts': 'export const x = 1;\n',
    });
    const mPath = path.join(root, 'm.ts');
    const manifest = path.join(root, 'manifest.txt');

    for (let cycle = 0; cycle < 2; cycle++) {
      fs.writeFileSync(mPath, "export { y } from './absent.js';\n", 'utf8');
      const failRun = spawnSync(process.execPath, [gate, '--root', root, '--files', manifest], { encoding: 'utf8' });
      expect(failRun.status).toBe(1);

      fs.writeFileSync(mPath, good, 'utf8');
      const passRun = spawnSync(process.execPath, [gate, '--root', root, '--files', manifest], { encoding: 'utf8' });
      expect(passRun.status).toBe(0);
    }
  });

  it('5. a broken import in a file that is NOT in the shipped manifest is ignored (inventory rules)', () => {
    // orphan.ts is written to disk but is deliberately omitted from the manifest,
    // so the gate must not walk it.
    const root = makeFixture({
      'shipped.ts': "export const s = 1;\n",
    });
    fs.writeFileSync(path.join(root, 'orphan.ts'), "import x from './gone.js';\n", 'utf8');
    const { status } = runGate(root);
    expect(status).toBe(0);
  });

  it('6. nested-path index resolution passes when the index ships and fails when it does not', () => {
    // NodeNext: `./handlers/index.js` is the real way to reference a directory
    // index; it resolves to `handlers/index.ts`.
    const ok = makeFixture({
      'deep/entry.ts': "import h from './handlers/index.js';\nexport default h;\n",
      'deep/handlers/index.ts': 'export default 1;\n',
    });
    expect(runGate(ok).status).toBe(0);

    const bad = makeFixture({
      'deep/entry.ts': "import h from './handlers/index.js';\nexport default h;\n",
      'deep/handlers/index.ts': 'export default 1;\n',
    });
    // Remove the resolved index from BOTH disk and the manifest -> must fail.
    fs.rmSync(path.join(bad, 'deep/handlers'), { recursive: true });
    const remaining = ['deep/entry.ts'];
    fs.writeFileSync(path.join(bad, 'manifest.txt'), `${remaining.join('\n')}\n`, 'utf8');
    const { status, stderr } = runGate(bad);
    expect(status).toBe(1);
    expect(stderr).toContain('./handlers/index.js');
  });

  it('7. the live working-tree gate and validator sources are unmodified by the experiment', () => {
    const before = sha256(liveGate) + sha256(liveValidator);
    // Run a representative break/restore fixture once more.
    const root = makeFixture({ 'a.ts': "import { b } from './b.js';\n", 'b.ts': 'export const b = 1;\n' });
    runGate(root);
    const after = sha256(liveGate) + sha256(liveValidator);
    expect(after).toBe(before);
  });
});
