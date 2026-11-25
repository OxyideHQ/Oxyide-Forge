import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

// Mock auth service
const mockRegister = vi.fn();
const mockLogin = vi.fn();
const mockGetCurrentUser = vi.fn();
const mockRefreshAccessToken = vi.fn();
const mockLogout = vi.fn();
const mockRevokeAllSessions = vi.fn();
const mockRequestPasswordReset = vi.fn();
const mockResetPassword = vi.fn();
const mockResendVerificationEmail = vi.fn();

vi.mock('../services/auth.service.js', () => ({
  authService: {
    register: mockRegister,
    login: mockLogin,
    getCurrentUser: mockGetCurrentUser,
    refreshAccessToken: mockRefreshAccessToken,
    logout: mockLogout,
    requestPasswordReset: mockRequestPasswordReset,
    resetPassword: mockResetPassword,
    resendVerificationEmail: mockResendVerificationEmail,
    revokeAllSessions: mockRevokeAllSessions,
  },
}));

// Mock users service for the requireAuth subject-existence contract (M4.6)
const mockFindById = vi.fn();

vi.mock('../../users/users.service.js', () => ({
  usersService: {
    findById: mockFindById,
  },
}));

const { registerAuthRoutes } = await import('./auth.routes.js');
const { authEmailMailers } = await import('../email/auth-email-composition.js');
const { cookiePlugin } = await import('../../../plugins/cookie.plugin.js');
const { authPlugin } = await import('../../../plugins/auth.plugin.js');

/**
 * Normalizes a Set-Cookie header (string or string array) for substring assertions.
 */
function setCookieText(header: string | string[] | undefined): string {
  if (Array.isArray(header)) return header.join('; ');
  return header ?? '';
}

const { registerGlobalErrorHandler } = await import('../../../app/app.js');

