/**
 * M19.1-R1 — release-gate configuration-loading regression tests.
 *
 * Root cause under test: the first M19.1 gate run reported M18.2-04 BLOCKED
 * ("DATABASE_URL not set") even though the authorized value was present in
 * the repository's gitignored `.env`, because neither the gate nor
 * `verify-deployment.cjs` loads `.env` (no dotenv dependency; production
 * deliberately reads the process environment only).
 *
 * These tests use isolated fixture directories and clearly-fake credential
 * material only. They never read the repository's real `.env`, never mutate
 * the real process environment beyond a saved-and-restored DATABASE_URL,
 * and assert that no secret value ever appears in evidence strings.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gate = require('./release-gate.cjs') as {
  decideGate: (results: Array<{ mandatory: boolean; result: string }>) => { decision: string; exitCode: number };
  loadDotEnvIfNeeded: (rootDir: string, env: Record<string, string | undefined>) => string;
  mapVerifierResult: (output: string | null | undefined, status?: number) => string;
  verifierCommandLabel: (verifyPath: string) => string;
  checkSecurityScan: () => {
    id: string;
    name: string;
    mandatory: boolean;
    result: string;
    evidence: string;
    command: string;
  };
};

const FAKE_PASSWORD = 'pw-fixture-NOT-A-SECRET-9f8e7d6c';
const FAKE_URL = `postgresql://fixture-user:${FAKE_PASSWORD}@db.invalid:5433/fixturedb`;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureRoot(dotEnvContent: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-env-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, '.env'), dotEnvContent);
  return dir;
}

describe('loadDotEnvIfNeeded', () => {
  it('populates DATABASE_URL from <root>/.env when the environment lacks it', () => {
    const root = fixtureRoot(`DATABASE_URL=${FAKE_URL}\n`);
    const env: Record<string, string | undefined> = {};
    const source = gate.loadDotEnvIfNeeded(root, env);
    expect(source).toBe('.env');
    expect(env.DATABASE_URL).toBe(FAKE_URL);
  });

  it('prefers the existing process environment and never overrides it', () => {
    const root = fixtureRoot(`DATABASE_URL=${FAKE_URL}\n`);
    const env: Record<string, string | undefined> = { DATABASE_URL: 'postgresql://kept:kept@localhost:5432/kept' };
    const source = gate.loadDotEnvIfNeeded(root, env);
    expect(source).toBe('environment');
    expect(env.DATABASE_URL).toBe('postgresql://kept:kept@localhost:5432/kept');
  });

  it('reports absent when no .env exists and nothing is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-noenv-'));
    tempDirs.push(dir);
    const env: Record<string, string | undefined> = {};
    expect(gate.loadDotEnvIfNeeded(dir, env)).toBe('absent');
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('resolves the fixture root deterministically (ignores caller cwd)', () => {
    const root = fixtureRoot(`DATABASE_URL=${FAKE_URL}\n`);
    const env: Record<string, string | undefined> = {};
    const source = gate.loadDotEnvIfNeeded(root, env);
    expect(source).toBe('.env');
    // The value came from the fixture file, not from any cwd-relative file.
    expect(env.DATABASE_URL).toBe(FAKE_URL);
  });

  it('parses quotes, comments, and export prefixes; skips malformed lines', () => {
    const root = fixtureRoot(
      '# a comment\n' +
        'NOT_AN_ASSIGNMENT\n' +
        'lowercase_key=ignored\n' +
        'export DATABASE_URL="quoted-value"\n' +
        'JWT_SECRET=abc # trailing note\n',
    );
    const env: Record<string, string | undefined> = {};
    // DATABASE_URL present (quoted) so source attribution is still correct.
    const source = gate.loadDotEnvIfNeeded(root, env);
    expect(env.DATABASE_URL).toBe('quoted-value');
    expect(env.JWT_SECRET).toBe('abc');
    expect(env.lowercase_key).toBeUndefined();
    expect(['environment', '.env']).toContain(source);
  });

  it('never exposes the loaded value through its return value', () => {
    const root = fixtureRoot(`DATABASE_URL=${FAKE_URL}\n`);
    const env: Record<string, string | undefined> = {};
    const source = gate.loadDotEnvIfNeeded(root, env);
    expect(source).not.toContain(FAKE_PASSWORD);
    expect(source).not.toContain('fixture-user');
  });
});

describe('mapVerifierResult', () => {
  it('maps PASS output to PASS', () => {
    expect(gate.mapVerifierResult('Deployment verification: PASS (47 checks passed, 0 failed)', 0)).toBe('PASS');
  });

  it('maps FAIL output to FAIL even when delivered via a thrown exec error', () => {
    // execFileSync throws on exit 1; the stdout it carries must still read FAIL.
    expect(gate.mapVerifierResult('Deployment verification: FAIL (40 checks passed, 7 failed)', 1)).toBe('FAIL');
  });

  it('maps INCOMPLETE output to BLOCKED, never to PASS', () => {
    expect(gate.mapVerifierResult('Deployment verification: INCOMPLETE (32 checks passed, 0 failed)', 2)).toBe('BLOCKED');
  });

  it('falls back to the exit code when output markers are missing', () => {
    expect(gate.mapVerifierResult('', 1)).toBe('FAIL');
    expect(gate.mapVerifierResult('', 2)).toBe('BLOCKED');
    expect(gate.mapVerifierResult(null, undefined)).toBe('BLOCKED');
  });
});

describe('secret-free evidence', () => {
  it('the verifier command label never embeds a secret value', () => {
    const label = gate.verifierCommandLabel('/repo/scripts/verify-deployment.cjs');
    expect(label).toContain('verify-deployment.cjs');
    expect(label).not.toContain(FAKE_URL);
    expect(label).not.toContain(FAKE_PASSWORD);
    expect(label).not.toContain('--database-url');
  });
});

describe('decideGate precedence', () => {  const pass = { mandatory: true, result: 'PASS' };
  it('all mandatory PASS produces GO with exit 0', () => {
    expect(gate.decideGate([pass, pass])).toEqual({ decision: 'GO', exitCode: 0 });
  });
  it('one mandatory FAIL produces NO-GO with exit 1', () => {
    expect(gate.decideGate([pass, { mandatory: true, result: 'FAIL' }])).toEqual({ decision: 'NO-GO', exitCode: 1 });
  });
  it('one mandatory BLOCKED with the rest passing produces BLOCKED with exit 2', () => {
    expect(gate.decideGate([pass, { mandatory: true, result: 'BLOCKED' }])).toEqual({ decision: 'BLOCKED', exitCode: 2 });
  });
  it('one mandatory NOT_RUN can never produce GO', () => {
    const { decision } = gate.decideGate([pass, { mandatory: true, result: 'NOT_RUN' }]);
    expect(decision).not.toBe('GO');
  });
  it('mandatory FAIL plus another BLOCKED produces NO-GO (failure takes precedence)', () => {
    expect(
      gate.decideGate([pass, { mandatory: true, result: 'FAIL' }, { mandatory: true, result: 'BLOCKED' }]),
    ).toEqual({ decision: 'NO-GO', exitCode: 1 });
  });
  it('optional failures never override a mandatory GO', () => {
    expect(gate.decideGate([pass, { mandatory: false, result: 'FAIL' }])).toEqual({ decision: 'GO', exitCode: 0 });
  });
});

describe('checkSecurityScan deploy-example handling (M19.2-R1)', () => {
  it('passes with comment-only secret patterns in fly.toml/render.yaml', () => {
    // The deployment examples contain platform secret commands inside
    // comments (fly secrets set ...), never committed values. The gate scan
    // skips them; committed-secret protection there belongs to gitleaks.
    const result = gate.checkSecurityScan();
    expect(result.id).toBe('M15.2-01');
    expect(result.result).toBe('PASS');
  });

  it('never embeds a secret value in its evidence or command', () => {
    const result = gate.checkSecurityScan();
    expect(result.evidence).not.toContain(FAKE_PASSWORD);
    expect(result.command).not.toContain(FAKE_PASSWORD);
    expect(result.command).not.toContain('--database-url');
  });
});
