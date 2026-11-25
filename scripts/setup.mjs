#!/usr/bin/env node
/**
 * Oxyide Forge — cross-platform local development setup.
 *
 * The common onboarding interface for every supported shell (PowerShell,
 * Command Prompt via `npm run setup`, macOS/Linux shells, VS Code terminals):
 * Node.js is already a required runtime, so no Bash, WSL, or Git Bash is
 * needed to initialize the application.
 *
 * Usage:
 *   npm run setup                  Full setup + start dev server
 *   npm run setup -- --check       Validate prerequisites only (no changes)
 *   npm run setup -- --skip-migrations
 *   npm run setup -- --port 4000   Override PORT (default 3000)
 *
 * `setup.sh` (Unix convenience) delegates to this file, so there is exactly
 * one implementation of the workflow. Anything here that `setup.sh` promises
 * in its header is preserved: idempotent re-runs, never overwriting an
 * existing `.env`, never resetting the database, never leaving unmanaged
 * processes behind, never printing secrets, non-zero exit on any error.
 *
 * Only `node:` built-ins are used — no new dependencies.
 */

import { spawn } from 'node:child_process';
import { constants as fsConstants, copyFile, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETUP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SETUP_DIR, '..');

const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 19;
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 1_000;
const TCP_TIMEOUT_MS = 5_000;

/**
 * Parsed CLI options. Pure: no I/O, no process reads (argv is injected).
 * @param {string[]} argv Argument list (without node/script entries).
 */
export function parseArgs(argv) {
  const options = {
    checkOnly: false,
    skipMigrations: false,
    port: '3000',
    host: '127.0.0.1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      options.checkOnly = true;
    } else if (arg === '--skip-migrations') {
      options.skipMigrations = true;
    } else if (arg === '--port' || arg === '--host') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--port') options.port = value;
      else options.host = value;
      i += 1;
    } else if (arg === '-h' || arg === '--help') {
      return { help: true, options };
    } else {
      const error = new Error(`Unknown argument: ${arg}`);
      error.code = 'SETUP_BAD_USAGE';
      throw error;
    }
  }
  return { help: false, options };
}

/**
 * Whether a `vMAJOR.MINOR.PATCH` version string meets the >= 20.19 floor.
 * Pure: string in, boolean out.
 * @param {string} version e.g. `v20.19.2` or `20.19.2`.
 */
export function meetsMinimumNode(version) {
  const match = /^v?(\d+)\.(\d+)\.\d+/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

/**
 * Split a PostgreSQL URL into a redacted connection target. Only host, port,
 * and database name are ever returned — userinfo and query parameters (which
 * may carry secrets) are dropped by construction, so callers cannot leak them.
 * Pure: string in, target out. Throws on unparseable input.
 * @param {string} databaseUrl
 */
export function parseDatabaseTarget(databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use the postgresql:// or postgres:// protocol');
  }
  return {
    host: url.hostname,
    port: url.port === '' ? '5432' : url.port,
    database: url.pathname.replace(/^\//, ''),
  };
}

/** Extract `DATABASE_URL=<value>` from `.env` file text without logging it. */
export function databaseUrlFromEnvFile(envText) {
  for (const line of envText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('DATABASE_URL=')) continue;
    return trimmed.slice('DATABASE_URL='.length).trim();
  }
  return '';
}

function info(message) {
  process.stdout.write(`[INFO]  ${message}\n`);
}

function step(message) {
  process.stdout.write(`[STEP]  ${message}\n`);
}

function warn(message) {
  process.stdout.write(`[WARN]  ${message}\n`);
}

function fail(message) {
  process.stdout.write(`[ERROR] ${message}\n`);
}

