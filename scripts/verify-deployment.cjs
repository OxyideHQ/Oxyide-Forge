#!/usr/bin/env node
'use strict';

/**
 * M9.5 — deterministic deployment verification.
 *
 * Docker is not guaranteed to be available (and is absent in some CI images),
 * so this script verifies the deployment contract in two layers:
 *
 *   1. STATIC — parses Dockerfile / .dockerignore / docker-compose.yml and
 *      asserts the healthcheck contract: endpoint, port source, loopback-only
 *      target, timing values, and the absence of any credential.
 *   2. LIVE — boots the real compiled server as a child process and drives the
 *      full container lifecycle over real HTTP: start -> healthy -> dependency
 *      failure -> unhealthy -> dependency recovery -> healthy -> shutdown.
 *
 * The dependency-failure leg is real, not simulated: the child is pointed at a
 * local TCP proxy in front of the actual PostgreSQL, and the proxy is closed
 * and reopened. The application process is never restarted, which is exactly
 * the property M9.5 must demonstrate — dependency recovery without a restart.
 *
 * Exit code 0 means every assertion passed. No test framework, no new
 * dependency: `node:net` and `fetch` only.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const failures = [];
const notes = [];
// M18.2 / RUNTIME-002: the live lifecycle leg is a distinct, explicitly
// reported outcome. A run that never executed it must never be summarised as
// PASS, and must carry an exit code that a caller can distinguish from a
// complete run.
let liveLegRan = false;

function check(label, condition, detail) {
  if (condition) {
    notes.push(`PASS  ${label}`);
  } else {
    failures.push(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function readFile(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. STATIC — the healthcheck contract
// ---------------------------------------------------------------------------

function verifyStatic() {
  const dockerfile = readFile('Dockerfile');
  const dockerignore = readFile('.dockerignore');
  const compose = readFile('docker-compose.yml');

  const healthcheckMatch = dockerfile.match(/HEALTHCHECK\b([\s\S]*?)\n\s*CMD\s+([^\n]+)/);
  check('Dockerfile declares a HEALTHCHECK', healthcheckMatch !== null);
  if (healthcheckMatch === null) {
    return;
  }

  const [, options, command] = healthcheckMatch;

  check(
    'healthcheck probes readiness, not liveness',
    command.includes('/health/ready') && !command.includes('/health/live'),
    command.trim(),
  );
  check('healthcheck targets loopback only', command.includes('127.0.0.1'), command.trim());
  check(
    'healthcheck uses the container listening port, not a hardcoded one',
    command.includes('${PORT') || command.includes('$PORT'),
    command.trim(),
  );
  check(
    'healthcheck adds no HTTP client dependency',
    !/\b(curl|httpie|wget-install|apk add)\b/.test(command),
    command.trim(),
  );
  check(
    'healthcheck uses the preinstalled busybox wget',
    command.includes('wget'),
    command.trim(),
  );
  check(
    'healthcheck fails on any non-success status',
    command.includes('|| exit 1'),
    command.trim(),
  );
  check(
    'healthcheck exposes no credential, token, or connection string',
    !/(DATABASE_URL|REDIS_URL|JWT_SECRET|password|secret|token|:\/\/[^"]*@)/i.test(command),
    command.trim(),
  );

  // Timing: interval, timeout, retries, start-period.
  const timing = {
    interval: /--interval=(\d+)s/.exec(options),
    timeout: /--timeout=(\d+)s/.exec(options),
    retries: /--retries=(\d+)/.exec(options),
    startPeriod: /--start-period=(\d+)s/.exec(options),
  };
  for (const [name, match] of Object.entries(timing)) {
    check(`healthcheck sets ${name}`, match !== null);
  }
  if (Object.values(timing).every((match) => match !== null)) {
    const interval = Number(timing.interval[1]);
    const timeout = Number(timing.timeout[1]);
    const retries = Number(timing.retries[1]);
    const startPeriod = Number(timing.startPeriod[1]);

    // The probe's own budget must sit strictly inside the check timeout, or a
    // hung probe would outlive its own check and pile up.
    check(
      `probe timeout (4s) is inside HEALTHCHECK timeout (${timeout}s)`,
      timeout > 4,
      `timeout=${timeout}`,
    );
    check(
      `retries (${retries}) do not exceed the interval (${interval}s) budget`,
      retries >= 2 && interval >= timeout,
      `retries=${retries} interval=${interval} timeout=${timeout}`,
    );
    // Measured application startup is 2.4-2.9s; the grace window must comfortably
    // exceed that so a cold start is never counted as unhealthy.
    check(
      `start_period (${startPeriod}s) covers measured startup (~2.9s) with margin`,
      startPeriod >= 15,
      `start_period=${startPeriod}`,
    );
    notes.push(
      `INFO  time-to-unhealthy = ${startPeriod + retries * interval}s (${startPeriod}s grace + ${retries} x ${interval}s)`,
    );
  }

  // Build-context hygiene: a developer's .env must never reach the daemon.
  check('.dockerignore excludes .env', /^\.env$/m.test(dockerignore));
  check('.dockerignore excludes .git', /^\.git$/m.test(dockerignore));
  check('.dockerignore excludes node_modules', /^node_modules$/m.test(dockerignore));
  check('.dockerignore excludes dist', /^dist$/m.test(dockerignore));
  check('.dockerignore still ships .env.example', /^!\.env\.example$/m.test(dockerignore));

  // Compose hygiene.
  // Compose hygiene. Precise credential-literal detection: a value is a literal
  // only if it is NOT entirely an interpolation. `postgresql://user:pass@host`
  // inline is a leak; `${DATABASE_URL:?...}` is the required opposite.
  const composeAssignments = compose
    .split('\n')
    .filter((line) => /^\s+[A-Z_]+:/.test(line))
    .map((line) => line.trim());

  check(
    'compose declares no credential literal',
    composeAssignments.every((line) => {
      const value = line.slice(line.indexOf(':') + 1).trim();
      if (value === '' || value.startsWith('${')) {
        return true;
      }
      return !/[A-Z_]*(PASSWORD|SECRET|TOKEN|URL)[A-Z_]*:\s*\S/i.test(line);
    }),
    composeAssignments.filter((line) => /PASSWORD|SECRET|TOKEN/i.test(line)).join(' | '),
  );
  check(
    'compose requires DATABASE_URL from the environment',
    compose.includes('${DATABASE_URL:?'),
  );
  check(
    'compose requires JWT_SECRET from the environment',
    compose.includes('${JWT_SECRET:?'),
  );
  check(
    'compose gates the app on database health',
    /depends_on:[\s\S]*?condition:\s*service_healthy/.test(compose),
  );
  check('compose forwards signals with init: true', /^\s*init:\s*true$/m.test(compose));
  check(
    'compose allows a graceful stop window',
    /stop_grace_period:\s*\d+s/.test(compose),
  );
  check('compose does not override the image healthcheck', !/^\s*healthcheck:/m.test(compose.split('app:')[1] ?? ''));

  // Regression guard for M95-F01: `${REDIS_URL:-}` expands to an empty string,
  // which validated config rejects as an error rather than treating it as
  // absent — so that form would prevent the container from starting whenever
  // Redis is not configured.
  check(
    'compose never defaults REDIS_URL to an empty string',
    !/REDIS_URL:\s*\$\{REDIS_URL:-?\}/.test(compose),
    'use an override file or list-form passthrough instead',
  );

  // Neither file may smuggle a secret literal. Comment lines are excluded: a
  // comment that *names* a variable to tell an operator what to set is helpful,
  // and is not an assignment.
  for (const [name, content] of [
    ['Dockerfile', dockerfile],
    ['docker-compose.yml', compose],
  ]) {
    const code = content
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    check(`${name} contains no inline credential assignment`, !/(DATABASE_URL|JWT_SECRET|REDIS_URL)\s*=\s*\S/.test(code));
  }

  check('Dockerfile runs as a non-root user', /^\s*USER\s+(?!root)\S+/m.test(dockerfile));
  check('runtime stage installs no extra packages', !/apk add/.test(dockerfile));
}

// ---------------------------------------------------------------------------
// 2. LIVE — the real container lifecycle over HTTP
// ---------------------------------------------------------------------------

/**
 * A TCP proxy in front of PostgreSQL whose availability we control.
 *
 * Closing must DESTROY live sockets, not merely stop listening: `server.close()`
 * waits for open connections to end, and the Prisma pool holds a persistent one,
 * so a listen-only close would hang forever and the simulated outage would never
 * happen. Destroying them is also what a real database outage looks like to the
 * client — the connection is severed, not politely closed.
 */
