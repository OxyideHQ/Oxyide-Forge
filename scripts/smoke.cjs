#!/usr/bin/env node
/**
 * Operational smoke test (M14.3).
 *
 * Probes the documented health endpoints of an already-running Forge instance
 * (local, container, or remote) and reports whether it is serving. This is the
 * post-deploy operational check that complements `verify:deployment` (which
 * boots the app locally against a database) — it targets a configurable URL,
 * needs no database, reads no secrets, is read-only, and uses bounded timeouts.
 *
 * Only the two documented, unauthenticated probes are checked: /health/live
 * (process) and /health/ready (traffic readiness). A 503 on /health/ready means
 * the instance must not receive traffic, so the smoke test fails — never papered
 * over.
 *
 * Exit codes: 0 = all probes healthy; 1 = a probe unhealthy/failed/timed out;
 * 2 = configuration error (missing/invalid/unsupported target URL).
 */
'use strict';

const PROBE_PATHS = ['/health/live', '/health/ready'];
const DEFAULT_TIMEOUT_MS = 5000;

function parseArgs(argv) {
  const args = { url: process.env.SMOKE_TARGET_URL, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (args.help) break;
    if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--url') args.url = argv[++i];
  }
  return args;
}

function configError(message) {
  process.stderr.write(`smoke: ${message}\n`);
  process.exit(2);
}

async function probe(baseUrl, path, timeoutMs) {
  const target = new URL(path, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, { method: 'GET', headers: { accept: '*/*' }, signal: controller.signal });
    return { path: target.pathname, status: res.status, ok: res.status === 200 };
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String((error && error.message) || error);
    return { path: target.pathname, status: 0, ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node scripts/smoke.cjs --url <base-url>\n  (or set SMOKE_TARGET_URL). Probes /health/live and /health/ready.\n');
    process.exit(0);
  }
  if (!args.url) configError('no target URL — set SMOKE_TARGET_URL or pass --url <base-url>');

  const timeoutMs = Number.parseInt(process.env.SMOKE_TIMEOUT_MS ?? '', 10);
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  let base;
  try {
    base = new URL(args.url);
  } catch {
    configError(`invalid target URL: ${args.url}`);
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    configError(`target URL must use http(s):// — got ${base.protocol}`);
  }

  let healthy = true;
  for (const path of PROBE_PATHS) {
    const result = await probe(base.toString(), path, boundedTimeout);
    const outcome = result.status === 0 ? `error (${result.reason})` : String(result.status);
    process.stdout.write(`${result.ok ? 'OK  ' : 'FAIL'} GET ${result.path} -> ${outcome}\n`);
    if (!result.ok) healthy = false;
  }

  process.stdout.write(`${healthy ? 'smoke: healthy' : 'smoke: unhealthy'}\n`);
  process.exit(healthy ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`smoke: unexpected error: ${String((error && error.message) || error)}\n`);
  process.exit(1);
});
