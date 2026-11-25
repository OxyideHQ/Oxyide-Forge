/**
 * Black-box tests for scripts/smoke.cjs (M14.3). Each case runs a temporary
 * local HTTP server mimicking a running Forge instance and invokes the smoke
 * script as a subprocess against it, asserting exit codes and output. The child
 * is spawned ASYNCHRONOUSLY (not spawnSync) so this process's event loop can
 * serve the fixture while the script runs — spawnSync would deadlock them. No
 * real application, database, or network beyond loopback is used.
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const smoke = path.join(scriptsDir, 'smoke.cjs');

const servers: Server[] = [];

afterEach(() => {
  while (servers.length) servers.pop()?.close();
});

function startServer(handler: Parameters<typeof createServer>[1]): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
    servers.push(server);
  });
}

function runSmoke(args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smoke, ...args], {
      env: { ...process.env, SMOKE_TARGET_URL: '', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, out }));
  });
}

describe('smoke.cjs', () => {
  it('exits 0 when liveness and readiness are both 200', async () => {
    const port = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end('{}');
    });
    const { status, out } = await runSmoke(['--url', `http://127.0.0.1:${port}`]);
    expect(status).toBe(0);
    expect(out).toMatch(/OK\s+GET \/health\/live -> 200/);
    expect(out).toMatch(/OK\s+GET \/health\/ready -> 200/);
  }); // <- closes 'both 200'

  it('exits 1 when readiness returns 503 (instance must not take traffic)', async () => {
    const port = await startServer((req, res) => {
      res.statusCode = req.url === '/health/ready' ? 503 : 200;
      res.end('{}');
    });
    const { status, out } = await runSmoke(['--url', `http://127.0.0.1:${port}`]);
    expect(status).toBe(1);
    expect(out).toMatch(/FAIL GET \/health\/ready -> 503/);
    expect(out).toMatch(/OK\s+GET \/health\/live -> 200/); // liveness stays fine
  });

  it('reads the target from SMOKE_TARGET_URL when no --url is given', async () => {
    const port = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end('{}');
    });
    const { status } = await runSmoke([], { SMOKE_TARGET_URL: `http://127.0.0.1:${port}` });
    expect(status).toBe(0);
  });

  it('exits 2 on a missing target URL', async () => {
    const { status } = await runSmoke([], { SMOKE_TARGET_URL: '' });
    expect(status).toBe(2);
  });

  it('exits 2 on an invalid or unsupported URL', async () => {
    expect((await runSmoke(['--url', 'not-a-url'])).status).toBe(2);
    expect((await runSmoke(['--url', 'ftp://example.com'])).status).toBe(2);
  });

  it('exits 1 (fails) on a timeout with a bounded wait', async () => {
    // Server that never responds -> the bounded timeout must trip (not hang).
    const port = await startServer(() => {
      /* intentionally never responds */
    });
    const { status, out } = await runSmoke(['--url', `http://127.0.0.1:${port}`], { SMOKE_TIMEOUT_MS: '300' });
    expect(status).toBe(1);
    expect(out).toContain('timeout');
  });
});
