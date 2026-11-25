import { z } from 'zod';

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    if (value === '0.0.0.0' || value === '127.0.0.1' || value === 'localhost') {
      return true;
    }

    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || /^[\w.-]+$/.test(value);
  }, 'HOST must be a valid host or IPv4 address');

const portSchema = z
  .string()
  .trim()
  .refine((value) => /^\d+$/.test(value), 'PORT must be a numeric string')
  .transform((value) => Number(value))
  .refine(
    (value) => Number.isInteger(value) && value >= 1 && value <= 65535,
    'PORT must be a valid TCP port',
  );

const logLevelSchema = z
  .string()
  .trim()
  .pipe(z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']));

const databaseUrlSchema = z
  .string()
  .trim()
  .url('DATABASE_URL must be a valid PostgreSQL connection URL')
  .refine(
    (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
    'DATABASE_URL must use the PostgreSQL protocol',
  )
  .refine(
    (value) => isValidConnectionParam(value, 'connection_limit', isPositiveIntegerString),
    'DATABASE_URL connection_limit must be a positive integer (>= 1) and appear at most once',
  )
  .refine(
    (value) => isValidConnectionParam(value, 'pool_timeout', isPositiveIntegerString),
    'DATABASE_URL pool_timeout must be a positive integer number of seconds (>= 1) and appear at most once',
  )
  .refine(
    (value) => isValidConnectionParam(value, 'connect_timeout', isPositiveIntegerString),
    'DATABASE_URL connect_timeout must be a positive integer number of seconds (>= 1) and appear at most once',
  )
  .refine(
    (value) => isValidSslModeParam(value),
    "DATABASE_URL sslmode must be 'require' or 'disable' and appear at most once (Prisma 6.12.0 silently ignores other modes, including verify-ca and verify-full)",
  );

// Connection parameters live in DATABASE_URL query parameters because that is
// the native Prisma/PostgreSQL mechanism — there is intentionally no parallel
// set of environment variables. Values below were verified against the
// installed Prisma 6.12.0 behavior: unknown parameters are silently ignored,
// non-integer pool/timeout values fail only on first query, and sslmode values
// other than require/disable are silently ignored (no certificate verification).

function databaseUrlSearchParams(value: string): URLSearchParams | null {
  try {
    return new URL(value).searchParams;
  } catch {
    // Base URL validation reports unparseable values; skip param checks there.
    return null;
  }
}

function isPositiveIntegerString(raw: string): boolean {
  return /^\d+$/.test(raw) && Number(raw) >= 1;
}

function isValidConnectionParam(
  value: string,
  name: 'connection_limit' | 'pool_timeout' | 'connect_timeout',
  isValid: (raw: string) => boolean,
): boolean {
  const params = databaseUrlSearchParams(value);
  if (params === null) return true;
  const values = params.getAll(name);
  if (values.length === 0) return true;
  if (values.length > 1) return false;
  return isValid(values[0]);
}

function isValidSslModeParam(value: string): boolean {
  const params = databaseUrlSearchParams(value);
  if (params === null) return true;
  const values = params.getAll('sslmode');
  if (values.length === 0) return true;
  if (values.length > 1) return false;
  return values[0] === 'require' || values[0] === 'disable';
}

const jwtSecretSchema = z
  .string({ required_error: 'JWT_SECRET is required' })
  .trim()
  .min(32, 'JWT_SECRET must be at least 32 characters for HS256 security');

const appBaseUrlSchema = z
  .string()
  .trim()
  .min(1, 'APP_BASE_URL must not be empty')
  .url('APP_BASE_URL must be a valid URL')
  .transform((value) => value.replace(/\/+$/, ''));

const redisUrlSchema = z
  .string()
  .trim()
  .min(1, 'REDIS_URL must not be empty')
  .url('REDIS_URL must be a valid URL')
  .refine(
    (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
    'REDIS_URL must use the redis:// or rediss:// protocol',
  );

/**
 * SMTP transport security mode (M11.2). Explicit by design — there is no
 * default, because the secure choice depends on the operator's server and a
 * silent default could downgrade production mail to plaintext:
 *
 * - `smtps`: implicit TLS from connection start (typically port 465).
 * - `starttls`: plaintext greeting upgraded via STARTTLS, refused when the
 *   server does not offer it (typically port 587).
 * - `plaintext`: no TLS at all. Development relays only (e.g. local Mailhog);
 *   rejected whenever credentials are configured (see coherence rules below).
 */
const smtpSecuritySchema = z.enum(['smtps', 'starttls', 'plaintext']);

/**
 * Strict boolean feature flag (M7.6).
 *
 * Only the exact strings `true`/`false` (whitespace-tolerant) are
 * accepted: `1`, `yes`, `abc`, and friends reject at startup rather than
 * silently becoming a security-relevant default. There is no pre-existing
 * boolean env convention (all previous flags derive from NODE_ENV), so
 * strictness here sets the precedent.
 */
const booleanFlagSchema = z
  .string()
  .trim()
  .pipe(z.enum(['true', 'false']));

/**
 * Comma-separated CORS origin allowlist.
 *
 * Each entry must be a bare `http(s)://host[:port]` origin — no paths,
 * queries, fragments, credentials, or non-HTTP schemes. Empty entries
 * (trailing/double commas, whitespace-only) reject the whole value so a
 * typo cannot silently narrow or widen the allowlist. Absent means CORS
 * is fully disabled (no cross-origin headers emitted).
 */
function parseCorsAllowedOrigins(raw: string): string[] {
  const origins = raw.split(',').map((entry) => entry.trim());
  for (const origin of origins) {
    if (origin === '') {
      throw new Error('CORS_ALLOWED_ORIGINS contains an empty origin');
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS_ALLOWED_ORIGINS contains a malformed origin: '${origin}'`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`CORS_ALLOWED_ORIGINS origin '${origin}' must use http:// or https://`);
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') {
      throw new Error(`CORS_ALLOWED_ORIGINS origin '${origin}' must be a bare origin without path, query, or credentials`);
    }
  }
  return [...new Set(origins.map((origin) => origin.replace(/\/+$/, '')))];
}

const corsAllowedOriginsSchema = z
  .string()
  .trim()
  .min(1, 'CORS_ALLOWED_ORIGINS must not be empty')
  .transform((value, ctx) => {
    try {
      return parseCorsAllowedOrigins(value);
    } catch (error: unknown) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid CORS_ALLOWED_ORIGINS',
      });
      return z.NEVER;
    }
  });