/**
 * Run a command with an argument array (never a shell string) and inherit
 * stdio so the customer sees real tool output. On Windows the command is
 * resolved through the shell so `npm`/`npx` (`.cmd` shims) execute; the
 * argument array is still passed without shell interpolation.
 */
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT_DIR,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`'${command} ${args.join(' ')}' exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function fileExists(abs) {
  try {
    const st = await stat(abs);
    return st.isFile();
  } catch {
    return false;
  }
}

async function dirExists(abs) {
  try {
    const st = await stat(abs);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function checkNode() {
  if (!meetsMinimumNode(process.version)) {
    fail(`Node.js ${process.version} is unsupported. Required: >=20.19.0.`);
    process.exitCode = 1;
    throw new Error('unsupported node');
  }
  info(`Node.js ${process.version} OK`);
}

async function checkNpm() {
  let version = '';
  try {
    const child = spawn('npm', ['--version'], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    version = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout?.on('data', (chunk) => {
        out += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`npm --version exited with code ${code ?? 'unknown'}`));
      });
    });
  } catch {
    fail('npm not found.');
    process.exitCode = 1;
    throw new Error('npm missing');
  }
  info(`npm ${version} OK`);
}

async function checkFiles() {
  const required = [
    'package.json',
    'package-lock.json',
    '.env.example',
    'tsconfig.json',
    'prisma/schema.prisma',
  ];
  const missing = [];
  for (const rel of required) {
    if (!(await fileExists(path.join(ROOT_DIR, rel)))) missing.push(rel);
  }
  if (missing.length > 0) {
    fail(`Missing required files: ${missing.join(' ')}`);
    process.exitCode = 1;
    throw new Error('missing files');
  }
  info('Project files OK');
}

async function installDeps() {
  step('Installing dependencies (npm ci)…');
  await runCommand('npm', ['ci']);
  info('Dependencies installed OK');

  // The pre-commit hook is wired up here rather than from an npm `prepare`
  // lifecycle script: deployment-workflow tests forbid every pre*/post*/
  // lifecycle hook deliberately, and setup is the documented onboarding path.
  if (await dirExists(path.join(ROOT_DIR, '.git'))) {
    step('Installing the Git pre-commit hook (husky)…');
    await runCommand('npx', ['husky']);
    info('Pre-commit hook installed — commits run: npm run check');
  } else {
    warn('No .git directory — skipping the pre-commit hook install.');
    info("In a Git repository, run 'npx husky' once to enable it.");
  }
}

async function setupEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (await fileExists(envPath)) {
    info('.env exists — preserved (not overwritten)');
    return;
  }
  await copyFile(path.join(ROOT_DIR, '.env.example'), envPath, fsConstants.COPYFILE_EXCL);
  info('.env created from .env.example');
  warn('Edit .env and set JWT_SECRET and DATABASE_URL before starting.');
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

async function checkPostgres() {
  step('Checking PostgreSQL availability…');
  let envText = '';
  try {
    envText = await readFile(path.join(ROOT_DIR, '.env'), 'utf8');
  } catch {
    envText = '';
  }
  const databaseUrl = databaseUrlFromEnvFile(envText);
  if (databaseUrl === '') {
    fail('DATABASE_URL is not set in .env.');
    process.exitCode = 1;
    throw new Error('database url missing');
  }
  let target;
  try {
    target = parseDatabaseTarget(databaseUrl);
  } catch (error) {
    fail(`DATABASE_URL in .env is malformed: ${error instanceof Error ? error.message : 'invalid URL'}`);
    process.exitCode = 1;
    throw error;
  }
  if (await probeTcp(target.host, target.port)) {
    info(`PostgreSQL reachable at ${target.host}:${target.port} OK`);
  } else {
    fail(`Cannot reach PostgreSQL at ${target.host}:${target.port}.`);
    fail('Start your database (e.g. docker compose up -d postgres) and ensure DATABASE_URL is correct.');
    process.exitCode = 1;
    throw new Error('database unreachable');
  }
}

async function prismaGenerate() {
  step('Generating Prisma client…');
  await runCommand('npx', ['prisma', 'generate']);
  info('Prisma client generated OK');
}

async function runMigrations(skip) {
  if (skip) {
    warn('Skipping migrations (--skip-migrations)');
    return;
  }
  step('Applying database migrations (prisma migrate deploy)…');
  await runCommand('npx', ['prisma', 'migrate', 'deploy']);
  info('Migrations applied OK');
}

async function buildApp() {
  step('Building application…');
  await runCommand('npm', ['run', 'build']);
  info('Build OK');
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startAndVerify(host, port) {
  step(`Starting application on http://${host}:${port} …`);
  const child = spawn('npm', ['run', 'dev'], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(port), HOST: host, NODE_ENV: 'development' },
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const cleanup = () => {
    // Only the child this script started is ever signalled — never anything else.
    if (!exited) {
      try {
        child.kill();
      } catch {
        // Already gone; nothing further to do.
      }
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  step('Waiting for /health/ready (up to 60s)…');
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const url = `http://${host}:${port}/health/ready`;
  while (Date.now() < deadline) {
    if (exited) {
      fail('Application process exited during startup. Recent logs are above.');
      process.exitCode = 1;
      throw new Error('app exited during startup');
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) {
        info(`Application is ready at http://${host}:${port} OK`);
        return child;
      }
    } catch {
      // Not up yet; keep polling until the deadline.
    }
    await sleep(READY_POLL_MS);
  }
  cleanup();
  fail('Application did not become ready within 60s.');
  process.exitCode = 1;
  throw new Error('readiness timeout');
}

function printHelp() {
  process.stdout.write(
    [
      'Oxyide Forge — cross-platform local development setup.',
      '',
      'Usage:',
      '  npm run setup                  Full setup + start dev server',
      '  npm run setup -- --check       Validate prerequisites only (no changes)',
      '  npm run setup -- --skip-migrations  Skip prisma migrate deploy',
      '  npm run setup -- --port 4000   Override PORT (default 3000)',
      '',
      'Idempotent: re-running never overwrites .env, never resets the database,',
      'never leaves unmanaged processes behind. Secrets are never printed.',
      'Unix equivalent: bash setup.sh (delegates to this file).',
      '',
    ].join('\n'),
  );
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof Error && error.code === 'SETUP_BAD_USAGE') {
      fail(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (parsed.help) {
    printHelp();
    return;
  }
  const { options } = parsed;

  info('Oxyide Forge — local setup');
  info(`Project root: ${ROOT_DIR}`);
  process.stdout.write('\n');

  checkNode();
  await checkNpm();
  await checkFiles();

  if (options.checkOnly) {
    info('Prerequisite check passed (--check). No changes made.');
    return;
  }

  await installDeps();
  await setupEnv();
  await checkPostgres();
  await prismaGenerate();
  await runMigrations(options.skipMigrations);
  await buildApp();
  const child = await startAndVerify(options.host, options.port);

  process.stdout.write('\n');
  info('==================================================');
  info('  Forge is running');
  info(`  URL:     http://${options.host}:${options.port}`);
  info(`  Health:  http://${options.host}:${options.port}/health/ready`);
  info('  Stop:    Ctrl+C (this script cleans up its child)');
  info('==================================================');
  process.stdout.write('\n');

  // Keep the script alive so Ctrl+C triggers cleanup; the app child serves traffic.
  await new Promise((resolve) => {
    child.on('exit', resolve);
  });
}

// `node scripts/setup.mjs` runs; `import` from tests does not.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main(process.argv.slice(2)).catch((error) => {
    if (process.exitCode === 0) process.exitCode = 1;
    if (error instanceof Error && error.code !== 'SETUP_BAD_USAGE') {
      fail(error.message);
    }
  });
}