describe('authRoutes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default guard-lookup subject (M4.6 subject-existence contract).
    mockFindById.mockResolvedValue({ id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T' });

    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    await app.register(cookiePlugin);
    await app.register(authPlugin);
    await app.register(registerAuthRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /api/v1/auth/register', () => {
    const mockUser = {
      id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      email: 'alice@example.com',
      displayName: 'Alice',
      status: 'active',
      role: 'user',
      createdAt: '2026-01-15T09:30:00.000Z',
      updatedAt: '2026-01-15T09:30:00.000Z',
    };

    it('returns 201 with PublicUser on valid registration', async () => {
      mockRegister.mockResolvedValueOnce(mockUser);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
          displayName: 'Alice',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toEqual(mockUser);
      // M11.3: the route injects the composed verification mailer. The
      // assertion pins the injection itself — a route that dropped it would
      // silently fall back to the NoOp default and never email a user.
      expect(mockRegister).toHaveBeenCalledWith(
        {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
          displayName: 'Alice',
        },
        authEmailMailers.emailVerification,
      );
    });

    it('response contains only PublicUser fields', async () => {
      mockRegister.mockResolvedValueOnce(mockUser);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      const keys = Object.keys(body).sort();
      expect(keys).toEqual(['createdAt', 'displayName', 'email', 'id', 'role', 'status', 'updatedAt']);
    });

    it('does not return an access token', async () => {
      mockRegister.mockResolvedValueOnce(mockUser);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.accessToken).toBeUndefined();
      expect(body.token).toBeUndefined();
    });

    it('does not set a cookie', async () => {
      mockRegister.mockResolvedValueOnce(mockUser);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('returns 409 with USERS_EMAIL_TAKEN for duplicate email', async () => {
      const { AppError } = await import('../../../shared/errors/app-error.js');
      const { ErrorCodes } = await import('../../../shared/errors/error-codes.js');
      mockRegister.mockRejectedValueOnce(
        new AppError(ErrorCodes.USERS_EMAIL_TAKEN, 409, 'A user with this email already exists.'),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'existing@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.code).toBe('USERS_EMAIL_TAKEN');
      expect(body.status).toBe(409);
    });

    it('returns 400 for password shorter than 12 characters', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'alice@example.com',
          password: 'short',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 for password longer than the 72-byte bcrypt bound (M3.18 F-2)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'alice@example.com',
          password: `${'long-password-'.repeat(5)}123456789012`,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(mockRegister).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid request body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'not-an-email',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 for missing required fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'alice@example.com',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/auth/login', () => {
    const mockLoginResult = {
      accessToken: 'mock-jwt-token',
      refreshToken: 'mock-refresh-token-value',
      user: {
        id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
        email: 'alice@example.com',
        displayName: 'Alice',
        status: 'active',
        role: 'user',
        createdAt: '2026-01-15T09:30:00.000Z',
        updatedAt: '2026-01-15T09:30:00.000Z',
      },
    };

    it('returns 200 with accessToken for non-browser login', async () => {
      mockLogin.mockResolvedValueOnce(mockLoginResult);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          accept: 'application/json',
        },
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.accessToken).toBe('mock-jwt-token');
      expect(body.user).toBeUndefined();
      expect(body.refreshToken).toBeUndefined();
    });

    it('never serializes the refresh credential into the JSON body', async () => {
      mockLogin.mockResolvedValue(mockLoginResult);

      const browserResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          accept: 'text/html,application/xhtml+xml',
        },
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      const apiResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          accept: 'application/json',
        },
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(browserResponse.statusCode).toBe(200);
      expect(apiResponse.statusCode).toBe(200);
      expect(JSON.stringify(browserResponse.json())).not.toContain('mock-refresh-token-value');
      expect(JSON.stringify(apiResponse.json())).not.toContain('mock-refresh-token-value');
    });

    it('returns 200 with PublicUser for browser login', async () => {
      mockLogin.mockResolvedValueOnce(mockLoginResult);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          accept: 'text/html,application/xhtml+xml',
        },
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(mockLoginResult.user.id);
      expect(body.email).toBe(mockLoginResult.user.email);
      expect(body.accessToken).toBeUndefined();
    });

    it('sets accessToken cookie for browser login', async () => {
      mockLogin.mockResolvedValueOnce(mockLoginResult);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          accept: 'text/html,application/xhtml+xml',
        },
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(200);
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();
      const setCookie = setCookieText(setCookieHeader);
      expect(setCookie).toContain('accessToken=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Path=/');
      expect(setCookie).toContain('SameSite=Strict');
      expect(setCookie).toContain('Max-Age=900');
    });

    it('sets a distinct refreshToken cookie for browser login', async () => {
      mockLogin.mockResolvedValueOnce(mockLoginResult);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          accept: 'text/html,application/xhtml+xml',
        },
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(200);
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();
      const setCookie = setCookieText(setCookieHeader);
      expect(setCookie).toContain('refreshToken=mock-refresh-token-value');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Path=/api/v1/auth/refresh');
      expect(setCookie).toContain('SameSite=Strict');
      // The refresh cookie never reuses the access-token cookie name or value.
      expect(setCookie).not.toContain('accessToken=mock-refresh-token-value');
    });

    it('does not set cookie for non-browser login', async () => {
      mockLogin.mockResolvedValueOnce(mockLoginResult);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          accept: 'application/json',
        },
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('returns 401 with AUTH_INVALID_CREDENTIALS for wrong password', async () => {
      const { AppError } = await import('../../../shared/errors/app-error.js');
      const { ErrorCodes } = await import('../../../shared/errors/error-codes.js');
      mockLogin.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_CREDENTIALS, 401, 'The email or password is incorrect.'),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'alice@example.com',
          password: 'wrong-password',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(body.status).toBe(401);
    });

    it('returns 401 with AUTH_INVALID_CREDENTIALS for unknown email', async () => {
      const { AppError } = await import('../../../shared/errors/app-error.js');
      const { ErrorCodes } = await import('../../../shared/errors/error-codes.js');
      mockLogin.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_CREDENTIALS, 401, 'The email or password is incorrect.'),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'unknown@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('invalid credentials expose the same error shape', async () => {
      const { AppError } = await import('../../../shared/errors/app-error.js');
      const { ErrorCodes } = await import('../../../shared/errors/error-codes.js');

      // Wrong password
      mockLogin.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_CREDENTIALS, 401, 'The email or password is incorrect.'),
      );
      const response1 = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'alice@example.com', password: 'wrong' },
      });

      // Unknown email
      mockLogin.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_CREDENTIALS, 401, 'The email or password is incorrect.'),
      );
      const response2 = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'unknown@example.com', password: 'correct' },
      });

      expect(response1.statusCode).toBe(401);
      expect(response2.statusCode).toBe(401);
      expect(response1.json().code).toBe(response2.json().code);
      expect(response1.json().detail).toBe(response2.json().detail);
    });

    it('does not expose password hash', async () => {
      mockLogin.mockResolvedValueOnce(mockLoginResult);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'alice@example.com',
          password: 'correct-horse-battery-staple',
        },
      });

      const body = response.json();
      const bodyStr = JSON.stringify(body);
      expect(bodyStr).not.toContain('passwordHash');
      expect(bodyStr).not.toContain('$2b$');
    });

    it('returns 400 for invalid request body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'not-an-email',
          password: 'correct-horse-battery-staple',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 for missing required fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'alice@example.com',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('returns 204 with empty body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
    });

    it('clears the accessToken cookie', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
      });

      expect(response.statusCode).toBe(204);
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();
      const setCookie = setCookieText(setCookieHeader);
      expect(setCookie).toContain('accessToken=');
      expect(setCookie).toContain('Path=/');
    });

    it('clears the refreshToken cookie with its scoped path', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
      });

      expect(response.statusCode).toBe(204);
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();
      const setCookie = setCookieText(setCookieHeader);
      expect(setCookie).toContain('refreshToken=');
      expect(setCookie).toContain('Path=/api/v1/auth/refresh');
    });

    it('works without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        // No authorization header
      });

      expect(response.statusCode).toBe(204);
    });

    it('does not require a request body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
      });

      expect(response.statusCode).toBe(204);
    });

    it('revokes the session for the presented refresh cookie and still returns 204', async () => {
      mockLogout.mockResolvedValueOnce({ revoked: true });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: {
          cookie: 'refreshToken=live-raw-token',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(mockLogout).toHaveBeenCalledWith('live-raw-token');
      const setCookie = setCookieText(response.headers['set-cookie']);
      expect(setCookie).toContain('refreshToken=');
      expect(setCookie).toContain('accessToken=');
    });

    it('skips revocation without a refresh cookie and still returns 204', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
      });

      expect(response.statusCode).toBe(204);
      expect(mockLogout).not.toHaveBeenCalled();
    });

    it('returns 500 instead of a false 204 when revocation fails', async () => {
      mockLogout.mockRejectedValueOnce(new Error('connection terminated'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: {
          cookie: 'refreshToken=live-raw-token',
        },
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    const mockRotationResult = {
      accessToken: 'new-access-jwt',
      refreshToken: 'successor-raw-token',
      refreshExpiresAt: new Date(Date.now() + 6 * 24 * 3600_000),
    };

    it('returns 200 with a new access token for a valid refresh cookie', async () => {
      mockRefreshAccessToken.mockResolvedValueOnce(mockRotationResult);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: {
          cookie: 'refreshToken=valid-raw-refresh-token',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accessToken: 'new-access-jwt' });
      expect(mockRefreshAccessToken).toHaveBeenCalledWith(
        expect.anything(),
        'valid-raw-refresh-token',
        // M8.3: routes bind the observational security-event sink.
        expect.objectContaining({ securityEventLogger: expect.anything() }),
      );
      expect(response.headers['content-type']).toContain('application/json');
    });

    it('sets the successor refresh cookie and renews the access cookie', async () => {
      mockRefreshAccessToken.mockResolvedValueOnce(mockRotationResult);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: {
          cookie: 'refreshToken=valid-raw-refresh-token',
        },
      });

      expect(response.statusCode).toBe(200);
      const setCookie = setCookieText(response.headers['set-cookie']);
      expect(setCookie).toContain('refreshToken=successor-raw-token');
      expect(setCookie).toContain('Path=/api/v1/auth/refresh');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('accessToken=new-access-jwt');
      // The presented credential is never reissued.
      expect(setCookie).not.toContain('valid-raw-refresh-token');
      expect(JSON.stringify(response.json())).not.toContain('successor-raw-token');
    });

    it('returns 401 with AUTH_INVALID_TOKEN when the refresh cookie is missing', async () => {
      const { AppError } = await import('../../../shared/errors/app-error.js');
      const { ErrorCodes } = await import('../../../shared/errors/error-codes.js');
      mockRefreshAccessToken.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 401, 'The refresh credential is invalid or has expired.'),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
    });

    it('returns the service authentication failure without leaking details', async () => {
      const { AppError } = await import('../../../shared/errors/app-error.js');
      const { ErrorCodes } = await import('../../../shared/errors/error-codes.js');
      mockRefreshAccessToken.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 401, 'The refresh credential is invalid or has expired.'),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: {
          cookie: 'refreshToken=unknown-token-value',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.code).toBe('AUTH_INVALID_TOKEN');
      expect(JSON.stringify(body)).not.toContain('unknown-token-value');
    });

    it('does not accept a bearer token as a refresh credential', async () => {
      mockRefreshAccessToken.mockImplementationOnce(async (_app: unknown, raw: unknown) => {
        expect(raw).toBeUndefined();
        const { AppError } = await import('../../../shared/errors/app-error.js');
        const { ErrorCodes } = await import('../../../shared/errors/error-codes.js');
        throw new AppError(
          ErrorCodes.AUTH_INVALID_TOKEN,
          401,
          'The refresh credential is invalid or has expired.',
        );
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: {
          authorization: 'Bearer some-access-jwt',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
    });

    it('does not accept the accessToken cookie as a refresh credential', async () => {
      const { AppError } = await import('../../../shared/errors/app-error.js');
      const { ErrorCodes } = await import('../../../shared/errors/error-codes.js');
      mockRefreshAccessToken.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 401, 'The refresh credential is invalid or has expired.'),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: {
          cookie: 'accessToken=some-access-jwt',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(mockRefreshAccessToken).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        // M8.3: routes bind the observational security-event sink.
        expect.objectContaining({ securityEventLogger: expect.anything() }),
      );
    });

    it('requires no request body', async () => {
      mockRefreshAccessToken.mockResolvedValueOnce(mockRotationResult);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: {
          cookie: 'refreshToken=valid-raw-refresh-token',
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('emits no successor cookie when rotation fails', async () => {
      const { AppError } = await import('../../../shared/errors/app-error.js');
      const { ErrorCodes } = await import('../../../shared/errors/error-codes.js');
      mockRefreshAccessToken.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 401, 'The refresh credential is invalid or has expired.'),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: {
          cookie: 'refreshToken=stale-token-value',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('lets unexpected failures propagate instead of converting them to 401', async () => {
      mockRefreshAccessToken.mockRejectedValueOnce(new Error('connection terminated'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: {
          cookie: 'refreshToken=valid-raw-refresh-token',
        },
      });

      // Thrown through to the global handler's sanitized 5xx contract —
      // an outage must never masquerade as an authentication failure.
      expect(response.statusCode).toBe(500);
    });
  });

  describe('POST /api/v1/auth/password-reset/request', () => {
    it('returns 204 with an empty body and reveals nothing', async () => {
      mockRequestPasswordReset.mockResolvedValueOnce(undefined);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        payload: { email: 'alice@example.com' },
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      // The route wires the socket-derived source IP into the recovery
      // throttle (M5.4): inject defaults to 127.0.0.1.
      // M11.3: the composed recovery mailer is injected as the third argument
      // (identity-checked, not shape-checked, so a rewritten composition
      // module cannot silently satisfy this assertion).
      expect(mockRequestPasswordReset).toHaveBeenCalledWith(
        'alice@example.com',
        '127.0.0.1',
        authEmailMailers.passwordReset,
      );
    });

    it('returns 400 for a missing email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(mockRequestPasswordReset).not.toHaveBeenCalled();
    });

    it('returns 400 for a malformed email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        payload: { email: 'not-an-email' },
      });

      expect(response.statusCode).toBe(400);
      expect(mockRequestPasswordReset).not.toHaveBeenCalled();
    });

    it('propagates unexpected failures instead of masking them', async () => {
      mockRequestPasswordReset.mockRejectedValueOnce(new Error('connection terminated'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        payload: { email: 'alice@example.com' },
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('POST /api/v1/auth/password-reset/confirm', () => {
    it('returns 204 with an empty body on success', async () => {
      mockResetPassword.mockResolvedValueOnce(undefined);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token: 'valid-raw-token', password: 'new-strong-password' },
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(mockResetPassword).toHaveBeenCalledWith(
        'valid-raw-token',
        'new-strong-password',
        // M8.3: routes bind the observational security-event sink.
        expect.objectContaining({ securityEventLogger: expect.anything() }),
      );
    });

    it('returns the generic 401 without leaking token state', async () => {
      const { AppError } = await import('../../../shared/errors/app-error.js');
      const { ErrorCodes } = await import('../../../shared/errors/error-codes.js');
      mockResetPassword.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 401, 'The reset token is invalid or has expired.'),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token: 'unknown-token-value', password: 'new-strong-password' },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.code).toBe('AUTH_INVALID_TOKEN');
      expect(JSON.stringify(body)).not.toContain('unknown-token-value');
    });

    it('returns 400 for a short password', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token: 'valid-raw-token', password: 'short' },
      });

      expect(response.statusCode).toBe(400);
      expect(mockResetPassword).not.toHaveBeenCalled();
    });

    it('returns 400 for a password longer than the 72-byte bcrypt bound (M3.18 F-2)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token: 'valid-raw-token', password: `${'long-password-'.repeat(5)}123456789012` },
      });

      expect(response.statusCode).toBe(400);
      expect(mockResetPassword).not.toHaveBeenCalled();
    });

    it('returns 400 for missing fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token: 'valid-raw-token' },
      });

      expect(response.statusCode).toBe(400);
      expect(mockResetPassword).not.toHaveBeenCalled();
    });

    it('propagates unexpected failures instead of converting them to 401', async () => {
      mockResetPassword.mockRejectedValueOnce(new Error('connection terminated'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token: 'valid-raw-token', password: 'new-strong-password' },
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('POST /api/v1/auth/sessions/revoke-all', () => {
    const userId = 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T';

    function bearerToken(sub: string): string {
      return app.jwt.sign({ sub });
    }

    it('returns 204 and revokes via the authenticated subject', async () => {
      mockRevokeAllSessions.mockResolvedValueOnce({ revoked: 2 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
        headers: { authorization: `Bearer ${bearerToken(userId)}` },
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(mockRevokeAllSessions).toHaveBeenCalledWith(userId);
    });

    it('works with cookie access authentication', async () => {
      mockRevokeAllSessions.mockResolvedValueOnce({ revoked: 1 });
      const token = app.jwt.sign({ sub: userId }, { expiresIn: 900 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
        headers: { cookie: `accessToken=${token}` },
      });

      expect(response.statusCode).toBe(204);
      expect(mockRevokeAllSessions).toHaveBeenCalledWith(userId);
    });

    it('ignores request-supplied identities and body parameters', async () => {
      mockRevokeAllSessions.mockResolvedValueOnce({ revoked: 0 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all?userId=u_victim00000000000000000000',
        headers: { authorization: `Bearer ${bearerToken(userId)}` },
        payload: { userId: 'u_victim00000000000000000000', email: 'victim@example.com' },
      });

      expect(response.statusCode).toBe(204);
      expect(mockRevokeAllSessions).toHaveBeenCalledWith(userId);
      expect(mockRevokeAllSessions).not.toHaveBeenCalledWith(
        expect.stringContaining('victim'),
      );
    });

    it('returns 204 with an empty body and no session metadata', async () => {
      mockRevokeAllSessions.mockResolvedValueOnce({ revoked: 5 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
        headers: { authorization: `Bearer ${bearerToken(userId)}` },
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
    });

    it('returns 401 without authentication and never reaches the service', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
      });

      expect(response.statusCode).toBe(401);
      expect(mockRevokeAllSessions).not.toHaveBeenCalled();
    });

    it('returns 401 for a forged token and never reaches the service', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
        headers: { authorization: 'Bearer forged.invalid.token' },
      });

      expect(response.statusCode).toBe(401);
      expect(mockRevokeAllSessions).not.toHaveBeenCalled();
    });

    it('clears both cookies with matching attributes', async () => {
      mockRevokeAllSessions.mockResolvedValueOnce({ revoked: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
        headers: { authorization: `Bearer ${bearerToken(userId)}` },
      });

      expect(response.statusCode).toBe(204);
      const setCookie = setCookieText(response.headers['set-cookie']);
      expect(setCookie).toContain('accessToken=');
      expect(setCookie).toContain('Path=/');
      expect(setCookie).toContain('refreshToken=');
      expect(setCookie).toContain('Path=/api/v1/auth/refresh');
    });

    it('lets unexpected failures propagate instead of converting them to 204', async () => {
      mockRevokeAllSessions.mockRejectedValueOnce(new Error('connection terminated'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
        headers: { authorization: `Bearer ${bearerToken(userId)}` },
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('GET /api/v1/auth/me', () => {
    const mockUser = {
      id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      email: 'alice@example.com',
      displayName: 'Alice',
      status: 'active',
      role: 'user',
      createdAt: '2026-01-15T09:30:00.000Z',
      updatedAt: '2026-01-15T09:30:00.000Z',
    };

    function bearerToken(sub: string): string {
      return app.jwt.sign({ sub });
    }

    it('returns 200 with the current user for a valid bearer token', async () => {
      mockGetCurrentUser.mockResolvedValueOnce(mockUser);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${bearerToken(mockUser.id)}` },
      });

      expect(response.statusCode).toBe(200);
      expect(mockGetCurrentUser).toHaveBeenCalledWith(mockUser.id);
      expect(response.json()).toEqual(mockUser);
    });

    it('returns 401 without an authorization header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
      });

      expect(response.statusCode).toBe(401);
      expect(mockGetCurrentUser).not.toHaveBeenCalled();
    });

    it('returns 401 for a malformed bearer header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: 'NotBearer abc123' },
      });

      expect(response.statusCode).toBe(401);
      expect(mockGetCurrentUser).not.toHaveBeenCalled();
    });

    it('returns 401 for a malformed JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: 'Bearer not.a.jwt' },
      });

      expect(response.statusCode).toBe(401);
      expect(mockGetCurrentUser).not.toHaveBeenCalled();
    });

    it('returns 401 for an expired JWT', async () => {
      const expired = app.jwt.sign({ sub: mockUser.id }, { expiresIn: -1 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${expired}` },
      });

      expect(response.statusCode).toBe(401);
      expect(mockGetCurrentUser).not.toHaveBeenCalled();
    });

    it('returns 401 for a forged JWT signature', async () => {
      const parts = bearerToken(mockUser.id).split('.');
      const forged = `${parts[0]}.${parts[1]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${forged}` },
      });

      expect(response.statusCode).toBe(401);
      expect(mockGetCurrentUser).not.toHaveBeenCalled();
    });

    it('returns 401 with the canonical auth error when the user no longer exists', async () => {
      const { AppError } = await import('../../../shared/errors/app-error.js');
      const { ErrorCodes } = await import('../../../shared/errors/error-codes.js');
      mockGetCurrentUser.mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 401, 'Authenticated user does not exist.'),
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${bearerToken('u_deleteduser00000000000000000')}` },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.code).toBe('AUTH_INVALID_TOKEN');
      expect(body).not.toHaveProperty('passwordHash');
    });

    it('ignores query parameters and body for identity', async () => {
      mockGetCurrentUser.mockResolvedValueOnce(mockUser);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me?userId=u_someoneelse000000000000000',
        headers: { authorization: `Bearer ${bearerToken(mockUser.id)}` },
        payload: { userId: 'u_someoneelse000000000000000' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockGetCurrentUser).toHaveBeenCalledWith(mockUser.id);
      expect(response.json().id).toBe(mockUser.id);
    });

    it('returns no credential, token, or secret fields', async () => {
      mockGetCurrentUser.mockResolvedValueOnce(mockUser);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${bearerToken(mockUser.id)}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      for (const forbidden of [
        'passwordHash',
        'password',
        'credential',
        'Credential',
        'accessToken',
        'refreshToken',
        'token',
        'jwt',
        'secret',
      ]) {
        expect(body).not.toHaveProperty(forbidden);
      }
      expect(response.headers['content-type']).toContain('application/json');
    });
  });
  // M11.3: route-level wiring proof. These assert that the composed domain
  // mailers actually reach the services — a route that silently stopped
  // injecting one would leave the frozen NoOp default in place and deliver
  // nothing in production while every other test still passed.
  describe('M11.3 email wiring', () => {
    // Local fixtures: the registration/login fixtures above are scoped to their
    // own describes, and these cases only need any valid public shape.
    const wiringUser = {
      id: 'u_01HX9Z6Y7K8Q3V2N4M5P6R7S8T',
      email: 'alice@example.com',
      displayName: 'Alice',
      status: 'active',
      role: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const wiringLoginResult = {
      accessToken: 'mock-jwt-token',
      refreshToken: 'mock-refresh-token-value',
      user: wiringUser,
    };

    it('injects the verification mailer on registration', async () => {
      mockRegister.mockResolvedValueOnce(wiringUser);

      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'alice@example.com', password: 'correct-horse-battery-staple' },
      });

      expect(mockRegister.mock.calls[0]?.[1]).toBe(authEmailMailers.emailVerification);
    });

    it('injects the security-notification mailer and the request logger on login', async () => {
      mockLogin.mockResolvedValueOnce(wiringLoginResult);

      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'application/json' },
        payload: { email: 'alice@example.com', password: 'correct-horse-battery-staple' },
      });

      const options = mockLogin.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(options.securityNotificationMailer).toBe(authEmailMailers.securityNotification);
      expect(options.securityNotificationLogger).toBeDefined();
      // The M8.3 event sink is still bound — M11.3 adds to it, never replaces it.
      expect(options.securityEventLogger).toBeDefined();
    });

    it('injects the security-notification mailer on password reset completion', async () => {
      mockResetPassword.mockResolvedValueOnce(undefined);

      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token: 'valid-raw-token', password: 'new-strong-password' },
      });

      const options = mockResetPassword.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(options.securityNotificationMailer).toBe(authEmailMailers.securityNotification);
    });

    it('injects the verification mailer on verification resend', async () => {
      mockResendVerificationEmail.mockResolvedValueOnce(undefined);

      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/resend',
        payload: { email: 'alice@example.com' },
      });

      expect(mockResendVerificationEmail.mock.calls[0]?.[2]).toBe(
        authEmailMailers.emailVerification,
      );
    });
  });
});
