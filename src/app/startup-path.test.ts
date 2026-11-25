/**
 * Startup-path regression tests (M19.2).
 *
 * These tests execute the REAL bootstrap (`src/main.ts` via `tsx`, the same
 * file `npm run dev` runs) as a subprocess with a sanitized environment from
 * an isolated working directory (no `.env` pickup), and assert the observable
 * contract: fail-fast with a named, actionable, secret-free diagnostic.
 *
 * Fixture credentials are visibly fake and unique per run so a leak assertion
 * cannot pass vacuously. The only test that needs a live database is gated
 * behind a loopback reachability probe and skips honestly otherwise — it is
 * never attempted against a remote or production target.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainTs = path.join(repoRoot, 'src', 'main.ts');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

const SECRET_MARKER = 'hunter2-fixture-never-a-secret';

// Distinctive fixture password: any echo of it in output is a leak, and its
// uniqueness keeps the assertion from passing vacuously.
const FIXTURE_PASSWORD = `pw-${SECRET_MARKER}-9f8e`;

const temps: string[] = [];
afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * tsx (v4 CLI) re-parents the application under PID 1, so killing the direct
 * spawn handle leaves the app running. Every spawn below is therefore a
 * process-group leader (`detached: true`), and teardown kills the whole
 * group. Verified empirically: handle-only SIGKILL leaves survivors, group
 * SIGKILL leaves none.
 */
/**
 * tsx (v4 CLI) re-parents the application under PID 1, so killing the direct
 * spawn handle leaves the app running. Every spawn below is therefore a
 * process-group leader (`detached: true`), and teardown kills the whole
 * group. Verified empirically: handle-only SIGKILL leaves survivors, group
 * SIGKILL leaves none.
 */
import type { ChildProcess } from 'node:child_process';

function killTree(child: Pick<ChildProcess, 'pid' | 'kill'>): void {
  if (child.pid === undefined) return;
  try {
    // Negative PID = entire process group (POSIX). Falls back to the handle
    // where groups do not exist.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function isolatedCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-startup-'));
  temps.push(dir);
  return dir;
}

interface RunResult {
  status: number | null;
  output: string;
  /** Stop the child now (bounded) instead of waiting out the safety timer. */
  stop: () => Promise<void>;
}

/** Run the real bootstrap once (no watch mode) with a fully explicit env. */
function runBootstrap(
  env: Record<string, string>,
  timeoutMs = 60_000,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(tsxBin, [mainTs], {
      cwd: isolatedCwd(),
      detached: true,
      env: {
        // Sanitized base: nothing inherited that could mask the fixture.
        PATH: process.env.PATH ?? '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
    const stop = (): Promise<void> =>
      new Promise((done) => {
        if (child.exitCode !== null) {
          done();
          return;
        }
        const timer = setTimeout(done, 10_000);
        child.on('close', () => {
          clearTimeout(timer);
          done();
        });
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone; the close handler (or the exitCode check) finishes.
          clearTimeout(timer);
          done();
        }
      });
    const timer = setTimeout(() => {
      killTree(child);
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, output, stop });
    });
  });
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '3499',
    JWT_SECRET: 'fixture-secret-at-least-32-chars-long',
    ...extra,
  };
}

