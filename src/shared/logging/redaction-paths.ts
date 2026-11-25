/**
 * Centralized secret redaction paths (M5.6).
 *
 * The fail-safe net UNDER the serializers: serializers decide what ENTERS
 * the pipeline (allowlisted shapes), redaction guarantees that if a secret
 * field ever reaches a logged object directly (a future
 * `log.info({ body })`, a thrown error's custom props, a child-logger
 * binding), it is censored instead of emitted.
 *
 * Each path was empirically proven against the installed pino 9 redact
 * implementation (top-level, one-level `*` nesting, explicit deep paths,
 * `arr[*]` arrays, nested header objects). Paths are case-sensitive, so
 * both cases are listed where the tree uses both. The censor marker is a
 * fixed string: stable shape + proves redaction applied.
 *
 * Cost: pino compiles paths once; per line it performs bounded key
 * lookups only — no deep clones, no regex scans, no per-request
 * allocations beyond the matched subtrees.
 */
export const REDACTION_CENSOR = '[Redacted]';

/** Secret field vocabulary: exact repo vocabulary plus equivalent forms. */
const SECRET_FIELDS: readonly string[] = [
  'password',
  'passwordHash',
  'accessToken',
  'refreshToken',
  'resetToken',
  'verificationToken',
  'token',
  'tokenHash',
  'secret',
  'jwtSecret',
  'JWT_SECRET',
  'databaseUrl',
  'DATABASE_URL',
  'redisUrl',
  'REDIS_URL',
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'bearer',
  'Bearer',
  'apiKey',
  'sessionToken',
  'sessionSecret',
  'credentials',
];

/**
 * Object shapes secret fields can plausibly sit in, expressed as wildcard
 * depth coverage (proven against the installed pino/fast-redact):
 *
 * - `FIELD` — top-level keys;
 * - `*.FIELD` — one wrapper level (`{user: {passwordHash}}`, `{body: {...}}`,
 *   `{headers: {...}}`, `{config: {...}}` — named containers add nothing
 *   beyond this wildcard, so they are not enumerated);
 * - `*.*.FIELD` — two wrapper levels (`{user: {profile: {password}}}`);
 * - `*[*].FIELD` — arrays under any key (`{items: [{token}]}` — the
 *   wildcard crosses array indices, proven live).
 */
const DEPTH_PATTERNS: readonly string[] = ['', '*.', '*.*.', '*[*].'];

function buildRedactPaths(): readonly string[] {
  const paths: string[] = [];
  for (const field of SECRET_FIELDS) {
    for (const pattern of DEPTH_PATTERNS) {
      paths.push(`${pattern}${field}`);
    }
  }
  // Deep config snapshots: exact paths to the live secret values.
  paths.push('config.auth.jwtSecret', 'config.databaseUrl', 'config.cache.redis.url');
  // Raw-request accidents: full header/body shapes if a raw req object is
  // ever logged under a non-serialized key.
  paths.push(
    'req.headers.authorization',
    'req.headers.cookie',
    'req.body.password',
    'request.headers.authorization',
    'request.headers.cookie',
    'request.body.password',
  );
  return Object.freeze(paths);
}

export const REDACT_PATHS: readonly string[] = buildRedactPaths();