function startProxy(targetHost, targetPort) {
  const state = { server: null, port: null, sockets: new Set() };

  state.open = () =>
    new Promise((resolve, reject) => {
      const sockets = new Set();
      const server = net.createServer((client) => {
        sockets.add(client);
        // M131-F07: the upstream host comes from DATABASE_URL, not a hardcoded
        // 127.0.0.1. It previously assumed loopback, so pointing DATABASE_URL at
        // any other host made the proxy unreachable by the child process and the
        // live leg failed deterministically with three "probe timeout" results —
        // an environment condition reported as if it were a product defect.
        const upstream = net.connect(targetPort, targetHost);
        sockets.add(upstream);

        const drop = () => {
          sockets.delete(client);
          sockets.delete(upstream);
          client.destroy();
          upstream.destroy();
        };

        client.on('error', drop);
        upstream.on('error', drop);
        client.on('close', () => sockets.delete(client));
        upstream.on('close', () => sockets.delete(upstream));

        client.pipe(upstream);
        upstream.pipe(client);
      });
      // The SAME port every time. The child is configured with this port in its
      // DATABASE_URL, so reopening on a fresh ephemeral port would leave the
      // client pointed at a dead address and recovery could never be observed.
      server.listen(state.port ?? 0, '127.0.0.1', () => {
        state.server = server;
        state.sockets = sockets;
        state.port = server.address().port;
        resolve(state.port);
      });
      server.on('error', reject);
    });

  state.close = () =>
    new Promise((resolve) => {
      if (state.server === null) {
        resolve();
        return;
      }
      const server = state.server;
      state.server = null;
      for (const socket of state.sockets) {
        socket.destroy();
      }
      state.sockets.clear();
      // close() still waits on the (now destroyed) sockets, so resolve promptly.
      server.close(() => resolve());
      setImmediate(resolve);
    });

  return state;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One-shot HTTP probe with NO connection pooling.
 *
 * `agent: false` is essential, not an optimization: a pooled client keeps
 * sockets open, and the child under test cannot complete `server.close()` while
 * a client still holds one — which made this script time out on graceful
 * shutdown for a reason that had nothing to do with the application. It also
 * matches the real healthcheck, which is a single `wget` with no keep-alive.
 */
function probe(port, requestPath) {
  return new Promise((resolve) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: 'GET', agent: false, timeout: 4000 },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      },
    );
    request.on('timeout', () => request.destroy(new Error('probe timeout')));
    request.on('error', (error) => resolve({ status: 0, body: String(error.message) }));
    request.end();
  });
}