export const envSchema = z
  .object({
    NODE_ENV: z.string().trim().pipe(z.enum(['development', 'test', 'production'])).default('development'),
    HOST: hostSchema.default('0.0.0.0'),
    PORT: portSchema.default('3000'),
    LOG_LEVEL: logLevelSchema.default('info'),
    DATABASE_URL: databaseUrlSchema,
    JWT_SECRET: jwtSecretSchema,
    REDIS_URL: redisUrlSchema.optional(),
    SMTP_HOST: hostSchema.optional(),
    SMTP_PORT: portSchema.optional(),
    // Usernames are trimmed (surrounding whitespace is virtually always a
    // typo); passwords are NOT trimmed — leading/trailing spaces are valid in
    // credentials, and trimming would silently change the secret.
    SMTP_USER: z.string().trim().min(1, 'SMTP_USER must not be empty').optional(),
    SMTP_PASSWORD: z.string().min(1, 'SMTP_PASSWORD must not be empty').optional(),
    SMTP_SECURITY: smtpSecuritySchema.optional(),
    CORS_ALLOWED_ORIGINS: corsAllowedOriginsSchema.optional(),
    APP_BASE_URL: appBaseUrlSchema.default('http://localhost:3000'),
    OPENAPI_ENABLED: booleanFlagSchema.default('true').transform((value) => value === 'true'),
    SWAGGER_UI_ENABLED: booleanFlagSchema
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    // M14.3: Prometheus-compatible /metrics exporter. Opt-in (off by default,
    // matching the established NoOp-metrics default); when enabled, the telemetry
    // plugin records into a Prometheus adapter and /metrics serves it. Bounded
    // labels only — no secrets, IDs, or raw paths are ever exported.
    METRICS_ENABLED: booleanFlagSchema.default('false').transform((value) => value === 'true'),
  })
  .superRefine((env, ctx) => {
    // Swagger UI is a presentation layer over the OpenAPI document: it
    // cannot function without it, so requesting UI without the document
    // is rejected instead of silently enabling generation behind the
    // operator's back. Environment-independent (unlike the production TLS
    // rules below): an invalid flag combination is invalid everywhere.
    // The effective UI value accounts for the production default (see
    // index.ts) so implicit combinations fail closed as well.
    const swaggerUiEffective = env.SWAGGER_UI_ENABLED ?? env.NODE_ENV !== 'production';
    if (swaggerUiEffective && !env.OPENAPI_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SWAGGER_UI_ENABLED'],
        message:
          'SWAGGER_UI_ENABLED requires OPENAPI_ENABLED (set SWAGGER_UI_ENABLED=false to serve no documentation UI)',
      });
    }
    // SMTP coherence (M11.2): the five variables form one optional group.
    // SMTP_HOST present means configured, so PORT and SECURITY become
    // required (no assumed 587, no silent security default). Any SMTP_*
    // without SMTP_HOST is partial configuration and is rejected — a broken
    // provider must never be constructed silently. Credentials are a pair.
    // Credentials with plaintext transport would transmit secrets
    // unencrypted, so that combination is rejected: use smtps/starttls or
    // drop the credentials for a development relay.
    const smtpValues = [env.SMTP_HOST, env.SMTP_PORT, env.SMTP_USER, env.SMTP_PASSWORD, env.SMTP_SECURITY];
    const smtpAnyPresent = smtpValues.some((value) => value !== undefined);
    if (smtpAnyPresent && env.SMTP_HOST === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message:
          'SMTP_HOST is required when any SMTP_* variable is set (partial SMTP configuration is rejected)',
      });
    }
    if (env.SMTP_HOST !== undefined) {
      if (env.SMTP_PORT === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_PORT'],
          message: 'SMTP_PORT is required when SMTP_HOST is set',
        });
      }
      if (env.SMTP_SECURITY === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_SECURITY'],
          message:
            'SMTP_SECURITY is required when SMTP_HOST is set (one of smtps, starttls, plaintext)',
        });
      }
      const userPresent = env.SMTP_USER !== undefined;
      const passwordPresent = env.SMTP_PASSWORD !== undefined;
      if (userPresent !== passwordPresent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_PASSWORD'],
          message: 'SMTP_USER and SMTP_PASSWORD must be set together',
        });
      }
      if (userPresent && passwordPresent && env.SMTP_SECURITY === 'plaintext') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_SECURITY'],
          message:
            'SMTP credentials require smtps or starttls (plaintext transport would transmit the secret unencrypted)',
        });
      }
    }
    // Production TLS is mandatory and enforced here because Prisma 6.12.0 only
    // honors sslmode=require (verified); other modes are silently ignored.
    if (env.NODE_ENV !== 'production') return;
    if (typeof env.DATABASE_URL !== 'string') return;
    let mode: string | null = null;
    try {
      mode = new URL(env.DATABASE_URL).searchParams.get('sslmode');
    } catch {
      return;
    }
    if (mode !== 'require') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message:
          'DATABASE_URL must include sslmode=require when NODE_ENV=production (production TLS is mandatory)',
      });
    }
    // Recovery links must never point at plaintext production origins.
    if (typeof env.APP_BASE_URL === 'string' && !env.APP_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_BASE_URL'],
        message: 'APP_BASE_URL must use https:// when NODE_ENV=production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;
