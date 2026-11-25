import type { FastifyInstance, FastifySchema } from 'fastify';

import { authService } from '../services/auth.service.js';
import {
  AuthSecurityEventName,
  emitAuthSecurityEvent,
} from '../services/auth-security-events.js';
import { requireAuth } from '../../authorization/guards/require-auth.js';
import type { AuthContext } from '../../../types/auth-context.js';
import { config } from '../../../config/index.js';
import { PUBLIC_USER_JSON_SCHEMA } from '../../users/user-response.js';
import { authEmailMailers } from '../email/auth-email-composition.js';

// --- Validation schemas ---

/**
 * Email pattern that accepts leading/trailing whitespace.
 * The service layer normalizes (trim + lowercase) before storage.
 * Rejects obviously invalid formats: no @, no domain, no TLD.
 */
const EMAIL_PATTERN = '^\\s*[^@\\s]+@[^@\\s]+\\.[^@\\s]+\\s*$';

const registerSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
      // Upper bound is the bcrypt 72-byte truncation limit (M3.18 F-2):
      // longer inputs would silently lose entropy, with prefix-sharing
      // passwords verifying identically. Login is intentionally unbounded
      // so pre-existing longer passwords keep verifying as before.
      password: { type: 'string', minLength: 12, maxLength: 72 },
      displayName: { type: 'string', maxLength: 100 },
    },
  },
  // M7.2: explicit success contract. The serializer strips anything the
  // contract does not declare, so internal fields cannot leak even if a
  // service change attached them.
  response: {
    201: {
      ...PUBLIC_USER_JSON_SCHEMA,
      description: 'Created user (public representation; no credentials).',
    },
  },
};

/**
 * Access-token envelope for non-browser API clients (M7.2).
 * Browser clients receive tokens via HttpOnly cookies and get a
 * PublicUser body instead (see login below) — same status, two shapes.
 */
const accessTokenResponseSchema = {
  type: 'object',
  required: ['accessToken'],
  additionalProperties: false,
  properties: {
    accessToken: { type: 'string', minLength: 1 },
  },
} as const;

const loginSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
      password: { type: 'string', minLength: 1 },
    },
  },
  // Both login shapes share status 200: PublicUser for browser clients
  // (tokens via cookies), the token envelope for API clients.
  response: {
    200: {
      anyOf: [PUBLIC_USER_JSON_SCHEMA, accessTokenResponseSchema],
      description:
        'Access token for API clients, or the public user with session cookies for browser clients.',
    },
  },
};

const passwordResetRequestSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['email'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
    },
  },
};

const passwordResetConfirmSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['token', 'password'],
    additionalProperties: false,
    properties: {
      token: { type: 'string', minLength: 1, maxLength: 512 },
      // Same 72-byte bcrypt bound as registration (M3.18 F-2).
      password: { type: 'string', minLength: 12, maxLength: 72 },
    },
  },
};

const emailVerificationResendSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['email'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
    },
  },
};

const emailVerificationConfirmSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['token'],
    additionalProperties: false,
    properties: {
      token: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
};

/**
 * Detects whether the request originates from a browser client.
 * Browser clients receive the access token via a server-set cookie.
 * Non-browser clients receive the access token in the JSON response body.
 *
 * Detection is based on the Accept header: browser clients typically
 * accept HTML content types, while API clients accept only JSON.
 */
function isBrowserClient(acceptHeader: string | undefined): boolean {
  if (!acceptHeader) {
    return false;
  }
  return acceptHeader.includes('text/html') || acceptHeader.includes('application/xhtml+xml');
}