async function waitFor(port, requestPath, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe(port, requestPath);
    if (predicate(last)) {
      return last;
    }
    await sleep(100);
  }
  return last;
}

async function verifyLive(databaseUrl) {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main.js'))) {
    failures.push('FAIL  dist/main.js missing — run `npm run build` first');
    return;
  }

  // M131-F07: derive the database host AND port from DATABASE_URL. Only the port
  // was read before, while the proxy's upstream was hardcoded to loopback.
  const databaseTarget = new URL(databaseUrl);
  const databaseHost = databaseTarget.hostname;
  const databasePort = Number(databaseTarget.port || '5432');
  const proxy = startProxy(databaseHost, databasePort);
  const proxyPort = await proxy.open();

  // The child is pointed at the proxy. It must address the proxy by LOOPBACK
  // regardless of where the real database lives, because the proxy listens
  // locally — hence withHost, mirroring the original withPort intent.
  const toProxy = (url) => {
    const parsed = new URL(url);
    parsed.hostname = '127.0.0.1';
    parsed.port = String(proxyPort);
    return parsed.toString();
  };

  const appPort = 3400 + Math.floor(Math.random() * 400);
  // Redis is left genuinely ABSENT rather than set to an empty string. The
  // validated configuration layer rejects `REDIS_URL=""` as a configuration
  // error (M9.3), so an empty string is not the way to express "not
  // configured" — and passing one here would mask that distinction.
  const childEnv = { ...process.env };
  delete childEnv.REDIS_URL;

  const child = spawn('node', ['dist/main.js'], {
    env: {
      ...childEnv,
      // Deliberately NOT forced to `production`. The validated configuration
      // layer mandates `sslmode=require` when NODE_ENV=production (production
      // TLS is mandatory), which a local verification database cannot satisfy.
      // Forcing it would make this script fail for a reason unrelated to the
      // health contract. NODE_ENV only selects cookie, docs, and TLS defaults —
      // the health contract under test is identical in every environment, and
      // the production TLS rule itself is covered by the config suites.
      NODE_ENV: process.env.VERIFICATION_NODE_ENV ?? 'development',
      HOST: '127.0.0.1',
      PORT: String(appPort),
      DATABASE_URL: toProxy(databaseUrl),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logLines = [];
  child.stdout.on('data', (chunk) => logLines.push(String(chunk)));
  child.stderr.on('data', (chunk) => logLines.push(String(chunk)));

  /** Surfaces the child's own diagnostics when it could not be reached. */
  const unreachable = (result) => {
    if (result.status === 0) {
      const tail = logLines.join('').trim().split('\n').slice(-3).join(' | ');
      notes.push(`DIAG  server output: ${tail}`);
    }
  };

  try {
    // --- container starts -> healthy -------------------------------------
    const ready = await waitFor(appPort, '/health/ready', (r) => r.status === 200, 30000);
    unreachable(ready);
    check('container becomes healthy: /health/ready -> 200', ready.status === 200, `status=${ready.status}`);
    check('ready body is the frozen empty object', ready.body === '{}', ready.body);

    const live = await probe(appPort, '/health/live');
    check('/health/live -> 200 while healthy', live.status === 200, `status=${live.status}`);

    // --- dependency failure -> unhealthy ---------------------------------
    await proxy.close();
    const unready = await waitFor(
      appPort,
      '/health/ready',
      (r) => r.status === 503,
      30000,
    );
    check('PostgreSQL down: /health/ready -> 503', unready.status === 503, `status=${unready.status}`);
    check('unready body is the frozen empty object', unready.body === '{}', unready.body);

    const stillLive = await probe(appPort, '/health/live');
    check(
      'PostgreSQL down: /health/live stays 200 (liveness is dependency-free)',
      stillLive.status === 200,
      `status=${stillLive.status}`,
    );

    // --- dependency recovery -> healthy, WITHOUT a restart ---------------
    await proxy.open();
    const recovered = await waitFor(
      appPort,
      '/health/ready',
      (r) => r.status === 200,
      40000,
    );
    check(
      'PostgreSQL restored: /health/ready -> 200 with no application restart',
      recovered.status === 200,
      `status=${recovered.status}`,
    );
    check('the server process was never restarted', child.exitCode === null);

    // --- no leakage in any observed output -------------------------------
    const logs = logLines.join('');
    for (const secret of [databaseUrl, 'P1001', 'postgresql://']) {
      check(
        `no connection string leaked into logs (${secret.slice(0, 24)})`,
        !logs.includes(secret),
      );
    }
    check('logs never name a secret-bearing environment variable', !/JWT_SECRET=|REDIS_URL=/.test(logs));

    // --- shutdown ---------------------------------------------------------
    child.kill('SIGTERM');
    const shutdownStart = Date.now();
    let sawDrain = false;
    while (Date.now() - shutdownStart < 5000) {
      const during = await probe(appPort, '/health/ready');
      if (during.status === 503 || during.status === 0) {
        sawDrain = true;
        break;
      }
      await sleep(25);
    }
    check(
      'SIGTERM withdraws readiness (503) or closes the listener',
      sawDrain,
      'readiness never left 200 before shutdown finished',
    );

    const exitCode = await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
        return;
      }
      child.once('exit', (code) => resolve(code));
      setTimeout(() => resolve("timeout"), 20000);
    });
    check('graceful shutdown completes and the process exits', exitCode === 0, `exit=${exitCode}`);

    // --- repeated signal is safe -----------------------------------------
    if (exitCode === 0) {
      let threw = false;
      try {
        child.kill('SIGTERM');
      } catch {
        threw = true;
      }
      check('a repeated shutdown signal does not throw', !threw);
    }
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    await proxy.close();
  }
}

