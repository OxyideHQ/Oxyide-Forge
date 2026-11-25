/**
 * Startup failure diagnostics (M12.7).
 *
 * A single pure function that turns an unknown bootstrap throw into a stable,
 * secret-safe, actionable developer diagnostic. It exists because the two
 * previous failure modes were both bad in opposite ways: configuration
 * failures bypassed `main.ts` entirely (import-time throw → raw Zod dump with
 * a stack trace), while boot failures logged an error object the developer
 * had to reverse-engineer. Both now flow through one classification.
 *
 * Design constraints (load-bearing):
 *
 * - Zero imports. This module must work when configuration itself is broken,
 *   so it cannot touch config, the logger, or any module that reads either.
 * - Never echoes values. Zod issue *paths* name the variable; Zod *messages*
 *   are reproduced with `received '…'` fragments stripped, because a received
 *   value is raw operator input and could be anything (including a secret
 *   pasted into the wrong field). Proven by sentinel tests, not by review.
 * - Categories are closed and stable: `configuration`, `port`, `bootstrap`,
 *   `unexpected`. They are developer diagnostics, never API `ErrorCodes`,
 *   and never enter the frozen M6 mapper or an HTTP response.
 * - Deterministic: same error in, same diagnostic out. No clock, no random,
 *   no environment reads (reading `process.env` here would violate
 *   ARCH-ENF-004 and would be wrong anyway — the environment is suspect).
 */

/** Stable developer-facing startup failure categories. */
export type StartupFailureCategory = 'configuration' | 'port' | 'bootstrap' | 'unexpected';

/** One actionable diagnostic line for a single problem. */
export interface StartupDiagnostic {
  readonly category: StartupFailureCategory;
  /** Short human title, e.g. `Invalid configuration (DATABASE_URL)`. */
  readonly title: string;
  /** Safe detail lines. Variable names and shapes only — never values. */
  readonly details: readonly string[];
  /** What to do next, most specific first. */
  readonly remediation: readonly string[];
  /** Where the documented workflow lives. */
  readonly see: string;
}

const DOCS_CONFIG = 'docs/development.md §4 (Environment configuration)';
const DOCS_TROUBLESHOOTING = 'docs/development.md §10 (Troubleshooting)';

/**
 * Static remediation per variable. Keyed by exact variable name so a renamed
 * variable fails closed to the generic remediation instead of silently
 * printing nothing — and so adding a variable means adding one line here.
 */
const REMEDIATION_BY_VARIABLE: Record<string, string> = {
  DATABASE_URL:
    'Set a valid postgresql:// URL in .env and verify PostgreSQL is reachable, then restart.',
  JWT_SECRET: 'Set a random secret of at least 32 characters (e.g. `openssl rand -base64 32`).',
  NODE_ENV: 'Use exactly development, test, or production.',
  HOST: 'Use a valid host or IPv4 address (e.g. 0.0.0.0, 127.0.0.1, localhost).',
  PORT: 'Use a plain integer TCP port 1–65535.',
  LOG_LEVEL: 'Use one of fatal, error, warn, info, debug, trace.',
  APP_BASE_URL: 'Use a valid URL with no trailing path; production requires https://.',
  REDIS_URL:
    'Use a redis:// or rediss:// URL, or delete the variable entirely — an empty string is an error, not "disabled".',
  CORS_ALLOWED_ORIGINS:
    'Use comma-separated bare http(s)://host[:port] origins with no paths, queries, or empty entries.',
  OPENAPI_ENABLED: 'Use exactly true or false.',
  SWAGGER_UI_ENABLED:
    'Use exactly true or false; Swagger UI requires OPENAPI_ENABLED to be true.',
  METRICS_ENABLED:
    'Use exactly true or false to enable or disable the Prometheus-compatible /metrics endpoint.',
  SMTP_HOST: 'Set the mail server hostname, or remove every SMTP_* variable for NoOp email.',
  SMTP_PORT: 'Set a TCP port 1–65535 (no default is assumed), or remove the SMTP group.',
  SMTP_USER: 'Set SMTP_USER and SMTP_PASSWORD together, or neither.',
  SMTP_PASSWORD: 'Set SMTP_USER and SMTP_PASSWORD together, or neither.',
  SMTP_SECURITY: 'Use exactly smtps, starttls, or plaintext — never with credentials on plaintext.',
};

