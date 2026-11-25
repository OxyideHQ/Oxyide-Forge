import { envSchema } from './env.schema.js';
import type { AppConfig, SmtpConfig } from './types.js';

const rawEnv = {
  NODE_ENV: process.env.NODE_ENV,
  HOST: process.env.HOST,
  PORT: process.env.PORT,
  LOG_LEVEL: process.env.LOG_LEVEL,
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET,
  REDIS_URL: process.env.REDIS_URL,
  // M11.3 defect fix (M113-F01): M11.2 added and validated these five
  // variables in the schema but never read them here, so `config.smtp` was
  // permanently absent and SMTP could never be selected. This is the file the
  // M9/M8 precedent requires: every validated variable is read in exactly
  // this one `rawEnv` literal (ARCH-ENF-004).
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  SMTP_SECURITY: process.env.SMTP_SECURITY,
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
  APP_BASE_URL: process.env.APP_BASE_URL,
  OPENAPI_ENABLED: process.env.OPENAPI_ENABLED,
  SWAGGER_UI_ENABLED: process.env.SWAGGER_UI_ENABLED,
  METRICS_ENABLED: process.env.METRICS_ENABLED,
};

// DOC-002 fix: warn on unrecognized environment variables that look like
// they are intended to be Forge configuration but are not in the schema.
// Uses a similarity heuristic: only warns about variables whose name is
// within a small edit distance of a known config key, or that use Forge's
// domain vocabulary (REDIS, SMTP, CORS, etc.). This avoids warning about
// system/shell variables that happen to be uppercase.
const KNOWN_ENV_KEYS = new Set([
  'NODE_ENV', 'HOST', 'PORT', 'LOG_LEVEL', 'DATABASE_URL', 'JWT_SECRET',
  'REDIS_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD',
  'SMTP_SECURITY', 'CORS_ALLOWED_ORIGINS', 'APP_BASE_URL', 'OPENAPI_ENABLED',
  'SWAGGER_UI_ENABLED', 'METRICS_ENABLED',
]);

// Domain vocabulary that strongly suggests a Forge config intent
const FORGE_DOMAIN_TOKENS = new Set([
  'REDIS', 'SMTP', 'CORS', 'DATABASE', 'JWT', 'LOG', 'OPENAPI', 'SWAGGER',
  'METRICS', 'API', 'AUTH', 'CACHE', 'SESSION', 'COOKIE', 'RATE', 'LIMIT',
]);

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[n];
}

function isSuspectedConfigTypo(key: string): boolean {
  if (KNOWN_ENV_KEYS.has(key)) return false;
  // Must look like a config variable: uppercase with underscores
  if (!/^[A-Z][A-Z0-9_]+$/.test(key)) return false;
  if (key.length <= 3) return false;
  if (!key.includes('_')) return false;
  // Must contain a Forge domain token
  const hasDomainToken = [...FORGE_DOMAIN_TOKENS].some((token) =>
    key.includes(token),
  );
  if (!hasDomainToken) return false;
  // Must be within edit distance 3 of a known key
  for (const known of KNOWN_ENV_KEYS) {
    if (levenshtein(key, known) <= 3) return true;
  }
  return false;
}

const suspectedTypos = Object.keys(process.env).filter(isSuspectedConfigTypo);
for (const key of suspectedTypos) {
  // ARCH-ENF-014: no console.* — use stderr directly (config loads before Pino exists)
  process.stderr.write(
    `config: unrecognized environment variable '${key}' — ` +
    `this variable is not read by Forge. ` +
    `Check for typos (e.g. REDS_URL instead of REDIS_URL).\n`,
  );
}

const env = envSchema.parse(rawEnv);

