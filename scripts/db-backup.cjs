#!/usr/bin/env node
/**
 * Logical PostgreSQL backup with verification (M2.8).
 *
 * Creates a `pg_dump` custom-format backup of an EXPLICITLY provided database,
 * verifies the artifact (non-empty, `pg_restore --list` parses, sha256
 * manifest), and exits non-zero on any failure. Never treats a failed backup
 * as successful; never leaves a partial file behind under the final name.
 *
 * Safety contract (fail closed):
 * - The target comes ONLY from `--url` or `BACKUP_DATABASE_URL`. The ambient
 *   application `DATABASE_URL` is never consulted, so a normal shell cannot
 *   accidentally select the wrong database.
 * - No output (stdout, stderr, manifest, log line) ever contains credentials:
 *   every emitted string passes through redaction.
 * - Backup is read-only against the source database; nothing is created,
 *   modified, or deleted there.
 * - Exit codes: 0 success; 1 backup/verification failure; 2 usage or
 *   infrastructure failure (missing pg_dump, unreadable output dir, ...).
 *
 * Usage:
 *   node scripts/db-backup.cjs --url <postgres-url> --out <dir> [--env <label>]
 *   BACKUP_DATABASE_URL=<url> node scripts/db-backup.cjs --out <dir>
 *   node scripts/db-backup.cjs --help
 */
'use strict';

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TOOL_NAME = 'oxyide-db-backup';
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_INFRA = 2;

function failInfra(message) {
  process.stdout.write(`backup ERROR (infrastructure): ${message}\n`);
  process.exit(EXIT_INFRA);
}

function failBackup(message) {
  process.stdout.write(`backup FAILED: ${message}\n`);
  process.exit(EXIT_FAILURE);
}

function usage() {
  process.stdout.write(
    [
      'Usage:',
      '  node scripts/db-backup.cjs --url <postgres-url> --out <dir> [--env <label>]',
      '  BACKUP_DATABASE_URL=<url> node scripts/db-backup.cjs --out <dir>',
      '  node scripts/db-backup.cjs --help',
      '',
      'The target URL is required explicitly via --url or BACKUP_DATABASE_URL.',
      'The ambient application DATABASE_URL is never used.',
      'Output is written as <env>-<db>-<UTC-timestamp>.dump plus a JSON manifest.',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const result = { url: undefined, out: undefined, env: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--url' && i + 1 < argv.length) {
      result.url = argv[(i += 1)];
    } else if (arg === '--out' && i + 1 < argv.length) {
      result.out = argv[(i += 1)];
    } else if (arg === '--env' && i + 1 < argv.length) {
      result.env = argv[(i += 1)];
    } else if (arg.startsWith('--url=')) {
      result.url = arg.slice('--url='.length);
    } else if (arg.startsWith('--out=')) {
      result.out = arg.slice('--out='.length);
    } else if (arg.startsWith('--env=')) {
      result.env = arg.slice('--env='.length);
    } else {
      failInfra(`unknown argument ${JSON.stringify(arg)} (see --help)`);
    }
  }
  return result;
}

// Replace URL userinfo (and any other known secret) so logged, printed, and
// persisted strings can never carry credentials.
function redact(text, secrets) {
  let out = String(text);
  out = out.replace(/:\/\/[^/\s]*@/g, '://***@');
  for (const secret of secrets) {
    if (secret && secret.length > 0 && out.includes(secret)) {
      out = out.split(secret).join('***');
    }
  }
  return out;
}

function sanitizeNamePart(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'unknown';
}

function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function parseTargetUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'target URL is not parseable' };
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    return { ok: false, reason: 'target URL must use the postgresql:// or postgres:// protocol' };
  }
  const dbname = parsed.pathname.replace(/^\/+/, '');
  if (!dbname) {
    return { ok: false, reason: 'target URL must include a database name' };
  }
  return {
    ok: true,
    host: parsed.hostname || 'localhost',
    port: parsed.port || '5432',
    dbname,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
  };
}