/**
 * Registers all authentication routes under /api/v1/auth.
 *
 * Routes:
 *   POST /api/v1/auth/register
 *   POST /api/v1/auth/login
 *   POST /api/v1/auth/logout
 *   GET  /api/v1/auth/me
 *   POST /api/v1/auth/refresh
 *   POST /api/v1/auth/password-reset/request
 *   POST /api/v1/auth/password-reset/confirm
 *   POST /api/v1/auth/email-verification/resend
 *   POST /api/v1/auth/email-verification/confirm
 *   POST /api/v1/auth/sessions/revoke-all
 */
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/auth/register
  app.post(
    '/api/v1/auth/register',
    {
      schema: {
        ...registerSchema,
        tags: ['Auth'],
        summary: 'Register a new user',
        description:
          'Creates the user and credential, returning 201 with the public user and a Location header. A duplicate email returns 409.',
        operationId: 'registerUser',
        security: [],
      },
    },
    async (request, reply) => {
const { email, password, displayName } = request.body as {
  email: string;
  password: string;
  displayName?: string;
};

// M11.3 wiring: the composed domain mailer, never a transport. The service
// sends strictly after its transaction commits; with no SMTP configured the
// composed mailer is the frozen M3 NoOp, so behaviour is unchanged.
const user = await authService.register(
  { email, password, displayName },
  authEmailMailers.emailVerification,
);

// M7.2: standard creation header. The created user is addressable at
// this canonical route (same convention a future OpenAPI document uses).
return reply.status(201).header('Location', `/api/v1/users/${user.id}`).send(user);
  });

  // POST /api/v1/auth/login
  app.post(
    '/api/v1/auth/login',
    {
      schema: {
        ...loginSchema,
        tags: ['Auth'],
        summary: 'Log in with email and password',
        description:
          'Returns 200 with an access token for API clients, or the public user with HttpOnly cookies for browser clients. Wrong credentials return 401; repeated failures throttle (429).',
        operationId: 'loginUser',
        security: [],
      },
    },
    async (request, reply) => {
const { email, password } = request.body as { email: string; password: string };

// The source dimension of login throttling uses Fastify's
// socket-derived request IP. No forwarded header is consulted: with no
// trusted-proxy configuration, X-Forwarded-For is client-controlled and
// must never select the throttle key.
const result = await authService.login(
  app,
  { email, password, clientIp: request.ip },
  {
    securityEventLogger: request.log,
    // M11.3 wiring: the composed domain mailer for post-commit security
    // notices, plus the existing safe failure logger. Delivery stays
    // best-effort and never alters the response.
    securityNotificationMailer: authEmailMailers.securityNotification,
    securityNotificationLogger: request.log,
  },
);

if (isBrowserClient(request.headers.accept) && config.auth.cookie.enabled) {
  // Browser clients: set cookies, return PublicUser.
  // Cookie lifetime derives from the access-token TTL so the cookie
  // can never outlive the credential it carries.
  reply.setCookie(config.auth.cookie.name, result.accessToken, {
    httpOnly: config.auth.cookie.httpOnly,
    secure: config.auth.cookie.secure,
    sameSite: config.auth.cookie.sameSite,
    path: config.auth.cookie.path,
    maxAge: config.auth.accessTokenTtlSeconds,
  });

  // The refresh credential lives in memory only until this point: the
  // session persistence above already committed, so delivering it now
  // can never strand a client with an unrecorded credential.
  reply.setCookie(config.auth.refreshCookie.name, result.refreshToken, {
    httpOnly: config.auth.refreshCookie.httpOnly,
    secure: config.auth.refreshCookie.secure,
    sameSite: config.auth.refreshCookie.sameSite,
    path: config.auth.refreshCookie.path,
    maxAge: config.auth.refreshTokenTtlSeconds,
  });

  return reply.status(200).send(result.user);
}

// Non-browser clients: return access token in response body
return reply.status(200).send({ accessToken: result.accessToken });
  });

  // POST /api/v1/auth/logout
  //
  // Ends the caller's session when it can be identified: the presented
  // refresh credential (if any) resolves to its family, which is revoked
  // server-side. Identification is best-effort and oracle-free — absent,
  // unknown, expired, consumed, or already-revoked credentials all yield the
  // same 204. Cookie clearing always runs. A database failure during
  // revocation propagates to the sanitized 5xx contract instead of a false
  // 204. Already-issued access JWTs drain to expiry (no blacklist).
  app.post(
    '/api/v1/auth/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Log out the current session',
        description:
          'Best-effort, unauthenticated by design: revokes the presented refresh-credential family when identifiable and clears cookies. Absent or unknown credentials still return 204.',
        operationId: 'logoutUser',
        security: [],
      },
    },
    async (request, reply) => {
    const rawRefreshToken = request.cookies?.[config.auth.refreshCookie.name];
    if (typeof rawRefreshToken === 'string' && rawRefreshToken.length > 0) {
      const { revoked } = await authService.logout(rawRefreshToken);
      // Observational only: the presented credential identifies no account
      // by itself, so the event carries no subject — outcome only.
      emitAuthSecurityEvent(request.log, {
        event: AuthSecurityEventName.SESSION_REVOKED,
        outcome: revoked ? 'revoked' : 'no_session',
      });
    }

    if (config.auth.cookie.enabled) {
      reply.clearCookie(config.auth.cookie.name, {
        path: config.auth.cookie.path,
      });
      reply.clearCookie(config.auth.refreshCookie.name, {
        path: config.auth.refreshCookie.path,
      });
    }

    return reply.status(204).send();
  });

  // GET /api/v1/auth/me
  //
  // Returns the current persisted user for the authenticated request.
  // Identity comes exclusively from AuthContext (populated by requireAuth);
  // no request-supplied identifier is trusted. PostgreSQL is authoritative
  // for current user state — a valid JWT whose subject no longer exists
  // fails as an authentication error, not a fabricated user.
  app.get(
    '/api/v1/auth/me',
    {
      preHandler: [requireAuth],
      schema: {
        response: { 200: { ...PUBLIC_USER_JSON_SCHEMA, description: 'Current user.' } },
        tags: ['Auth'],
        summary: 'Get the current user',
        description:
          'Returns the persisted user for the authenticated request. Identity comes from the access token only; a valid token whose subject no longer exists is 401.',
        operationId: 'getCurrentUser',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
const authContext = request.auth as AuthContext;

const user = await authService.getCurrentUser(authContext.sub);

return reply.status(200).send(user);
  });

  // POST /api/v1/auth/refresh
  //
  // Exchanges the refresh-token cookie for a new access JWT plus a successor
  // refresh credential (rotation). Deliberately NOT protected by requireAuth:
  // requiring an access token to refresh would defeat the purpose of refresh.
  // The ONLY accepted credential is the refresh-token cookie — bearer tokens
  // are never honored here.
  //
  // The presented credential is consumed exactly once; the successor cookie
  // is set only after the rotation transaction commits. A consumed credential
  // presented again is replay: the family is invalidated and the request
  // fails closed (ADR-008).
  app.post(
    '/api/v1/auth/refresh',
    {
      schema: {
        response: { 200: { ...accessTokenResponseSchema, description: 'Newly issued access token.' } },
        tags: ['Auth'],
        summary: 'Refresh the access token',
        description:
          'Consumes the refresh-token cookie exactly once and returns a new access token (rotating the refresh credential). Bearer tokens are never honored here; replay invalidates the family (401).',
        operationId: 'refreshAccessToken',
        security: [],
      },
    },
    async (request, reply) => {
const rawRefreshToken = request.cookies?.[config.auth.refreshCookie.name];

const result = await authService.refreshAccessToken(app, rawRefreshToken, {
  securityEventLogger: request.log,
});

if (config.auth.cookie.enabled) {
  // Replacement refresh cookie. Max-Age tracks the successor's
  // remaining server-side lifetime (absolute session boundary), never
  // a fresh TTL — rotation must not extend the credential lifetime.
  const remainingSeconds = Math.max(
    1,
    Math.floor((result.refreshExpiresAt.getTime() - Date.now()) / 1000),
  );
  reply.setCookie(config.auth.refreshCookie.name, result.refreshToken, {
    httpOnly: config.auth.refreshCookie.httpOnly,
    secure: config.auth.refreshCookie.secure,
    sameSite: config.auth.refreshCookie.sameSite,
    path: config.auth.refreshCookie.path,
    maxAge: remainingSeconds,
  });

  // Renew the access cookie alongside: HttpOnly browser clients cannot
  // read the JSON body into their access cookie themselves.
  reply.setCookie(config.auth.cookie.name, result.accessToken, {
    httpOnly: config.auth.cookie.httpOnly,
    secure: config.auth.cookie.secure,
    sameSite: config.auth.cookie.sameSite,
    path: config.auth.cookie.path,
    maxAge: config.auth.accessTokenTtlSeconds,
  });
}

return reply.status(200).send({ accessToken: result.accessToken });
  });

  // POST /api/v1/auth/password-reset/request
  //
  // Starts password recovery. The response is identical whether the email
  // belongs to an active account or not: no account existence, delivery, or
  // token state is revealed. Only active accounts receive a credential.
  app.post(
    '/api/v1/auth/password-reset/request',
    {
      schema: {
        ...passwordResetRequestSchema,
        tags: ['Auth'],
        summary: 'Request a password reset',
        description:
          'Starts recovery with an oracle-free 204: identical response whether or not the email belongs to an account. Throttled (429).',
        operationId: 'requestPasswordReset',
        security: [],
      },
    },
    async (request, reply) => {
const { email } = request.body as { email: string };

// Socket-derived source address feeds the recovery throttle's IP
// dimension (M5.4). No forwarded header is consulted: with no
// trusted-proxy configuration, X-Forwarded-For is client-controlled
// and must never select the throttle key (same contract as login).
// M11.3 wiring: composed domain mailer; the credential commits before the
// send, and a delivery failure stays a sanitized 5xx with the persisted
// credential still usable for a retry (unchanged M3 semantics).
await authService.requestPasswordReset(email, request.ip, authEmailMailers.passwordReset);

// Observational only: enumeration-safe by construction — the service
// resolves unknown and known addresses identically, so this event carries
// no account identifier of any kind.
emitAuthSecurityEvent(request.log, {
  event: AuthSecurityEventName.PASSWORD_RESET_REQUESTED,
  outcome: 'requested',
});

return reply.status(204).send();
    },
  );

  // POST /api/v1/auth/password-reset/confirm
  //
  // Completes password recovery from a reset credential. The token row is
  // authoritative for the target user — no request-supplied identity is
  // accepted. Success atomically consumes the credential, updates the
  // password, and revokes all sessions. Every credential failure produces
  // the same generic authentication failure.
  app.post(
    '/api/v1/auth/password-reset/confirm',
    {
      schema: {
        ...passwordResetConfirmSchema,
        tags: ['Auth'],
        summary: 'Confirm a password reset',
        description:
          'Consumes the reset credential, updates the password, and revokes all sessions. Credential failures return a generic 401.',
        operationId: 'confirmPasswordReset',
        security: [],
      },
    },
    async (request, reply) => {
const { token, password } = request.body as { token: string; password: string };

await authService.resetPassword(token, password, {
  securityEventLogger: request.log,
  // M11.3 wiring: post-commit, best-effort password-change notice.
  securityNotificationMailer: authEmailMailers.securityNotification,
  securityNotificationLogger: request.log,
});

return reply.status(204).send();
    },
  );

  // POST /api/v1/auth/email-verification/resend
  //
  // Sends (or re-sends) a verification message. The response is identical
  // whether the email belongs to an unverified active account or not: no
  // account existence, verification status, or token state is revealed.
  // Already-verified accounts receive nothing further.
  app.post(
    '/api/v1/auth/email-verification/resend',
    {
      schema: {
        ...emailVerificationResendSchema,
        tags: ['Auth'],
        summary: 'Resend the verification email',
        description:
          'Oracle-free 204: identical response whether or not the email belongs to an unverified account. Throttled (429).',
        operationId: 'resendVerificationEmail',
        security: [],
      },
    },
    async (request, reply) => {
const { email } = request.body as { email: string };

// Same socket-IP contract as password-reset request (M5.4).
// M11.3 wiring: composed domain mailer; enumeration-safe 204 unchanged.
await authService.resendVerificationEmail(
  email,
  request.ip,
  authEmailMailers.emailVerification,
);

// Observational only: same enumeration-safe discipline as password-reset
// request — no account identifier.
emitAuthSecurityEvent(request.log, {
  event: AuthSecurityEventName.EMAIL_VERIFICATION_REQUESTED,
  outcome: 'requested',
});

return reply.status(204).send();
    },
  );

  // POST /api/v1/auth/email-verification/confirm
  //
  // Proves control of an email address from a verification credential. The
  // token row is authoritative for the target user — no request-supplied
  // identity is accepted. Success atomically consumes the credential and
  // stamps verification; it creates no session, issues no token, and revokes
  // nothing. Every credential failure produces the same generic
  // authentication failure.
  app.post(
    '/api/v1/auth/email-verification/confirm',
    {
      schema: {
        ...emailVerificationConfirmSchema,
        tags: ['Auth'],
        summary: 'Confirm email verification',
        description:
          'Proves email control from the verification credential. Creates no session and revokes nothing. Credential failures return a generic 401.',
        operationId: 'confirmEmailVerification',
        security: [],
      },
    },
    async (request, reply) => {
const { token } = request.body as { token: string };

await authService.confirmEmailVerification(token, { securityEventLogger: request.log });

return reply.status(204).send();
    },
  );

  // POST /api/v1/auth/sessions/revoke-all
  //
  // Revokes every live session owned by the authenticated user. Identity
  // comes exclusively from AuthContext — no request-supplied user, session,
  // or email is read, so cross-user targeting is structurally impossible.
  // No request body is required or interpreted; the operation is idempotent
  // (zero sessions and already-revoked sessions succeed silently) and
  // returns no session metadata. Already-issued access JWTs drain naturally.
  app.post(
    '/api/v1/auth/sessions/revoke-all',
    {
      preHandler: [requireAuth],
      schema: {
        tags: ['Auth'],
        summary: 'Revoke all sessions of the current user',
        description:
          'Revokes every live session owned by the authenticated user. Identity comes exclusively from the access token, so cross-user targeting is impossible. Idempotent 204.',
        operationId: 'revokeAllSessions',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
const authContext = request.auth as AuthContext;

const { revoked } = await authService.revokeAllSessions(authContext.sub);

// Observational only: the count distinguishes a real revocation from a
// no-op call and is operator-side only (never in the 204 response).
emitAuthSecurityEvent(request.log, {
  event: AuthSecurityEventName.SESSIONS_REVOKED_ALL,
  outcome: 'revoked',
  subjectId: authContext.sub,
  revokedCount: revoked,
});

if (config.auth.cookie.enabled) {
  reply.clearCookie(config.auth.cookie.name, {
    path: config.auth.cookie.path,
  });
  reply.clearCookie(config.auth.refreshCookie.name, {
    path: config.auth.refreshCookie.path,
  });
}

return reply.status(204).send();
  });
}