export const config: AppConfig = {
  nodeEnv: env.NODE_ENV,
  host: env.HOST,
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL,
  appBaseUrl: env.APP_BASE_URL,
  docs: {
    // OpenAPI document generation (M7.6): explicit operator choice, on
    // by default in every environment. The document describes the public
    // API surface and carries no secrets, so generation itself is safe to
    // leave enabled; operators serving nothing public can disable it.
    openApiEnabled: env.OPENAPI_ENABLED,
    // Swagger UI presentation layer (M7.6): on by default except in
    // production (api-conventions §20.4 — a developer interface is
    // disabled by default where it is not needed). Independently
    // disableable without touching OpenAPI generation. The
    // Swagger-without-OpenAPI combination is rejected at startup in
    // env.schema.ts, so by the time this mapping runs the pair is valid.
    swaggerUiEnabled: env.SWAGGER_UI_ENABLED ?? env.NODE_ENV !== 'production',
  },
  metrics: {
    // M14.3: opt-in Prometheus exporter. Off by default (NoOp metrics); ON serves
    // a scrape-ready, bounded-label /metrics endpoint.
    enabled: env.METRICS_ENABLED,
  },
  http: {
    // Explicit request-body cap (M5.3): 1 MiB matches the previous implicit
    // Fastify default, so existing legitimate payloads (largest: registration
    // at well under 1 KiB) are unaffected while oversized bodies reject at
    // the transport layer before any handler runs. Fixed policy constant —
    // not operator-tunable, so a typo can never silently widen or break it.
    bodyLimitBytes: 1048576,
    // Explicit route-param cap (M5.3): 100 characters matches the previous
    // implicit Fastify default, so oversized identifiers reject with 414 at
    // routing time — before authentication, schemas, or handlers run. Fixed
    // policy constant for the same reason as the body cap. Endpoint `:id` /
    // `:name` schemas intentionally carry no maxLength: any schema bound at
    // or above 100 would never execute, and the transport cap is the single
    // uniform bound for every route.
    maxParamLength: 100,
  },
  ...(env.CORS_ALLOWED_ORIGINS
    ? {
        cors: {
          allowedOrigins: env.CORS_ALLOWED_ORIGINS,
        },
      }
    : {}),
  auth: {
    jwtSecret: env.JWT_SECRET,
    jwtAlgorithm: 'HS256',
    accessTokenTtlSeconds: 900,
    bcryptCostFactor: 12,
    // Refresh lifetime is a single absolute bound (7 days). Rotation and
    // revocation narrow the window further, but the absolute bound stays.
    refreshTokenTtlSeconds: 604800,
    // Verification lifetime is a single absolute bound (24 hours): long
    // enough for email delivery plus user action, short enough to bound a
    // leaked link. No resend pressure below this; no sliding above it.
    emailVerificationTtlSeconds: 86400,
    // Recovery lifetime is a single absolute bound (1 hour). Shorter than
    // the refresh lifetime because a recovery credential grants password
    // replacement, not session continuation — and rotation does not apply.
    passwordResetTtlSeconds: 3600,
    // Login-throttling policy is a fixed-window baseline (M3.14): at most 5
    // failures per account per 15 minutes, and at most 30 failures per
    // source IP per 15 minutes. The account bound stops focused guessing
    // even under source rotation; the source bound stops spraying across
    // many accounts even under target rotation. The source bound is looser
    // because legitimate clients share NAT addresses. Both windows expire
    // naturally — this is temporary frequency control, not lockout.
    loginThrottle: {
      accountThreshold: 5,
      accountWindowSeconds: 900,
      ipThreshold: 30,
      ipWindowSeconds: 900,
    },
    // Brute-force backoff policy (M3.15): bounded exponential delay derived
    // from the account dimension's failureCount, which M3.14 already records
    // atomically. The delay is computed from pre-user-lookup throttle state
    // (enumeration-resistant) and applied asynchronously before any
    // authentication work.
    //
    // Reachable delays before the M3.14 account threshold (429 at 5 failures)
    // rejects the request: failureCount 0→0ms, 1→250ms, 2→500ms, 3→1000ms,
    // 4→2000ms (exactly maxDelayMs). escalationStart is 1 so the configured
    // cap is actually reachable rather than dead policy.
    //
    // baseDelayMs is comparable to one bcrypt-12 operation (~250ms), so each
    // escalated attempt roughly doubles attacker cost. maxDelayMs is bounded
    // at 2s: long enough to make guessing uneconomic, short enough that it
    // cannot be weaponized into a meaningful denial of service against a
    // legitimate user, and short enough not to accumulate pending timers.
    bruteForce: {
      baseDelayMs: 250,
      maxDelayMs: 2000,
      escalationStart: 1,
    },
    // Account-lockout policy (M3.16): 5 account failures within a live
    // throttle window temporarily lock the account for 30 minutes. The
    // threshold intentionally equals the M3.14 account threshold — it is the
    // only reachable value, because the throttle caps the live-window count
    // at 5 (a lower threshold would lock legitimate users for ordinary
    // typos). The 30-minute duration is fixed and non-extending: attempts
    // made while locked record nothing and touch nothing, so attacker
    // traffic can delay a victim's recovery by at most one bounded window,
    // never indefinitely. Recovery is expiry-driven or via password reset;
    // there is deliberately no unlock endpoint and no permanent state.
    accountLockout: {
      failureThreshold: 5,
      lockoutDurationSeconds: 1800,
    },
    // Recovery-issuance frequency policy (M5.4): at most 5 credential
    // emails per attempted address per hour, and at most 30 per source IP
    // per hour, across the two unauthenticated issuing endpoints
    // (password-reset request, verification resend). The account bound
    // stops targeted victim-email harassment even under source rotation;
    // the source bound stops multi-address spraying even under target
    // rotation (looser because legitimate clients share NAT addresses).
    // Both windows expire naturally — frequency control only: no lockout,
    // no backoff, no success reset, no permanent state.
    recoveryThrottle: {
      accountThreshold: 5,
      accountWindowSeconds: 3600,
      ipThreshold: 30,
      ipWindowSeconds: 3600,
    },
    // Canonical password policy (M5.5): at least 12 characters, at most
    // 72 UTF-8 bytes. The byte bound is the bcrypt input boundary:
    // bcrypt silently truncates past 72 bytes, so accepting longer input
    // would let distinct passwords collapse into one credential. Fixed
    // security invariants — not operator-tunable.
    passwordPolicy: {
      minLength: 12,
      maxBytes: 72,
    },
    cookie: {
      // Cookie auth is development/test only until CSRF protection exists.
      enabled: env.NODE_ENV !== 'production',
      secure: env.NODE_ENV === 'production',
      httpOnly: true,
      // Strict (M5.4): the API has no legitimate cross-site top-level
      // navigation flow, so cookies are never sent cross-site — not even
      // on top-level GET. Same-site XHR (the only browser client pattern)
      // is unaffected.
      sameSite: 'strict',
      path: '/',
      maxAge: 900,
      name: 'accessToken',
    },
    refreshCookie: {
      // Same production gate as the access cookie: no refresh credential
      // leaves the server in production until CSRF protection exists.
      enabled: env.NODE_ENV !== 'production',
      secure: env.NODE_ENV === 'production',
      httpOnly: true,
      // Strict (M5.4): see access cookie. The refresh POST is same-site
      // XHR only, so Strict changes nothing legitimate.
      sameSite: 'strict',
      // Scoped to the refresh endpoint so the long-lived credential is not
      // attached to every API request. Logout clears with this same path.
      path: '/api/v1/auth/refresh',
      maxAge: 604800,
      name: 'refreshToken',
    },
  },
  ...(env.REDIS_URL
    ? {
        cache: {
          redis: {
            url: env.REDIS_URL,
          },
        },
      }
    : {}),
  ...smtpConfigFromEnv(env),
};