function runCommand(command, args, env, label) {
  let result;
  try {
    result = spawnSync(command, args, { encoding: 'utf8', env });
  } catch (error) {
    return {
      ok: false,
      message: `${label} could not be started: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (result.error) {
    return { ok: false, message: `${label} could not be started: ${result.error.message}` };
  }
  const output = `${typeof result.stdout === 'string' ? result.stdout : ''}\n${
    typeof result.stderr === 'string' ? result.stderr : ''
  }`;
  if (result.status !== 0) {
    return { ok: false, message: `${label} failed (exit ${result.status}): ${output.trim()}` };
  }
  return { ok: true, output };
}

function readPackageVersion(packageDir, packageName) {
  try {
    const pkgPath = path.join(packageDir, 'node_modules', packageName, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function listMigrationNames(rootDir) {
  try {
    const dir = path.join(rootDir, 'prisma', 'migrations');
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(EXIT_OK);
  }

  const rawUrl = args.url || process.env.BACKUP_DATABASE_URL;
  if (!rawUrl) {
    failInfra(
      'no explicit backup target: pass --url <postgres-url> or set BACKUP_DATABASE_URL ' +
        '(the ambient application DATABASE_URL is never used)',
    );
  }
  if (!args.out) {
    failInfra('no output directory: pass --out <dir>');
  }

  const target = parseTargetUrl(rawUrl);
  if (!target.ok) {
    failInfra(`invalid backup target URL: ${target.reason}`);
  }
  const secrets = [target.password];

  const outDir = path.resolve(args.out);
  try {
    const stat = fs.statSync(outDir);
    if (!stat.isDirectory()) {
      failInfra(`output path is not a directory: ${outDir}`);
    }
    fs.accessSync(outDir, fs.constants.W_OK);
  } catch (error) {
    failInfra(`output directory is not usable: ${outDir} (${error instanceof Error ? error.message : String(error)})`);
  }

  const pgDumpCheck = runCommand('pg_dump', ['--version'], process.env, 'pg_dump');
  if (!pgDumpCheck.ok) {
    failInfra(
      `pg_dump is not available in PATH; install PostgreSQL client tools 17.x. ${redact(pgDumpCheck.message, secrets)}`,
    );
  }
  const pgDumpVersion = (pgDumpCheck.output.match(/(\d+\.\d+(?:\.\d+)?)/) || [])[1] || 'unknown';

  const envLabel = sanitizeNamePart(args.env || process.env.NODE_ENV || 'unspecified');
  const stamp = utcStamp();
  const baseName = `oxyide-${envLabel}-${sanitizeNamePart(target.dbname)}-${stamp}`;
  const finalPath = path.join(outDir, `${baseName}.dump`);
  const manifestPath = path.join(outDir, `${baseName}.manifest.json`);
  const partPath = path.join(outDir, `${baseName}.part`);

  const childEnv = { ...process.env };
  const argvUrl = `postgresql://${target.host}:${target.port}/${target.dbname}`;
  if (target.username) childEnv.PGUSER = target.username;
  if (target.password) childEnv.PGPASSWORD = target.password;
  else delete childEnv.PGPASSWORD;

  const startedAt = Date.now();
  const dump = runCommand(
    'pg_dump',
    [argvUrl, '--format=custom', '--file', partPath],
    childEnv,
    'pg_dump',
  );
  if (!dump.ok) {
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      /* best effort cleanup */
    }
    failBackup(redact(dump.message, secrets));
  }
  const dumpMs = Date.now() - startedAt;

  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(partPath).size;
  } catch (error) {
    failBackup(
      `backup artifact missing after successful pg_dump: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (sizeBytes <= 0) {
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      /* best effort cleanup */
    }
    failBackup('backup artifact is empty; refusing to present it as complete');
  }

  const listed = runCommand('pg_restore', ['--list', partPath], process.env, 'pg_restore --list');
  if (!listed.ok) {
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      /* best effort cleanup */
    }
    failBackup(`backup artifact failed structural verification: ${redact(listed.message, secrets)}`);
  }

  let sha256 = '';
  try {
    sha256 = createHash('sha256').update(fs.readFileSync(partPath)).digest('hex');
  } catch (error) {
    failBackup(
      `could not checksum backup artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rootDir = path.resolve(__dirname, '..');
  const manifest = {
    tool: TOOL_NAME,
    pgDumpVersion,
    prismaClientVersion: readPackageVersion(rootDir, '@prisma/client'),
    createdAt: new Date(startedAt).toISOString(),
    env: envLabel,
    database: target.dbname,
    host: target.host,
    port: target.port,
    migrations: listMigrationNames(rootDir),
    format: 'custom',
    sizeBytes,
    sha256,
    durationMs: dumpMs,
  };
  try {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(partPath, finalPath);
  } catch (error) {
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      /* best effort cleanup */
    }
    failBackup(
      `could not finalize backup artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  process.stdout.write(
    [
      `backup complete: ${baseName}.dump`,
      `  database: ${target.dbname} on ${target.host}:${target.port}`,
      `  size: ${sizeBytes} bytes, sha256: ${sha256.slice(0, 16)}..., duration: ${dumpMs}ms`,
      `  manifest: ${baseName}.manifest.json`,
    ].join('\n') + '\n',
  );
  process.exit(EXIT_OK);
}

main();