const GENERIC_REMEDIATION =
  'Correct the value in .env (development) or the process environment (production), then restart.';

/** `received '…'` fragments carry raw operator input — strip them all. */
const RECEIVED_FRAGMENT = /, received '[^']*'/g;

function safeMessage(message: unknown): string {
  if (typeof message !== 'string') return 'Invalid value.';
  const stripped = message.replace(RECEIVED_FRAGMENT, '');
  // Zod's missing-value message is accurate but terse; say what it means.
  if (stripped === 'Required') return 'is missing.';
  return stripped;
}

interface ZodLikeIssue {
  readonly path?: unknown;
  readonly message?: unknown;
}

function isZodError(error: unknown): error is { readonly issues: readonly ZodLikeIssue[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ZodError' &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

function variableOf(issue: ZodLikeIssue): string | null {
  if (!Array.isArray(issue.path) || issue.path.length === 0) return null;
  const [first] = issue.path;
  return typeof first === 'string' && first.length > 0 ? first : null;
}

function classifyConfiguration(error: { readonly issues: readonly ZodLikeIssue[] }): StartupDiagnostic {
  const details: string[] = [];
  const remediation: string[] = [];
  const variables: string[] = [];
  for (const raw of error.issues) {
    // Total by construction: a malformed issues array (foreign Zod-like
    // shape, null entries) degrades to a generic line, never a throw.
    const issue: ZodLikeIssue = typeof raw === 'object' && raw !== null ? raw : {};
    const variable = variableOf(issue);
    const message = safeMessage(issue.message);
    if (variable === null) {
      details.push(message);
      continue;
    }
    details.push(`${variable}: ${message}`);
    variables.push(variable);
    const fix = REMEDIATION_BY_VARIABLE[variable];
    if (fix !== undefined && !remediation.includes(fix)) {
      remediation.push(fix);
    }
  }
  if (remediation.length === 0) {
    remediation.push(GENERIC_REMEDIATION);
  }
  const title =
    variables.length === 1
      ? `Invalid configuration (${variables[0]})`
      : 'Invalid configuration';
  return { category: 'configuration', title, details, remediation, see: DOCS_CONFIG };
}

function isPortConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; message?: unknown };
  if (record.code === 'EADDRINUSE') return true;
  return typeof record.message === 'string' && record.message.includes('EADDRINUSE');
}

/**
 * Classifies an unknown bootstrap throw into a stable developer diagnostic.
 * Total: never throws, never echoes values, never reads the environment.
 */
export function classifyStartupFailure(error: unknown): StartupDiagnostic {
  if (isZodError(error)) {
    return classifyConfiguration(error);
  }
  if (isPortConflict(error)) {
    return {
      category: 'port',
      title: 'Port binding failure (EADDRINUSE)',
      details: ['The configured host/port is already occupied or unavailable.'],
      remediation: [
        'Stop the other server, or run on a free port (e.g. `PORT=3451 npm run dev`).',
      ],
      see: DOCS_TROUBLESHOOTING,
    };
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return {
      category: 'bootstrap',
      title: 'Application bootstrap failure',
      details: ['The application failed during startup after configuration loaded.'],
      remediation: [
        'Inspect the logged error above for the failing subsystem, then restart.',
      ],
      see: DOCS_TROUBLESHOOTING,
    };
  }
  return {
    category: 'unexpected',
    title: 'Unexpected startup failure',
    details: ['Startup threw a non-error value; no further detail is available.'],
    remediation: ['Inspect the logged error above, then restart.'],
    see: DOCS_TROUBLESHOOTING,
  };
}