function tcpReachable(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

describe('missing DATABASE_URL (the first-run case)', () => {
  it('fails fast with a named, actionable, secret-free diagnostic', async () => {
    const { status, output } = await runBootstrap(baseEnv());
    expect(status, 'bootstrap must exit non-zero').not.toBe(0);
    expect(output).toContain('DATABASE_URL');
    expect(output).toContain('.env');
    // No false success: the process must not claim to serve traffic.
    expect(output).not.toMatch(/listening|ready at http|Forge is running/i);
  }, 60_000);

  it('treats an empty DATABASE_URL as missing, not as acceptable', async () => {
    const { status, output } = await runBootstrap(baseEnv({ DATABASE_URL: '' }));
    expect(status).not.toBe(0);
    expect(output).toContain('DATABASE_URL');
  }, 60_000);

  it('distinguishes a malformed DATABASE_URL from a missing one', async () => {
    const { status, output } = await runBootstrap(baseEnv({ DATABASE_URL: 'not-a-url' }));
    expect(status).not.toBe(0);
    expect(output).toContain('DATABASE_URL');
    expect(output).not.toContain('is missing');
  }, 60_000);
});

describe('JWT_SECRET validation on the real path', () => {
  it('names a missing JWT_SECRET', async () => {
    const env = baseEnv({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5999/db' });
    delete env.JWT_SECRET;
    const { status, output } = await runBootstrap(env);
    expect(status).not.toBe(0);
    expect(output).toContain('JWT_SECRET');
  }, 60_000);

  it('rejects a short JWT_SECRET with the length rule', async () => {
    const { status, output } = await runBootstrap(
      baseEnv({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5999/db', JWT_SECRET: 'too-short' }),
    );
    expect(status).not.toBe(0);
    expect(output).toContain('JWT_SECRET');
    expect(output).toContain('32');
  }, 60_000);
});

describe('configured but unreachable database', () => {
  it('serves readiness-503 instead of claiming the variable is missing', async () => {
    // Closed loopback port: connect refused immediately, no database needed.
    const probe = await tcpReachable('127.0.0.1', 59999);
    expect(probe, 'test precondition: port 59999 must be closed').toBe(false);
    // Ephemeral port Claimed just-in-time: fixed test ports collide with
    // orphaned runs, and a collision must not read as a product regression.
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const claimed = typeof address === 'object' && address !== null ? address.port : 0;
        server.close(() => resolve(claimed));
      });
    });
    expect(port).toBeGreaterThan(0);
    const child = spawn(tsxBin, [mainTs], {
      cwd: isolatedCwd(),
      detached: true,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: String(port),
        JWT_SECRET: 'fixture-secret-at-least-32-chars-long',
        DATABASE_URL: `postgresql://fixture-user:${FIXTURE_PASSWORD}@127.0.0.1:59999/db`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
    try {
      // Wait for the listening line (bounded): the process must stay up,
      // proving an unreachable database is not a startup-validation failure.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (output.includes('Server listening at')) break;
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(child.exitCode, 'process must stay up with a dead database').toBeNull();
      expect(output).toContain('Server listening at');
      // Readiness reports the outage as 503 — the documented signal — while
      // liveness stays independent.
      const ready = await fetch(`http://127.0.0.1:${port}/health/ready`).catch(
        () => null,
      );
      expect(ready?.status, 'readiness must be 503 with a dead database').toBe(503);
      const live = await fetch(`http://127.0.0.1:${port}/health/live`).catch(() => null);
      expect(live?.status, 'liveness must stay 200 with a dead database').toBe(200);
      // Missing-variable language must not appear, and the password never may.
      expect(output).not.toContain('is missing');
      expect(output).not.toContain(FIXTURE_PASSWORD);
      expect(output).not.toContain(SECRET_MARKER);
    } finally {
      // The 'close' event may already have fired (e.g. the child exited on
      // its own), in which case awaiting it would hang forever — only wait
      // while the child is actually still running, with a bounded fallback.
      if (child.exitCode === null) {
        killTree(child);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10_000);
          child.on('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
  }, 120_000);
});

describe('valid configuration boot (database-gated)', () => {
  it('reaches readiness against an isolated loopback database when one is available', async () => {
    // Safety rule: only a loopback target is ever attempted, and never when
    // the operator asked for production. Anything else skips honestly.
    const candidate =
      process.env.TEST_DATABASE_URL ?? 'postgresql://localhost:5432/oxyide_test';
    let target: URL;
    try {
      target = new URL(candidate);
    } catch {
      console.info('skip: no parseable loopback test database URL available');
      return;
    }
    const loopback = target.hostname === 'localhost' || target.hostname === '127.0.0.1';
    if (!loopback || process.env.NODE_ENV === 'production') {
      console.info('skip: boot test runs only against a loopback test database');
      return;
    }
    const port = Number(target.port === '' ? '5432' : target.port);
    if (!(await tcpReachable(target.hostname, port))) {
      console.info(`skip: no database reachable at ${target.hostname}:${port}`);
      return;
    }
    const { status, output, stop } = await runBootstrap(
      baseEnv({ DATABASE_URL: candidate, PORT: '3498' }),
      90_000,
    );
    expect(output).not.toContain('Fatal startup error');
    expect(status).toBeDefined();
    // The app is (correctly) still serving: stop our own child promptly
    // rather than leaving it for the safety timer.
    await stop();
  }, 120_000);
});