async function main() {
  verifyStatic();

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    // M131-F11: this used to be a note plus a PASS exit carrying the static
    // count alone (32 checks), while docs/release-contract.md cites 47. A reader
    // could not tell a complete verification from a half-run one, and
    // `npm run validate` would happily chain a half-verified deployment step.
    // The live leg is 15 of the 47 checks and the only part that exercises real
    // boot, dependency failure, same-PID recovery, and SIGTERM — it cannot be
    // silently absent from a PASS.
    if (process.env.VERIFICATION_STATIC_ONLY === '1') {
      notes.push(
        'SKIP  live lifecycle verification — DATABASE_URL is not set (VERIFICATION_STATIC_ONLY=1)',
      );
      notes.push(
        'NOTE  this run verifies DEFINITIONS only; the live lifecycle (boot, dependency failure, recovery, SIGTERM) was NOT exercised',
      );
    } else {
      failures.push(
        'DATABASE_URL is not set — the live lifecycle verification (boot, dependency failure, same-PID recovery, SIGTERM drain) did not run. Set DATABASE_URL, or opt into definitions-only with VERIFICATION_STATIC_ONLY=1',
      );
    }
  } else {
    liveLegRan = true;
    await verifyLive(databaseUrl);
  }

  for (const note of notes) {
    console.log(note);
  }
  for (const failure of failures) {
    console.log(failure);
  }

  // RUNTIME-002: three explicit outcomes instead of two. Previously a
  // definitions-only run printed "PASS" and exited 0, so a caller — including
  // `npm run validate` — could chain a deployment step that never booted the
  // application and still report success.
  const passed = notes.filter((n) => n.startsWith('PASS')).length;
  let verdict;
  let exitCode;
  if (failures.length > 0) {
    verdict = 'FAIL';
    exitCode = 1;
  } else if (!liveLegRan) {
    verdict = 'INCOMPLETE';
    exitCode = 2;
  } else {
    verdict = 'PASS';
    exitCode = 0;
  }

  console.log(`\nDeployment verification: ${verdict} (${passed} checks passed, ${failures.length} failed)`);
  if (liveLegRan) {
    console.log(
      '  Scope: static repository/configuration checks AND the live lifecycle leg (boot, dependency failure, same-PID recovery, SIGTERM drain).',
    );
  } else {
    console.log(
      '  Scope: STATIC repository/configuration checks ONLY. The live lifecycle leg (boot, dependency failure, same-PID recovery, SIGTERM drain) did NOT run.',
    );
    console.log(
      '  This is NOT a complete deployment verification. To run it: set DATABASE_URL to a database you are willing to have exercised, then re-run.',
    );
    if (verdict === 'INCOMPLETE') {
      console.log(
        '  Exit code 2 means "no check failed, but a required leg never ran" — treat this as NOT verified.',
      );
    }
  }
  process.exitCode = exitCode;
}

void main();