/**
 * Builds the optional SMTP section (M11.2).
 *
 * SMTP_HOST set means configured; unset means every other SMTP_* variable is
 * absent too (the schema rejects partial groups), so nothing is built.
 * The explicit throw covers the type-level gap between "validated" and
 * "provably complete to TypeScript": unreachable after successful
 * `envSchema.parse`, fail-closed if ever reached.
 */
function smtpConfigFromEnv(env: {
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_SECURITY?: SmtpConfig['security'];
}): { smtp: SmtpConfig } | Record<string, never> {
  if (env.SMTP_HOST === undefined) {
    return {};
  }
  if (env.SMTP_PORT === undefined || env.SMTP_SECURITY === undefined) {
    throw new Error(
      'Invalid SMTP configuration: SMTP_PORT and SMTP_SECURITY are required when SMTP_HOST is set.',
    );
  }
  return {
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      ...(env.SMTP_USER !== undefined && env.SMTP_PASSWORD !== undefined
        ? { user: env.SMTP_USER, password: env.SMTP_PASSWORD }
        : {}),
      security: env.SMTP_SECURITY,
    },
  };
}

/**
 * Recursively freezes the canonical configuration (M5.2).
 *
 * TypeScript `readonly` is compile-time only; without this, any imported
 * consumer could reassign security policy (thresholds, TTLs, cookie flags)
 * at runtime. The freeze covers the known object shape — if the config
 * shape gains nested objects later, extend this walk accordingly.
 */
function deepFreezeConfig(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    deepFreezeConfig((value as Record<string, unknown>)[key]);
  }
  Object.freeze(value);
}

deepFreezeConfig(config);

export { envSchema };
