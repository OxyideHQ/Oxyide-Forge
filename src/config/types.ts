export type AppEnvironment = 'development' | 'test' | 'production';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface CookieConfig {
  enabled: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge: number;
  name: string;
}

export interface AuthConfig {
  jwtSecret: string;
  jwtAlgorithm: 'HS256';
  accessTokenTtlSeconds: number;
  bcryptCostFactor: number;
  cookie: CookieConfig;
  refreshTokenTtlSeconds: number;
  refreshCookie: CookieConfig;
  passwordResetTtlSeconds: number;
  emailVerificationTtlSeconds: number;
  loginThrottle: LoginThrottleConfig;
  bruteForce: BruteForceConfig;
  accountLockout: AccountLockoutConfig;
  recoveryThrottle: RecoveryThrottleConfig;
  passwordPolicy: PasswordPolicyConfig;
}

/**
 * Fixed-window login-throttling policy (M3.14).
 *
 * Two independent dimensions share one window shape but carry separate
 * thresholds: the account dimension binds password-guessing against one
 * address even when the source rotates, while the source dimension bounds
 * credential-spraying across many addresses from one client even when the
 * target rotates. Both dimensions expire naturally — throttling is temporary
 * frequency control, never account lockout (M3.16 owns lockout).
 */
export interface LoginThrottleConfig {
  accountThreshold: number;
  accountWindowSeconds: number;
  ipThreshold: number;
  ipWindowSeconds: number;
}

/**
 * Bounded exponential backoff policy (M3.15).
 *
 * Progressive delay derived from the account dimension's failureCount.
 * The delay is computed from pre-user-lookup throttle state, so it is
 * enumeration-resistant: unknown emails and known emails with wrong
 * passwords receive the same delay for the same failureCount.
 *
 * The delay is bounded by maxDelayMs — no attacker-controlled input can
 * produce an unbounded sleep. The delay is applied asynchronously
 * (setTimeout) and never blocks the event loop.
 */
export interface BruteForceConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  escalationStart: number;
}

/**
 * Temporary account-lockout policy (M3.16).
 *
 * A bounded, account-scoped, non-extending lock set when account failures
 * reach the threshold within a live throttle window. The lock lives on
 * `User.lockedUntil` (NULL = unlocked) so it survives throttle-window
 * recycling; attempts made while locked record nothing and change nothing,
 * so attacker traffic can never extend the lockout. Recovery is
 * request-driven (expiry) or via successful password reset — no unlock
 * endpoint, no background worker, no permanent state.
 */
export interface AccountLockoutConfig {
  failureThreshold: number;
  lockoutDurationSeconds: number;
}

/**
 * Recovery-issuance frequency policy (M5.4).
 *
 * Fixed-window frequency control over the two unauthenticated
 * email-issuing endpoints (password-reset request, verification resend).
 * Same two-dimension shape as login throttling: the account dimension is
 * keyed by the *attempted* normalized email (so unknown emails consume the
 * same buckets as known ones — enumeration-safe), the source dimension by
 * client IP. Unlike login there is no lockout, no backoff, and no success
 * reset — pure frequency control with naturally expiring windows.
 *
 * Hourly windows (not 15-minute like login): legitimate recovery is rare
 * (a few redials per hour at most), while the harm being bounded is
 * per-email harassment volume and token/email-issuance growth.
 */
export interface RecoveryThrottleConfig {
  accountThreshold: number;
  accountWindowSeconds: number;
  ipThreshold: number;
  ipWindowSeconds: number;
}

/**
 * Canonical password policy (M5.5).
 *
 * Fixed constants (not operator-tunable): the minimum keeps guessing
 * uneconomic with bcrypt-12, and the maximum is the bcrypt 72-byte input
 * boundary — enforced in BYTES (`Buffer.byteLength`, UTF-8), because
 * character counts and byte counts diverge on multibyte input and bcrypt
 * silently truncates past 72 bytes. Accepting longer input would let two
 * distinct passwords collapse into one credential.
 */
export interface PasswordPolicyConfig {
  minLength: number;
  maxBytes: number;
}

export interface RedisConfig {
  url: string;
}

export interface CacheConfig {
  redis: RedisConfig;
}

/**
 * SMTP transport security mode (M11.2).
 *
 * - `smtps`: implicit TLS from connection start (typically port 465).
 * - `starttls`: STARTTLS upgrade, refused when the server does not offer it
 *   (typically port 587).
 * - `plaintext`: no TLS. Development relays only; rejected whenever
 *   credentials are configured.
 */
export type SmtpSecurity = 'smtps' | 'starttls' | 'plaintext';

/**
 * SMTP transport configuration (M11.2).
 *
 * Present only when the operator configures SMTP (SMTP_HOST set); absent
 * means the NoOp email provider stays in effect. Credentials are an
 * all-or-nothing pair, and there is deliberately no sender field here: the
 * frozen M11.1 contract requires `from` on every message, so a second
 * sender source would be dead configuration with ambiguous precedence.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
  security: SmtpSecurity;
}

/**
 * HTTP transport policy (M5.3).
 *
 * Centralized transport limits live here; endpoint-specific input bounds
 * live in route schemas; security-header/CORS policy lives in plugins.
 * Values are fixed policy constants (like auth TTLs), not operator-tunable,
 * so a typo can never silently weaken transport security.
 */
export interface HttpConfig {
  bodyLimitBytes: number;
  maxParamLength: number;
}

/**
 * CORS allowlist (M5.3).
 *
 * Present only when the operator configures explicit origins; absent means
 * CORS is fully disabled (no cross-origin headers emitted). Origins are
 * matched exactly — never substring, suffix, or regex.
 */
export interface CorsConfig {
  allowedOrigins: string[];
}

/**
 * API documentation exposure (M7.6).
 *
 * Two independent capabilities with one dependency rule: the OpenAPI
 * document can stand alone, but Swagger UI cannot function without it.
 * Both are plain booleans by the time they reach application code —
 * raw strings never leave the env schema.
 */
export interface DocsConfig {
  openApiEnabled: boolean;
  swaggerUiEnabled: boolean;
}

/** M14.3: operational metrics exporter toggle (Prometheus-compatible /metrics). */
export interface MetricsConfig {
  enabled: boolean;
}

export interface AppConfig {
  nodeEnv: AppEnvironment;
  host: string;
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  appBaseUrl: string;
  auth: AuthConfig;
  http: HttpConfig;
  docs: DocsConfig;
  metrics: MetricsConfig;
  cors?: CorsConfig;
  cache?: CacheConfig;
  smtp?: SmtpConfig;
}
