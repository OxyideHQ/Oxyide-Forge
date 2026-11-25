/**
 * 5.6G-7 — Authentication Integration Tests
 *
 * Tests the complete HTTP authentication flow through the real
 * Fastify application, routes, services, repositories, Prisma,
 * password hashing, JWT generation, and cookies.
 *
 * No mocks. Real database. Real HTTP requests via app.inject().
 *
 * These tests require a running PostgreSQL instance at DATABASE_URL.
 * When the database is unavailable, the suite fails fast instead of
 * silently passing.
 */

// Environment must be set before any module imports evaluate config.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('../../../app/app.js');
const { config } = await import('../../../config/index.js');
const { sessionService } = await import('../services/session.service.js');
const { refreshService } = await import('../services/refresh.service.js');

let app: FastifyInstance;
let dbAvailable = false;

const REGISTER_PAYLOAD = {
  email: 'integration@example.com',
  password: 'StrongPassword123!',
  displayName: 'Integration User',
};

async function cleanDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EmailVerificationToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "PasswordResetToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "RefreshToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Session" CASCADE');
  // Recovery-throttle buckets (M5.4) share the LoginThrottle table: truncate
  // for per-test isolation so one test's issuance volume never throttles
  // another test's requests.
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "LoginThrottle" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Credential" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
}

function parseSetCookie(setCookieHeader: string | string[] | undefined): string[] {
  if (!setCookieHeader) return [];
  return Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
}

/**
 * Serializes an error body with its per-occurrence `instance` removed
 * (M6.3): enumeration-parity comparisons must ignore the unique instance
 * ID, which carries no distinguishing signal by design.
 */
function parityBody(body: unknown): string {
  const record = body as Record<string, unknown>;
  expect(typeof record.instance).toBe('string');
  const { instance: _drop, ...rest } = record;
  void _drop;
  return JSON.stringify(rest);
}

function getCookieAttributes(setCookieHeader: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const parts = setCookieHeader.split(';').map((s) => s.trim());
  for (const part of parts) {
    const eqIndex = part.indexOf('=');
    if (eqIndex === -1) {
      attrs[part.toLowerCase()] = 'true';
    } else {
      attrs[part.slice(0, eqIndex).trim().toLowerCase()] = part.slice(eqIndex + 1).trim();
    }
  }
  return attrs;
}

beforeAll(async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run integration tests with NODE_ENV=production: suites truncate tables.',
    );
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    // Fail fast instead of silently passing: a missing database must be visible.
    throw new Error(
      'PostgreSQL unavailable: integration tests require a running database at DATABASE_URL.',
    );
  }

  app = await buildApp();

  // Register a test-only protected route for end-to-end tests.
  // Must be registered before app.ready() — Fastify 5 forbids adding
  // routes after the instance has started listening.
  app.get('/test/authenticated', { onRequest: [app.authenticate] }, async (request) => ({
    auth: request.auth,
  }));

  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await cleanDatabase();
});

afterAll(async () => {
  if (app) {
    await app.close();
  }
  await prisma.$disconnect();
});

// ────────────────────────────────────────────────────────
// 1. Registration
// ────────────────────────────────────────────────────────

describe('POST /api/v1/auth/register — integration', () => {
  it('returns 201 with a valid PublicUser representation', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: REGISTER_PAYLOAD,
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body).toEqual({
      id: expect.any(String) as string,
      email: 'integration@example.com',
      displayName: 'Integration User',
      status: 'active',
      role: 'user',
      createdAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
    });
  });

  it('returns only PublicUser fields — no password, hash, token, or credential', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: REGISTER_PAYLOAD,
    });

    const body = response.json();
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(['createdAt', 'displayName', 'email', 'id', 'role', 'status', 'updatedAt']);

    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('password');
    expect(bodyStr).not.toContain('passwordHash');
    expect(bodyStr).not.toContain('credential');
  });

  it('normalizes email to lowercase in the database', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { ...REGISTER_PAYLOAD, email: '  INTEGRATION@EXAMPLE.COM  ' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().email).toBe('integration@example.com');

    const user = await prisma.user.findUnique({ where: { email: 'integration@example.com' } });
    expect(user).not.toBeNull();
    expect(user!.email).toBe('integration@example.com');
  });

  it('persists the User and corresponding Credential in the database', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: REGISTER_PAYLOAD,
    });

    const { id } = response.json();

    const user = await prisma.user.findUnique({ where: { id } });
    expect(user).not.toBeNull();
    expect(user!.displayName).toBe('Integration User');
    expect(user!.status).toBe('active');

    const credential = await prisma.credential.findUnique({ where: { userId: id } });
    expect(credential).not.toBeNull();
    expect(credential!.userId).toBe(id);
    expect(credential!.passwordHash).not.toBe(REGISTER_PAYLOAD.password);
    expect(credential!.passwordHash.length).toBeGreaterThan(0);
  });

  it('does not create an accessToken cookie', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: REGISTER_PAYLOAD,
    });

    expect(response.statusCode).toBe(201);
    const cookies = parseSetCookie(response.headers['set-cookie']);
    expect(cookies).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────
// 2. Registration duplicate
// ────────────────────────────────────────────────────────

describe('POST /api/v1/auth/register — duplicate email', () => {
  it('returns 409 with USERS_EMAIL_TAKEN on the second registration', async () => {
    if (!dbAvailable) return;

    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: REGISTER_PAYLOAD });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: REGISTER_PAYLOAD,
    });

    expect(response.statusCode).toBe(409);

    const body = response.json();
    expect(body.code).toBe('USERS_EMAIL_TAKEN');
    expect(body.status).toBe(409);
    expect(body.type).toContain('users-email-taken');
    expect(body.title).toBeDefined();
    expect(body.detail).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────
// 3. Registration validation
// ────────────────────────────────────────────────────────

describe('POST /api/v1/auth/register — validation', () => {
  it('returns 400 when email is missing', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { password: 'StrongPassword123!' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'user@example.com' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when password is shorter than 12 characters', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'user@example.com', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when email format is invalid', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'not-an-email', password: 'StrongPassword123!' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when request body contains unknown properties', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'user@example.com', password: 'StrongPassword123!', unknown: true },
    });
    expect(response.statusCode).toBe(400);
  });
});

// ────────────────────────────────────────────────────────
// 4. Browser login
// ────────────────────────────────────────────────────────

describe('POST /api/v1/auth/login — browser', () => {
  beforeEach(async () => {
    if (!dbAvailable) return;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: REGISTER_PAYLOAD });
  });

  it('returns 200 with PublicUser and sets accessToken cookie', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: 'integration@example.com', password: 'StrongPassword123!' },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.email).toBe('integration@example.com');
    expect(body.displayName).toBe('Integration User');
    expect(body.status).toBe('active');
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
    expect(body.accessToken).toBeUndefined();

    const cookies = parseSetCookie(response.headers['set-cookie']);
    expect(cookies.length).toBeGreaterThanOrEqual(1);

    const accessTokenCookie = cookies.find((c) => c.startsWith('accessToken='));
    expect(accessTokenCookie).toBeDefined();

    const attrs = getCookieAttributes(accessTokenCookie!);
    expect(attrs['httponly']).toBe('true');
    expect(attrs['samesite']).toBe('Strict');
    expect(attrs['path']).toBe('/');
    expect(attrs['max-age']).toBe(String(config.auth.cookie.maxAge));
  });

  it('does not return password, hash, or accessToken in the response body', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: 'integration@example.com', password: 'StrongPassword123!' },
    });

    const bodyStr = JSON.stringify(response.json());
    expect(bodyStr).not.toContain('password');
    expect(bodyStr).not.toContain('passwordHash');
    expect(bodyStr).not.toContain('accessToken');
  });
});

// ────────────────────────────────────────────────────────
// 5. Non-browser login
// ────────────────────────────────────────────────────────

describe('POST /api/v1/auth/login — non-browser', () => {
  beforeEach(async () => {
    if (!dbAvailable) return;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: REGISTER_PAYLOAD });
  });

  it('returns 200 with accessToken and no cookie', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email: 'integration@example.com', password: 'StrongPassword123!' },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.accessToken).toBeDefined();
    expect(typeof body.accessToken).toBe('string');
    expect(body.accessToken.length).toBeGreaterThan(0);
    expect(body.user).toBeUndefined();

    const cookies = parseSetCookie(response.headers['set-cookie']);
    expect(cookies).toHaveLength(0);
  });

  it('returns a JWT that can be verified by the application', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email: 'integration@example.com', password: 'StrongPassword123!' },
    });

    const { accessToken } = response.json();

    // Verify the token structure (three dot-separated segments)
    const segments = accessToken.split('.');
    expect(segments).toHaveLength(3);

    // Verify the token can be decoded and contains the expected claims
    const payloadBytes = Buffer.from(segments[1], 'base64url');
    const payload = JSON.parse(payloadBytes.toString('utf-8'));
    expect(payload.sub).toBeDefined();
    expect(typeof payload.sub).toBe('string');
    expect(payload.iat).toBeDefined();
    expect(payload.exp).toBeDefined();
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('does not create an accessToken cookie', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email: 'integration@example.com', password: 'StrongPassword123!' },
    });

    const cookies = parseSetCookie(response.headers['set-cookie']);
    expect(cookies).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────
// 6. Invalid credentials
// ────────────────────────────────────────────────────────

describe('POST /api/v1/auth/login — invalid credentials', () => {
  beforeEach(async () => {
    if (!dbAvailable) return;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: REGISTER_PAYLOAD });
  });

  it('returns 401 for wrong password', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'integration@example.com', password: 'WrongPassword999!' },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(body.status).toBe(401);
  });

  it('returns 401 for unknown email', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nonexistent@example.com', password: 'StrongPassword123!' },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(body.status).toBe(401);
  });

  it('exposes the same error shape for wrong password and unknown email', async () => {
    if (!dbAvailable) return;

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'integration@example.com', password: 'WrongPassword999!' },
    });

    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nonexistent@example.com', password: 'StrongPassword123!' },
    });

    expect(wrongPassword.json().code).toBe(unknownEmail.json().code);
    expect(wrongPassword.json().detail).toBe(unknownEmail.json().detail);
    expect(wrongPassword.json().type).toBe(unknownEmail.json().type);
  });

  it('does not reveal whether the email exists', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nonexistent@example.com', password: 'StrongPassword123!' },
    });

    const bodyStr = JSON.stringify(response.json());
    expect(bodyStr).not.toContain('not found');
    expect(bodyStr).not.toContain('does not exist');
    expect(bodyStr).not.toContain('no user');
  });
});

// ────────────────────────────────────────────────────────
// 7. Logout
// ────────────────────────────────────────────────────────

describe('POST /api/v1/auth/logout', () => {
  it('returns 204 with empty body', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('clears the accessToken cookie', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });

    expect(response.statusCode).toBe(204);

    const cookies = parseSetCookie(response.headers['set-cookie']);
    expect(cookies.length).toBeGreaterThanOrEqual(1);

    const accessTokenCookie = cookies.find((c) => c.startsWith('accessToken='));
    expect(accessTokenCookie).toBeDefined();

    // Cleared cookie has empty value
    const cookieValue = accessTokenCookie!.split('=')[1].split(';')[0];
    expect(cookieValue).toBe('');

    const attrs = getCookieAttributes(accessTokenCookie!);
    expect(attrs['path']).toBe('/');
  });

  it('works without any authentication', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      // No authorization header, no cookie
    });

    expect(response.statusCode).toBe(204);
  });

  it('works when a stale cookie is present', async () => {
    if (!dbAvailable) return;

    // Simulate a stale cookie being present on the request
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { accessToken: 'stale-token-value' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });
});

// ────────────────────────────────────────────────────────
// 8. End-to-end authenticated request
// ────────────────────────────────────────────────────────

describe('end-to-end authentication flow', () => {
  it('register → login → use token on protected endpoint → logout', async () => {
    if (!dbAvailable) return;

    // Step 1: Register
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: REGISTER_PAYLOAD,
    });
    expect(registerResponse.statusCode).toBe(201);
    const registeredUser = registerResponse.json();
    expect(registeredUser.id).toBeDefined();

    // Step 2: Login (non-browser) to get access token
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email: 'integration@example.com', password: 'StrongPassword123!' },
    });
    expect(loginResponse.statusCode).toBe(200);
    const { accessToken } = loginResponse.json();

    // Step 3: Use the token on a protected endpoint
    const protectedResponse = await app.inject({
      method: 'GET',
      url: '/test/authenticated',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(protectedResponse.statusCode).toBe(200);
    const authCtx = protectedResponse.json().auth;
    expect(authCtx.sub).toBe(registeredUser.id);
    expect(typeof authCtx.iat).toBe('number');
    expect(typeof authCtx.exp).toBe('number');
    expect(authCtx.exp).toBeGreaterThan(authCtx.iat);

    // Step 4: Logout (browser-style to verify cookie clearing)
    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
    });
    expect(logoutResponse.statusCode).toBe(204);

    // Step 5: Verify the same token still works (stateless JWT — no revocation)
    const reVerifyResponse = await app.inject({
      method: 'GET',
      url: '/test/authenticated',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(reVerifyResponse.statusCode).toBe(200);
    expect(reVerifyResponse.json().auth.sub).toBe(registeredUser.id);
  });
});

// ────────────────────────────────────────────────────────
// 9. GET /api/v1/auth/me
// ────────────────────────────────────────────────────────

describe('GET /api/v1/auth/me — integration', () => {
  async function registerAndLogin(
    email = 'me@example.com',
  ): Promise<{ userId: string; accessToken: string }> {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email,
        password: 'StrongPassword123!',
        displayName: 'Me User',
      },
    });
    expect(registerResponse.statusCode).toBe(201);
    const registeredUser = registerResponse.json() as { id: string };

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'StrongPassword123!' },
    });
    expect(loginResponse.statusCode).toBe(200);
    const accessToken = (loginResponse.json() as { accessToken: string }).accessToken;
    expect(typeof accessToken).toBe('string');

    return { userId: registeredUser.id, accessToken };
  }

  it('returns 200 with the current PublicUser for a valid token', async () => {
    if (!dbAvailable) return;

    const { accessToken } = await registerAndLogin();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: expect.any(String) as string,
      email: 'me@example.com',
      displayName: 'Me User',
      status: 'active',
      role: 'user',
      createdAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
    });
  });

  it('exposes no credential, hash, token, or secret fields in the raw response', async () => {
    if (!dbAvailable) return;

    const { accessToken } = await registerAndLogin();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    const raw = response.body;
    for (const forbidden of [
      'passwordHash',
      'password',
      'credential',
      'Credential',
      'accessToken',
      'refreshToken',
      'secret',
      'jwt',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('returns 401 without authentication', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
    });

    expect(response.statusCode).toBe(401);
  });

  it('reflects current database state, not stale token data', async () => {
    if (!dbAvailable) return;

    const { userId, accessToken } = await registerAndLogin('fresh@example.com');

    await prisma.user.update({
      where: { id: userId },
      data: { displayName: 'Changed Name' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().displayName).toBe('Changed Name');
  });

  it('returns 401 AUTH_INVALID_TOKEN for a valid JWT whose user no longer exists', async () => {
    if (!dbAvailable) return;

    const { userId, accessToken } = await registerAndLogin('stale@example.com');

    // Remove the user directly (owned rows first: FKs are RESTRICT).
    const userSessions = await prisma.session.findMany({
      where: { userId },
      select: { id: true },
    });
    await prisma.refreshToken.deleteMany({
      where: { sessionId: { in: userSessions.map((s) => s.id) } },
    });
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.emailVerificationToken.deleteMany({ where: { userId } });
    await prisma.credential.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('AUTH_INVALID_TOKEN');

    // No user is recreated, no token is refreshed.
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
  });

  it('ignores request-supplied identity and uses AuthContext only', async () => {
    if (!dbAvailable) return;

    const { userId, accessToken } = await registerAndLogin('selfish@example.com');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me?userId=u_someoneelse000000000000000',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { userId: 'u_someoneelse000000000000000' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(userId);
    expect(response.json().email).toBe('selfish@example.com');
  });
});

// ────────────────────────────────────────────────────────
// 10. Cookie transport — end-to-end (M3.4)
// ────────────────────────────────────────────────────────

describe('cookie transport — end-to-end', () => {
  const COOKIE_EMAIL = 'cookie@example.com';

  async function browserLogin(): Promise<{ userId: string; cookieValue: string }> {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: COOKIE_EMAIL,
        password: 'StrongPassword123!',
        displayName: 'Cookie User',
      },
    });
    expect(registerResponse.statusCode).toBe(201);
    const userId = (registerResponse.json() as { id: string }).id;

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: COOKIE_EMAIL, password: 'StrongPassword123!' },
    });
    expect(loginResponse.statusCode).toBe(200);

    const cookies = parseSetCookie(loginResponse.headers['set-cookie']);
    const accessTokenCookie = cookies.find((c) => c.startsWith('accessToken='));
    expect(accessTokenCookie).toBeDefined();
    const cookieValue = accessTokenCookie!.split(';')[0].slice('accessToken='.length);
    expect(cookieValue.length).toBeGreaterThan(0);

    return { userId, cookieValue };
  }

  function cookieHeaders(cookieValue: string): Record<string, string> {
    return { cookie: `accessToken=${cookieValue}` };
  }

  it('authenticates /me with the login-issued cookie and no bearer header', async () => {
    if (!dbAvailable) return;

    const { userId, cookieValue } = await browserLogin();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieHeaders(cookieValue),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(userId);
    expect(body.email).toBe(COOKIE_EMAIL);
    expect(body.displayName).toBe('Cookie User');
  });

  it('issues a contract-complete cookie: HttpOnly, SameSite=Strict, Path=/, Max-Age=TTL, no Domain', async () => {
    if (!dbAvailable) return;

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: COOKIE_EMAIL,
        password: 'StrongPassword123!',
        displayName: 'Cookie User',
      },
    });

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: COOKIE_EMAIL, password: 'StrongPassword123!' },
    });
    expect(loginResponse.statusCode).toBe(200);

    const cookies = parseSetCookie(loginResponse.headers['set-cookie']);
    const accessTokenCookie = cookies.find((c) => c.startsWith('accessToken='));
    expect(accessTokenCookie).toBeDefined();
    const attrs = getCookieAttributes(accessTokenCookie!);
    expect(attrs['httponly']).toBe('true');
    expect(attrs['samesite']).toBe('Strict');
    expect(attrs['path']).toBe('/');
    // Lifetime derives from the access-token TTL, never an independent value.
    expect(attrs['max-age']).toBe(String(config.auth.accessTokenTtlSeconds));
    expect(accessTokenCookie!.toLowerCase()).not.toContain('domain=');
  });

  it('rejects a garbage cookie with the existing 401 contract', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieHeaders('garbage-token-value'),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('rejects bearer and cookie presented together', async () => {
    if (!dbAvailable) return;

    const { accessToken } = await (async () => {
      const registerResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'both@example.com', password: 'StrongPassword123!' },
      });
      expect(registerResponse.statusCode).toBe(201);
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'both@example.com', password: 'StrongPassword123!' },
      });
      return loginResponse.json() as { accessToken: string };
    })();
    const { cookieValue } = await browserLogin();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: {
        authorization: `Bearer ${accessToken}`,
        cookie: `accessToken=${cookieValue}`,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('keeps stale-user semantics identical over the cookie transport', async () => {
    if (!dbAvailable) return;

    const { userId, cookieValue } = await browserLogin();

    const userSessions = await prisma.session.findMany({
      where: { userId },
      select: { id: true },
    });
    await prisma.refreshToken.deleteMany({
      where: { sessionId: { in: userSessions.map((s) => s.id) } },
    });
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.emailVerificationToken.deleteMany({ where: { userId } });
    await prisma.credential.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieHeaders(cookieValue),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('logout with a valid cookie present clears it and stays 204', async () => {
    if (!dbAvailable) return;

    const { cookieValue } = await browserLogin();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: cookieHeaders(cookieValue),
    });

    expect(response.statusCode).toBe(204);
    const cookies = parseSetCookie(response.headers['set-cookie']);
    const cleared = cookies.find((c) => c.startsWith('accessToken='));
    expect(cleared).toBeDefined();
    expect(getCookieAttributes(cleared!)['path']).toBe('/');
  });
});

// ────────────────────────────────────────────────────────
// 11. Refresh tokens — issuance on login (M3.5)
// ────────────────────────────────────────────────────────

describe('login refresh issuance — integration', () => {
  const REFRESH_EMAIL = 'refresh-login@example.com';

  async function registerRefreshUser(): Promise<{ userId: string }> {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: REFRESH_EMAIL,
        password: 'StrongPassword123!',
        displayName: 'Refresh User',
      },
    });
    expect(registerResponse.statusCode).toBe(201);
    return { userId: (registerResponse.json() as { id: string }).id };
  }

  function loginCookies(setCookieHeader: string | string[] | undefined): {
    access: string | undefined;
    refresh: string | undefined;
  } {
    const cookies = parseSetCookie(setCookieHeader);
    const findValue = (name: string): string | undefined => {
      const match = cookies.find((c) => c.startsWith(`${name}=`));
      return match === undefined ? undefined : match.split(';')[0].slice(name.length + 1);
    };
    return { access: findValue('accessToken'), refresh: findValue('refreshToken') };
  }

  it('persists exactly one session and one hashed instance on browser login', async () => {
    if (!dbAvailable) return;
    const { userId } = await registerRefreshUser();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: REFRESH_EMAIL, password: 'StrongPassword123!' },
    });
    expect(loginResponse.statusCode).toBe(200);

    const { refresh } = loginCookies(loginResponse.headers['set-cookie']);
    expect(refresh).toBeDefined();

    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userId).toBe(userId);
    expect(sessions[0].expiresAt.getTime()).toBeGreaterThan(Date.now());

    const instances = await prisma.refreshToken.findMany({ where: { sessionId: sessions[0].id } });
    expect(instances).toHaveLength(1);
    expect(instances[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(instances[0].tokenHash).not.toBe(refresh);
  });

  it('stores the hash of the delivered credential — raw token recoverable only from the cookie', async () => {
    if (!dbAvailable) return;
    await registerRefreshUser();
    const { createHash } = await import('node:crypto');

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: REFRESH_EMAIL, password: 'StrongPassword123!' },
    });

    const { refresh } = loginCookies(loginResponse.headers['set-cookie']);
    const expectedHash = createHash('sha256').update(refresh!, 'utf8').digest('hex');
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: expectedHash } });
    expect(stored).not.toBeNull();
  });

  it('issues a contract-complete refresh cookie distinct from the access cookie', async () => {
    if (!dbAvailable) return;
    await registerRefreshUser();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: REFRESH_EMAIL, password: 'StrongPassword123!' },
    });

    const cookies = parseSetCookie(loginResponse.headers['set-cookie']);
    const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));
    expect(refreshCookie).toBeDefined();
    const attrs = getCookieAttributes(refreshCookie!);
    expect(attrs['httponly']).toBe('true');
    expect(attrs['samesite']).toBe('Strict');
    expect(attrs['path']).toBe('/api/v1/auth/refresh');
    expect(attrs['max-age']).toBe(String(config.auth.refreshTokenTtlSeconds));
    expect(refreshCookie!.toLowerCase()).not.toContain('domain=');
  });

  it('never returns the raw refresh credential in any JSON body', async () => {
    if (!dbAvailable) return;
    await registerRefreshUser();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: REFRESH_EMAIL, password: 'StrongPassword123!' },
    });

    const { refresh } = loginCookies(loginResponse.headers['set-cookie']);
    expect(loginResponse.body).not.toContain(refresh!);

    const apiLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email: REFRESH_EMAIL, password: 'StrongPassword123!' },
    });
    expect(apiLogin.json().refreshToken).toBeUndefined();
  });

  it('creates no session state when credentials are invalid', async () => {
    if (!dbAvailable) return;
    const { userId } = await registerRefreshUser();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email: REFRESH_EMAIL, password: 'WrongPassword123!' },
    });
    expect(loginResponse.statusCode).toBe(401);

    expect(await prisma.session.findMany({ where: { userId } })).toHaveLength(0);
    expect(await prisma.refreshToken.findMany()).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────
// 12. Refresh endpoint — rotation, replay, concurrency (M3.6)
// ────────────────────────────────────────────────────────

describe('POST /api/v1/auth/refresh — integration', () => {
  const REFRESH_FLOW_EMAIL = 'refresh-flow@example.com';

  async function loginForRefreshCookie(): Promise<{ userId: string; refreshCookie: string }> {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: REFRESH_FLOW_EMAIL,
        password: 'StrongPassword123!',
        displayName: 'Refresh Flow',
      },
    });
    expect(registerResponse.statusCode).toBe(201);
    const userId = (registerResponse.json() as { id: string }).id;

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: REFRESH_FLOW_EMAIL, password: 'StrongPassword123!' },
    });
    expect(loginResponse.statusCode).toBe(200);
    const cookies = parseSetCookie(loginResponse.headers['set-cookie']);
    const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));
    expect(refreshCookie).toBeDefined();

    return { userId, refreshCookie: refreshCookie!.split(';')[0] };
  }

  it('returns 200 with a usable access JWT for a valid refresh cookie', async () => {
    if (!dbAvailable) return;
    const { userId, refreshCookie } = await loginForRefreshCookie();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });

    expect(response.statusCode).toBe(200);
    const { accessToken } = response.json() as { accessToken: string };
    expect(typeof accessToken).toBe('string');
    expect(accessToken.split('.')).toHaveLength(3);

    // The new access token authenticates as the session owner.
    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json().id).toBe(userId);
  });

  it('rotates: consumes the old credential, issues a successor, and links the lineage', async () => {
    if (!dbAvailable) return;
    const { userId, refreshCookie } = await loginForRefreshCookie();
    const { createHash } = await import('node:crypto');
    const oldHash = createHash('sha256')
      .update(refreshCookie.slice('refreshToken='.length), 'utf8')
      .digest('hex');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });

    expect(response.statusCode).toBe(200);
    const { accessToken } = response.json() as { accessToken: string };
    expect(accessToken.split('.')).toHaveLength(3);

    // The new access token authenticates as the session owner.
    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json().id).toBe(userId);

    // Old instance consumed and linked; successor lives in the same family.
    const oldInstance = await prisma.refreshToken.findUnique({ where: { tokenHash: oldHash } });
    expect(oldInstance).not.toBeNull();
    expect(oldInstance!.consumedAt).not.toBeNull();
    expect(oldInstance!.supersededBy).not.toBeNull();

    const successors = await prisma.refreshToken.findMany({
      where: { sessionId: oldInstance!.sessionId },
    });
    expect(successors).toHaveLength(2);
    const successor = successors.find((s) => s.id === oldInstance!.supersededBy);
    expect(successor).toBeDefined();

    // Absolute session boundary preserved: successor expires with the session.
    const session = await prisma.session.findUnique({ where: { id: oldInstance!.sessionId } });
    expect(session).not.toBeNull();
    expect(successor!.expiresAt.getTime()).toBe(session!.expiresAt.getTime());

    // Successor hash matches the replacement cookie; raw values never persist.
    const setCookies = parseSetCookie(response.headers['set-cookie']);
    const newRefreshCookie = setCookies.find((c) => c.startsWith('refreshToken='));
    expect(newRefreshCookie).toBeDefined();
    const successorRaw = newRefreshCookie!.split(';')[0].slice('refreshToken='.length);
    expect(successorRaw).not.toBe(refreshCookie);
    expect(createHash('sha256').update(successorRaw, 'utf8').digest('hex')).toBe(
      successor!.tokenHash,
    );
    expect(JSON.stringify(response.json())).not.toContain(successorRaw);

    // Replacement cookie carries the successor's remaining lifetime with
    // intact security flags on the scoped path.
    const attrs = getCookieAttributes(newRefreshCookie!);
    expect(attrs['httponly']).toBe('true');
    expect(attrs['samesite']).toBe('Strict');
    expect(attrs['path']).toBe('/api/v1/auth/refresh');
    const maxAge = Number(attrs['max-age']);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(config.auth.refreshTokenTtlSeconds);
    expect(newRefreshCookie!.toLowerCase()).not.toContain('domain=');

    // The rotated access cookie is renewed alongside.
    const accessCookie = setCookies.find((c) => c.startsWith('accessToken='));
    expect(accessCookie).toBeDefined();
  });

  it('continues the chain: the successor refreshes, the consumed ancestor does not', async () => {
    if (!dbAvailable) return;
    const { refreshCookie } = await loginForRefreshCookie();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(first.statusCode).toBe(200);
    const successorCookie = parseSetCookie(first.headers['set-cookie']).find((c) =>
      c.startsWith('refreshToken='),
    )!;
    expect(successorCookie).toBeDefined();

    // Successor (chain tip) refreshes again.
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: successorCookie.split(';')[0] },
    });
    expect(second.statusCode).toBe(200);

    // Ancestor stays dead: replay invalidates rather than rotates.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('detects replay: reusing a consumed credential invalidates the whole family', async () => {
    if (!dbAvailable) return;
    const { refreshCookie } = await loginForRefreshCookie();

    // Rotate once: the presented credential is now consumed.
    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(rotated.statusCode).toBe(200);
    const successorCookie = parseSetCookie(rotated.headers['set-cookie']).find((c) =>
      c.startsWith('refreshToken='),
    )!.split(';')[0];

    // Replay the consumed ancestor: generic 401, no new access token, no
    // new successor — but the family dies.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('AUTH_INVALID_TOKEN');
    // Replay renders byte-identical to an unknown credential (no oracle).
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: 'refreshToken=bmV2ZXItZXhpc3RlZA' },
    });
    expect(parityBody(replay.json())).toBe(parityBody(unknown.json()));

    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].revokedAt).not.toBeNull();

    // The legitimate successor is dead with its family: family-level response,
    // not token-level rejection.
    const successorAttempt = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: successorCookie },
    });
    expect(successorAttempt.statusCode).toBe(401);
    expect(successorAttempt.json().code).toBe('AUTH_INVALID_TOKEN');

    // Exactly two instances exist: no replay-created successor.
    expect(await prisma.refreshToken.count()).toBe(2);
  });

  it('proves exactly-once consumption under genuine concurrent refresh', async () => {
    if (!dbAvailable) return;
    const { refreshCookie } = await loginForRefreshCookie();

    // Two requests dispatched without awaiting either first: both overlap in
    // the database transaction code, exercising row-level serialization.
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: refreshCookie } }),
      app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: refreshCookie } }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 401]);

    // Exactly one successor exists; the loser created nothing.
    expect(await prisma.refreshToken.count()).toBe(2);

    // The old token is consumed exactly once.
    const { createHash } = await import('node:crypto');
    const oldHash = createHash('sha256')
      .update(refreshCookie.slice('refreshToken='.length), 'utf8')
      .digest('hex');
    const oldInstance = await prisma.refreshToken.findUnique({ where: { tokenHash: oldHash } });
    expect(oldInstance).not.toBeNull();
    expect(oldInstance!.consumedAt).not.toBeNull();

    // The loser is treated as replay per ADR-008, so the family is revoked
    // and even the winner's successor is dead: fail closed, no silent fork.
    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].revokedAt).not.toBeNull();

    const winner = first.statusCode === 200 ? first : second;
    const winnerCookie = parseSetCookie(winner.headers['set-cookie']).find((c) =>
      c.startsWith('refreshToken='),
    )!.split(';')[0];
    const aftermatch = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: winnerCookie },
    });
    expect(aftermatch.statusCode).toBe(401);
  });

  it('leaves no partial state behind on invalid presentations', async () => {
    if (!dbAvailable) return;
    const { refreshCookie } = await loginForRefreshCookie();

    for (const headers of [
      {},
      { cookie: 'refreshToken=' },
      { cookie: 'refreshToken=not-a-credential' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers,
      });
      expect(response.statusCode).toBe(401);
    }
    // Nothing written: only the login instance exists.
    expect(await prisma.refreshToken.count()).toBe(1);

    // One legitimate rotation, then replay: still exactly one successor.
    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(rotated.statusCode).toBe(200);
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(replay.statusCode).toBe(401);
    expect(await prisma.refreshToken.count()).toBe(2);
  });

  it('rejects missing, empty, malformed, random, and expired credentials with one identical 401', async () => {
    if (!dbAvailable) return;
    const { refreshCookie } = await loginForRefreshCookie();

    // Expire the live instance server-side (cookie expiry alone is never trusted).
    const rawValue = refreshCookie.slice('refreshToken='.length);
    const { createHash } = await import('node:crypto');
    const liveHash = createHash('sha256').update(rawValue, 'utf8').digest('hex');
    const live = await prisma.refreshToken.findUnique({ where: { tokenHash: liveHash } });
    expect(live).not.toBeNull();
    await prisma.refreshToken.update({
      where: { id: live!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const attempts: Array<{ name: string; headers: Record<string, string> }> = [
      { name: 'missing', headers: {} },
      { name: 'empty', headers: { cookie: 'refreshToken=' } },
      { name: 'malformed', headers: { cookie: 'refreshToken=not-a-credential' } },
      {
        name: 'random',
        headers: {
          cookie: `refreshToken=${Buffer.from('random-unknown-credential-value').toString('base64url')}`,
        },
      },
      { name: 'expired', headers: { cookie: refreshCookie } },
    ];

    const bodies: string[] = [];
    for (const attempt of attempts) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: attempt.headers,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
      bodies.push(parityBody(response.json()));
    }

    // No existence oracle: every cause renders the identical body.
    for (const body of bodies) {
      expect(body).toBe(bodies[0]);
    }
  });

  it('rejects refresh for a deleted user and for a suspended user', async () => {
    if (!dbAvailable) return;
    const { userId, refreshCookie } = await loginForRefreshCookie();

    await prisma.user.update({ where: { id: userId }, data: { status: 'suspended' } });
    const suspendedResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(suspendedResponse.statusCode).toBe(401);
    expect(suspendedResponse.json().code).toBe('AUTH_INVALID_TOKEN');

    await prisma.refreshToken.deleteMany({
      where: { session: { userId } },
    });
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.emailVerificationToken.deleteMany({ where: { userId } });
    await prisma.credential.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });

    const deletedResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(deletedResponse.statusCode).toBe(401);
    expect(deletedResponse.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('never honors a bearer token on the refresh endpoint', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: 'Bearer some-access-jwt' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('never honors the accessToken cookie as a refresh credential', async () => {
    if (!dbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: 'accessToken=some-access-jwt' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('leaks no credential material in refresh failure bodies', async () => {
    if (!dbAvailable) return;
    const probe = 'probe-refresh-credential-value';

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `refreshToken=${probe}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(probe);
    expect(response.body).not.toContain('tokenHash');
  });
});

// ────────────────────────────────────────────────────────
// 13. Refresh logout semantics (M3.7: revocation)
// ────────────────────────────────────────────────────────

describe('refresh logout semantics — integration', () => {
  it('clears cookies and revokes the session so the credential stops refreshing', async () => {
    if (!dbAvailable) return;

    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'refresh-logout@example.com',
        password: 'StrongPassword123!',
        displayName: 'Refresh Logout',
      },
    });
    const userId = (registerResponse.json() as { id: string }).id;
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: 'refresh-logout@example.com', password: 'StrongPassword123!' },
    });
    const cookies = parseSetCookie(loginResponse.headers['set-cookie']);
    const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));
    expect(refreshCookie).toBeDefined();
    const cookiePair = refreshCookie!.split(';')[0];

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookiePair },
    });
    expect(logoutResponse.statusCode).toBe(204);
    expect(logoutResponse.body).toBe('');
    const cleared = parseSetCookie(logoutResponse.headers['set-cookie']);
    expect(cleared.find((c) => c.startsWith('refreshToken='))).toBeDefined();
    expect(
      getCookieAttributes(cleared.find((c) => c.startsWith('refreshToken='))!)['path'],
    ).toBe('/api/v1/auth/refresh');
    expect(cleared.find((c) => c.startsWith('accessToken='))).toBeDefined();

    // Server-side revocation: the session is marked and the credential fails.
    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].revokedAt).not.toBeNull();

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: cookiePair },
    });
    expect(refreshResponse.statusCode).toBe(401);
    expect(refreshResponse.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('stays safe and idempotent without a credential, with garbage, or when already revoked', async () => {
    if (!dbAvailable) return;

    for (const headers of [{}, { cookie: 'refreshToken=not-a-credential' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers,
      });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
    }

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'logout-idempotent@example.com',
        password: 'StrongPassword123!',
      },
    });
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: 'logout-idempotent@example.com', password: 'StrongPassword123!' },
    });
    const cookiePair = parseSetCookie(loginResponse.headers['set-cookie'])
      .find((c) => c.startsWith('refreshToken='))!
      .split(';')[0];

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookiePair },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookiePair },
    });
    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
  });

  it('does not revoke other sessions on logout', async () => {
    if (!dbAvailable) return;

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'logout-scope@example.com', password: 'StrongPassword123!' },
    });
    async function loginCookie(): Promise<string> {
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email: 'logout-scope@example.com', password: 'StrongPassword123!' },
      });
      return parseSetCookie(loginResponse.headers['set-cookie'])
        .find((c) => c.startsWith('refreshToken='))!
        .split(';')[0];
    }
    const cookieA = await loginCookie();
    const cookieB = await loginCookie();

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookieA },
    });
    expect(logoutResponse.statusCode).toBe(204);

    // A is dead, B (other session, same user) still refreshes.
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: cookieA } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: cookieB } }))
        .statusCode,
    ).toBe(200);
  });
});

// ────────────────────────────────────────────────────────
// 14. Revocation levels (M3.7)
// ────────────────────────────────────────────────────────

describe('revocation levels — integration', () => {
  const REVOKE_EMAIL = 'revoke-levels@example.com';

  async function registerAndLogin(): Promise<{ userId: string; refreshCookie: string }> {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: REVOKE_EMAIL, password: 'StrongPassword123!' },
    });
    const userId = (registerResponse.json() as { id: string }).id;
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: REVOKE_EMAIL, password: 'StrongPassword123!' },
    });
    const refreshCookie = parseSetCookie(loginResponse.headers['set-cookie'])
      .find((c) => c.startsWith('refreshToken='))!
      .split(';')[0];
    return { userId, refreshCookie };
  }

  async function instanceFor(cookiePair: string) {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256')
      .update(cookiePair.slice('refreshToken='.length), 'utf8')
      .digest('hex');
    const instance = await prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    expect(instance).not.toBeNull();
    return instance!;
  }

  it('level 1: revoking one instance blocks it while the family survives', async () => {
    if (!dbAvailable) return;
    const { refreshCookie } = await registerAndLogin();
    const instance = await instanceFor(refreshCookie);

    expect(await refreshService.revokeRefreshToken(instance.id)).toBe(true);
    expect(await refreshService.revokeRefreshToken(instance.id)).toBe(false);

    const stored = await prisma.refreshToken.findUnique({ where: { id: instance.id } });
    expect(stored!.revokedAt).not.toBeNull();

    // The revoked instance fails; the family itself is untouched.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(response.statusCode).toBe(401);
    const session = await prisma.session.findUnique({ where: { id: instance.sessionId } });
    expect(session!.revokedAt).toBeNull();
  });

  it('level 1: unknown IDs report false without error', async () => {
    if (!dbAvailable) return;

    expect(await refreshService.revokeRefreshToken('r_does_not_exist')).toBe(false);
  });

  it('level 2: revoking a session kills every credential in the family', async () => {
    if (!dbAvailable) return;
    const { userId, refreshCookie } = await registerAndLogin();

    // Rotate once so the family holds consumed + live instances.
    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(rotated.statusCode).toBe(200);
    const successorCookie = parseSetCookie(rotated.headers['set-cookie'])
      .find((c) => c.startsWith('refreshToken='))!
      .split(';')[0];

    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions).toHaveLength(1);
    expect(await sessionService.revokeSession(sessions[0].id)).toBe(true);
    expect(await sessionService.revokeSession(sessions[0].id)).toBe(false);

    // Historical rows remain; only the marker changed.
    expect(await prisma.refreshToken.count()).toBe(2);
    expect((await prisma.session.findUnique({ where: { id: sessions[0].id } }))!.revokedAt).not.toBeNull();

    for (const cookiePair of [refreshCookie, successorCookie]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: cookiePair },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
    }
  });

  it('level 3: revoking all sessions kills every family and is repeatable', async () => {
    if (!dbAvailable) return;
    const { userId } = await registerAndLogin();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: REVOKE_EMAIL, password: 'StrongPassword123!' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: REVOKE_EMAIL, password: 'StrongPassword123!' },
    });

    expect(await prisma.session.count({ where: { userId } })).toBe(3);
    expect(await sessionService.revokeAllSessionsForUser(userId)).toBe(3);
    expect(await sessionService.revokeAllSessionsForUser(userId)).toBe(0);

    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions).toHaveLength(3);
    for (const session of sessions) {
      expect(session.revokedAt).not.toBeNull();
    }
    // Rows retained, credentials untouched: revocation is state, not deletion.
    expect(await prisma.refreshToken.count()).toBe(3);
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it('level 3: zero-session users and repeats are safe', async () => {
    if (!dbAvailable) return;

    expect(await sessionService.revokeAllSessionsForUser('u_no_such_user')).toBe(0);
    expect(await sessionService.revokeAllSessionsForUser('u_no_such_user')).toBe(0);
  });

  it('replay against an already-revoked family is a safe no-op', async () => {
    if (!dbAvailable) return;
    const { refreshCookie } = await registerAndLogin();

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(rotated.statusCode).toBe(200);

    // Logout revokes the family (deliberate revocation, not replay).
    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: parseSetCookie(rotated.headers['set-cookie'])
          .find((c) => c.startsWith('refreshToken='))!
          .split(';')[0],
      },
    });
    expect(logoutResponse.statusCode).toBe(204);
    const before = (await prisma.session.findFirst())!.revokedAt;

    // Replaying the consumed ancestor changes nothing further.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(replay.statusCode).toBe(401);
    expect((await prisma.session.findFirst())!.revokedAt).toEqual(before);
    expect(await prisma.refreshToken.count()).toBe(2);
  });
});

// ────────────────────────────────────────────────────────
// 15. Revocation races (M3.7)
// ────────────────────────────────────────────────────────

describe('revocation races — integration', () => {
  const RACE_EMAIL = 'revoke-race@example.com';

  async function loginRaceCookie(): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: RACE_EMAIL, password: 'StrongPassword123!' },
    });
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: RACE_EMAIL, password: 'StrongPassword123!' },
    });
    return parseSetCookie(loginResponse.headers['set-cookie'])
      .find((c) => c.startsWith('refreshToken='))!
      .split(';')[0];
  }

  it('refresh racing session revocation ends revoked with no usable successor', async () => {
    if (!dbAvailable) return;
    const refreshCookie = await loginRaceCookie();
    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);

    // Genuinely overlapping refresh + deliberate revocation.
    const [refreshResponse] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: refreshCookie } }),
      sessionService.revokeSession(sessions[0].id),
    ]);

    // Final state is deterministic under both orderings: family revoked, and
    // any successor minted before revocation cannot refresh afterwards.
    expect((await prisma.session.findUnique({ where: { id: sessions[0].id } }))!.revokedAt).not.toBeNull();
    expect([200, 401]).toContain(refreshResponse.statusCode);
    const aftermatch = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(aftermatch.statusCode).toBe(401);
    expect(await prisma.refreshToken.count()).toBeLessThanOrEqual(2);
  });

  it('refresh racing revoke-all ends with every family revoked', async () => {
    if (!dbAvailable) return;
    const refreshCookie = await loginRaceCookie();
    const sessions = await prisma.session.findMany();
    const userId = sessions[0].userId;

    const [refreshResponse, revokedCount] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: refreshCookie } }),
      sessionService.revokeAllSessionsForUser(userId),
    ]);

    expect([200, 401]).toContain(refreshResponse.statusCode);
    expect(revokedCount).toBe(1);
    const live = await prisma.session.findMany({ where: { userId, revokedAt: null } });
    expect(live).toHaveLength(0);
    const aftermatch = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(aftermatch.statusCode).toBe(401);
  });
});

// ────────────────────────────────────────────────────────
// 16. Session durability across application lifecycles (M3.8)
// ────────────────────────────────────────────────────────

describe('session durability — integration', () => {
  const DURABILITY_EMAIL = 'durability@example.com';

  async function registerAndLogin(): Promise<{ userId: string; refreshCookie: string }> {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: DURABILITY_EMAIL, password: 'StrongPassword123!' },
    });
    expect(registerResponse.statusCode).toBe(201);
    const userId = (registerResponse.json() as { id: string }).id;

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: DURABILITY_EMAIL, password: 'StrongPassword123!' },
    });
    expect(loginResponse.statusCode).toBe(200);
    const refreshCookie = parseSetCookie(loginResponse.headers['set-cookie'])
      .find((c) => c.startsWith('refreshToken='))!
      .split(';')[0];
    return { userId, refreshCookie };
  }

  /**
   * Runs a callback against a separately-built application instance and a
   * separately-connected Prisma client, then tears both down. Anything the
   * callback observes must therefore come from PostgreSQL — never from
   * in-memory state shared with the primary test stack.
   */
  async function withFreshStack<T>(
    fn: (freshApp: FastifyInstance, freshPrisma: PrismaClient) => Promise<T>,
  ): Promise<T> {
    const freshPrisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    const freshApp = await buildApp();
    try {
      return await fn(freshApp, freshPrisma);
    } finally {
      await freshApp.close();
      await freshPrisma.$disconnect();
    }
  }

  it('persists the session so a rebuilt application observes identical state', async () => {
    if (!dbAvailable) return;
    const { userId, refreshCookie } = await registerAndLogin();

    await withFreshStack(async (freshApp, freshPrisma) => {
      const sessions = await freshPrisma.session.findMany({ where: { userId } });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].revokedAt).toBeNull();

      const instances = await freshPrisma.refreshToken.findMany({
        where: { sessionId: sessions[0].id },
      });
      expect(instances).toHaveLength(1);
      expect(instances[0].consumedAt).toBeNull();

      // The rebuilt instance refreshes the same family successfully.
      const response = await freshApp.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: refreshCookie },
      });
      expect(response.statusCode).toBe(200);
      const meResponse = await freshApp.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${response.json().accessToken}` },
      });
      expect(meResponse.statusCode).toBe(200);
      expect(meResponse.json().id).toBe(userId);
    });
  });

  it('keeps revoked sessions revoked across application recreation', async () => {
    if (!dbAvailable) return;
    const { userId, refreshCookie } = await registerAndLogin();

    expect(await sessionService.revokeAllSessionsForUser(userId)).toBe(1);

    await withFreshStack(async (freshApp, freshPrisma) => {
      const sessions = await freshPrisma.session.findMany({ where: { userId } });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].revokedAt).not.toBeNull();

      const response = await freshApp.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: refreshCookie },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
    });
  });

  it('never moves session identity or lifetime across rotation and restarts', async () => {
    if (!dbAvailable) return;
    const { refreshCookie } = await registerAndLogin();
    const before = await prisma.session.findFirstOrThrow();

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(rotated.statusCode).toBe(200);

    await withFreshStack(async (_freshApp, freshPrisma) => {
      // Still exactly one session: rotation never creates one.
      const sessions = await freshPrisma.session.findMany();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(before.id);
      expect(sessions[0].createdAt).toEqual(before.createdAt);
      expect(sessions[0].expiresAt).toEqual(before.expiresAt);

      // Two instances, one consumed lineage, shared absolute expiry.
      const instances = await freshPrisma.refreshToken.findMany({
        where: { sessionId: before.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(instances).toHaveLength(2);
      expect(instances[0].consumedAt).not.toBeNull();
      expect(instances[0].supersededBy).toBe(instances[1].id);
      expect(instances[1].consumedAt).toBeNull();
      expect(instances[1].expiresAt).toEqual(before.expiresAt);
    });
  });

  it('keeps expired sessions stored but unusable across recreation', async () => {
    if (!dbAvailable) return;
    const { userId, refreshCookie } = await registerAndLogin();
    const past = new Date(Date.now() - 1000);
    await prisma.session.updateMany({ data: { expiresAt: past } });
    await prisma.refreshToken.updateMany({ data: { expiresAt: past } });

    await withFreshStack(async (freshApp, freshPrisma) => {
      // Rows retained (no cleanup job), state intact.
      expect(await freshPrisma.session.count({ where: { userId } })).toBe(1);
      expect(await freshPrisma.refreshToken.count()).toBe(1);

      const response = await freshApp.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: refreshCookie },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  it('shares revocation writes across instances in both directions', async () => {
    if (!dbAvailable) return;
    const { refreshCookie } = await registerAndLogin();

    // Written through a fresh client (as a second instance would), observed
    // through the primary application stack.
    await withFreshStack(async (_freshApp, freshPrisma) => {
      const session = await freshPrisma.session.findFirstOrThrow();
      await freshPrisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
  });

  it('keeps logout invalidation durable: re-login creates an independent session', async () => {
    if (!dbAvailable) return;
    const { userId, refreshCookie } = await registerAndLogin();

    // Logout revokes the session through the primary stack.
    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: refreshCookie },
    });
    expect(logoutResponse.statusCode).toBe(204);

    await withFreshStack(async (freshApp, freshPrisma) => {
      // The invalidated session stays revoked and unusable on fresh stacks.
      const oldSessions = await freshPrisma.session.findMany({ where: { userId } });
      expect(oldSessions).toHaveLength(1);
      expect(oldSessions[0].revokedAt).not.toBeNull();
      const staleRefresh = await freshApp.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: refreshCookie },
      });
      expect(staleRefresh.statusCode).toBe(401);

      // A new login creates a distinct, live, independent session.
      const loginResponse = await freshApp.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email: DURABILITY_EMAIL, password: 'StrongPassword123!' },
      });
      expect(loginResponse.statusCode).toBe(200);
      const newCookie = parseSetCookie(loginResponse.headers['set-cookie'])
        .find((c) => c.startsWith('refreshToken='))!
        .split(';')[0];

      const sessions = await freshPrisma.session.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      expect(sessions).toHaveLength(2);
      expect(sessions[1].id).not.toBe(oldSessions[0].id);
      expect(sessions[1].revokedAt).toBeNull();
      // The old session was not resurrected by the new login.
      expect(sessions[0].revokedAt).not.toBeNull();

      const refreshResponse = await freshApp.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: newCookie },
      });
      expect(refreshResponse.statusCode).toBe(200);
    });
  });
});

// ────────────────────────────────────────────────────────
// 17. Password reset — request (M3.11)
// ────────────────────────────────────────────────────────

describe('password-reset request — integration', () => {
  const RESET_EMAIL = 'reset-request@example.com';

  type CapturedEmail = { to: string; resetUrl: string };

  function capturingMailer(sent: CapturedEmail[]) {
    return {
      sendPasswordResetEmail: async (email: CapturedEmail): Promise<void> => {
        sent.push(email);
      },
    };
  }

  async function registerResetUser(email = RESET_EMAIL): Promise<{ userId: string }> {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'StrongPassword123!' },
    });
    expect(registerResponse.statusCode).toBe(201);
    return { userId: (registerResponse.json() as { id: string }).id };
  }

  it('returns 204 with an empty body and identical bytes for known and unknown emails', async () => {
    if (!dbAvailable) return;
    await registerResetUser();

    const known = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      payload: { email: RESET_EMAIL },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      payload: { email: 'nobody@example.com' },
    });

    expect(known.statusCode).toBe(204);
    expect(unknown.statusCode).toBe(204);
    expect(known.body).toBe('');
    expect(unknown.body).toBe('');
  });

  it('persists only the hash with an expiry and delivers the raw token once', async () => {
    if (!dbAvailable) return;
    const { userId } = await registerResetUser();
    const sent: CapturedEmail[] = [];
    const { authService } = await import('../services/auth.service.js');

    await authService.requestPasswordReset(RESET_EMAIL, '127.0.0.1', capturingMailer(sent));

    const rows = await prisma.passwordResetToken.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].consumedAt).toBeNull();
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(RESET_EMAIL);
    const deliveredRaw = sent[0].resetUrl.split('token=')[1];
    expect(deliveredRaw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { createHash } = await import('node:crypto');
    expect(rows[0].tokenHash).toBe(createHash('sha256').update(deliveredRaw, 'utf8').digest('hex'));
    expect(JSON.stringify(rows[0])).not.toContain(deliveredRaw);
  });

  it('creates nothing and sends nothing for unknown or suspended accounts', async () => {
    if (!dbAvailable) return;
    const { authService } = await import('../services/auth.service.js');
    const sent: CapturedEmail[] = [];

    await authService.requestPasswordReset('ghost@example.com', '127.0.0.1', capturingMailer(sent));
    expect(sent).toHaveLength(0);
    expect(await prisma.passwordResetToken.count()).toBe(0);

    const { userId } = await registerResetUser('suspended-reset@example.com');
    await prisma.user.update({ where: { id: userId }, data: { status: 'suspended' } });
    await authService.requestPasswordReset('suspended-reset@example.com', '127.0.0.1', capturingMailer(sent));
    expect(sent).toHaveLength(0);
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it('supersedes previous active tokens so at most one is usable', async () => {
    if (!dbAvailable) return;
    await registerResetUser();
    const { authService } = await import('../services/auth.service.js');
    const first: CapturedEmail[] = [];
    const second: CapturedEmail[] = [];

    await authService.requestPasswordReset(RESET_EMAIL, '127.0.0.1', capturingMailer(first));
    await authService.requestPasswordReset(RESET_EMAIL, '127.0.0.1', capturingMailer(second));

    const rows = await prisma.passwordResetToken.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.consumedAt === null)).toHaveLength(1);

    // The superseded credential no longer completes a reset.
    const staleRaw = first[0].resetUrl.split('token=')[1];
    await expect(authService.resetPassword(staleRaw, 'AnotherStrongPass123!')).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
    });
  });

  it('rejects malformed request bodies with 400 without touching the service', async () => {
    if (!dbAvailable) return;

    for (const payload of [{}, { email: 'not-an-email' }, { email: 'a@b.com', extra: 1 }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────
// 18. Password reset — confirm (M3.11)
// ────────────────────────────────────────────────────────

describe('password-reset confirm — integration', () => {
  const RESET_EMAIL = 'reset-confirm@example.com';
  const OLD_PASSWORD = 'StrongPassword123!';
  const NEW_PASSWORD = 'BrandNewPassword456!';

  type CapturedEmail = { to: string; resetUrl: string };

  async function registerAndIssue(
    email = RESET_EMAIL,
  ): Promise<{ userId: string; rawToken: string }> {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: OLD_PASSWORD },
    });
    expect(registerResponse.statusCode).toBe(201);
    const userId = (registerResponse.json() as { id: string }).id;

    const { authService } = await import('../services/auth.service.js');
    const sent: CapturedEmail[] = [];
    await authService.requestPasswordReset(email, '127.0.0.1', {
      sendPasswordResetEmail: async (message: CapturedEmail): Promise<void> => {
        sent.push(message);
      },
    });
    expect(sent).toHaveLength(1);
    return { userId, rawToken: sent[0].resetUrl.split('token=')[1] };
  }

  async function loginStatus(email: string, password: string): Promise<number> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email, password },
    });
    return response.statusCode;
  }

  it('resets atomically: token consumed, password changed, sessions revoked', async () => {
    if (!dbAvailable) return;
    const { userId, rawToken } = await registerAndIssue();

    // Establish a live session before the reset.
    const browserLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: RESET_EMAIL, password: OLD_PASSWORD },
    });
    expect(browserLogin.statusCode).toBe(200);
    const refreshCookie = parseSetCookie(browserLogin.headers['set-cookie'])
      .find((c) => c.startsWith('refreshToken='))!
      .split(';')[0];

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      payload: { token: rawToken, password: NEW_PASSWORD },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');

    // All sessions revoked atomically with the win: exactly the one
    // pre-reset session exists, and it is revoked.
    const revokedSessions = await prisma.session.findMany({ where: { userId } });
    expect(revokedSessions).toHaveLength(1);
    expect(revokedSessions[0].revokedAt).not.toBeNull();

    // Old password fails, new password works.
    expect(await loginStatus(RESET_EMAIL, OLD_PASSWORD)).toBe(401);
    expect(await loginStatus(RESET_EMAIL, NEW_PASSWORD)).toBe(200);

    // Token consumed exactly once; hash changed; no plaintext anywhere.
    const { createHash } = await import('node:crypto');
    const row = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: createHash('sha256').update(rawToken, 'utf8').digest('hex') },
    });
    expect(row).not.toBeNull();
    expect(row!.consumedAt).not.toBeNull();
    const credential = await prisma.credential.findUnique({ where: { userId } });
    expect(credential).not.toBeNull();
    expect(credential!.passwordHash).not.toContain(NEW_PASSWORD);
    expect(credential!.passwordHash).toMatch(/^\$2[aby]\$/);

    // All sessions revoked: the pre-reset refresh credential fails.
    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(refreshResponse.statusCode).toBe(401);

    // Rows retained, not deleted. The pre-reset session is revoked; the
    // post-reset API login created a second, live session.
    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.revokedAt !== null)).toHaveLength(1);
    expect(await prisma.refreshToken.count()).toBe(2);
  }, { timeout: 30000 });

  it('rejects unknown, malformed, expired, and consumed tokens with one identical 401', async () => {
    if (!dbAvailable) return;
    const { rawToken } = await registerAndIssue();
    const { createHash } = await import('node:crypto');

    // Consume the live token through a successful reset first.
    const consumed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      payload: { token: rawToken, password: NEW_PASSWORD },
    });
    expect(consumed.statusCode).toBe(204);

    // Expire a second token server-side.
    const { authService } = await import('../services/auth.service.js');
    const sent: CapturedEmail[] = [];
    await authService.requestPasswordReset(RESET_EMAIL, '127.0.0.1', {
      sendPasswordResetEmail: async (message: CapturedEmail): Promise<void> => {
        sent.push(message);
      },
    });
    const expiredRaw = sent[0].resetUrl.split('token=')[1];
    await prisma.passwordResetToken.update({
      where: { tokenHash: createHash('sha256').update(expiredRaw, 'utf8').digest('hex') },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const bodies: string[] = [];
    for (const token of ['not-a-token', rawToken, expiredRaw]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token, password: NEW_PASSWORD },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
      bodies.push(parityBody(response.json()));
    }

    for (const body of bodies) {
      expect(body).toBe(bodies[0]);
    }
  });

  it('rejects short passwords with 400 and changes nothing', async () => {
    if (!dbAvailable) return;
    const { rawToken } = await registerAndIssue();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      payload: { token: rawToken, password: 'short' },
    });

    expect(response.statusCode).toBe(400);
    expect(await loginStatus(RESET_EMAIL, OLD_PASSWORD)).toBe(200);
    const { createHash } = await import('node:crypto');
    const row = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: createHash('sha256').update(rawToken, 'utf8').digest('hex') },
    });
    expect(row!.consumedAt).toBeNull();
  });

  it('replays fail: the same token cannot reset twice', async () => {
    if (!dbAvailable) return;
    const { rawToken } = await registerAndIssue();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      payload: { token: rawToken, password: NEW_PASSWORD },
    });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      payload: { token: rawToken, password: 'YetAnotherPass789!' },
    });
    expect(second.statusCode).toBe(401);

    // The winner's password stands; no second update occurred.
    expect(await loginStatus(RESET_EMAIL, NEW_PASSWORD)).toBe(200);
    expect(await loginStatus(RESET_EMAIL, 'YetAnotherPass789!')).toBe(401);
  });

  it('proves exactly-once reset under genuine concurrent confirm', async () => {
    if (!dbAvailable) return;
    const { rawToken } = await registerAndIssue();

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token: rawToken, password: 'ConcurrentPass111!' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token: rawToken, password: 'ConcurrentPass222!' },
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([204, 401]);

    const winnerPassword = first.statusCode === 204 ? 'ConcurrentPass111!' : 'ConcurrentPass222!';
    const loserPassword = first.statusCode === 204 ? 'ConcurrentPass222!' : 'ConcurrentPass111!';
    expect(await loginStatus(RESET_EMAIL, winnerPassword)).toBe(200);
    expect(await loginStatus(RESET_EMAIL, loserPassword)).toBe(401);

    // One consumption, sessions revoked atomically with the win.
    const rows = await prisma.passwordResetToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].consumedAt).not.toBeNull();
  }, { timeout: 30000 });

  it('fails safely for deleted users without resurrection', async () => {
    if (!dbAvailable) return;
    const { userId, rawToken } = await registerAndIssue();

    const sessions = await prisma.session.findMany({ where: { userId }, select: { id: true } });
    await prisma.refreshToken.deleteMany({
      where: { sessionId: { in: sessions.map((s) => s.id) } },
    });
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.passwordResetToken.deleteMany({ where: { userId } });
    await prisma.emailVerificationToken.deleteMany({ where: { userId } });
    await prisma.credential.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      payload: { token: rawToken, password: NEW_PASSWORD },
    });
    expect(response.statusCode).toBe(401);
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
  });

  it('cannot rebind a token to another user: the token row owns the target', async () => {
    if (!dbAvailable) return;
    await registerAndIssue(RESET_EMAIL);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'victim@example.com', password: OLD_PASSWORD },
    });

    const { authService } = await import('../services/auth.service.js');
    const sent: CapturedEmail[] = [];
    await authService.requestPasswordReset(RESET_EMAIL, '127.0.0.1', {
      sendPasswordResetEmail: async (message: CapturedEmail): Promise<void> => {
        sent.push(message);
      },
    });
    const rawToken = sent[sent.length - 1].resetUrl.split('token=')[1];

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      payload: { token: rawToken, password: NEW_PASSWORD },
    });
    expect(response.statusCode).toBe(204);

    // Attacker's account untouched; victim's password changed.
    expect(await loginStatus('victim@example.com', OLD_PASSWORD)).toBe(200);
    expect(await loginStatus(RESET_EMAIL, NEW_PASSWORD)).toBe(200);
  }, { timeout: 30000 });

  it('leaves no credential material in failure bodies', async () => {
    if (!dbAvailable) return;
    const probe = 'probe-reset-credential-value';

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      payload: { token: probe, password: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(probe);
    expect(response.body).not.toContain('tokenHash');
  });
});

// ────────────────────────────────────────────────────────
// 19. Email verification — registration and resend (M3.12)
// ────────────────────────────────────────────────────────

describe('email verification — registration and resend', () => {
  const VERIFY_EMAIL = 'verify-flow@example.com';

  type CapturedEmail = { to: string; verificationUrl: string };

  function capturingMailer(sent: CapturedEmail[]) {
    return {
      sendVerificationEmail: async (email: CapturedEmail): Promise<void> => {
        sent.push(email);
      },
    };
  }

  it('registration creates user, credential, and verification token atomically and emails after commit', async () => {
    if (!dbAvailable) return;
    const { authService } = await import('../services/auth.service.js');
    const sent: CapturedEmail[] = [];

    const user = await authService.register(
      { email: VERIFY_EMAIL, password: 'StrongPassword123!' },
      capturingMailer(sent),
    );

    expect(user.email).toBe(VERIFY_EMAIL);
    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    expect(stored).not.toBeNull();
    expect(stored!.emailVerifiedAt).toBeNull();

    const tokens = await prisma.emailVerificationToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens[0].consumedAt).toBeNull();
    expect(tokens[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(VERIFY_EMAIL);
    const deliveredRaw = sent[0].verificationUrl.split('token=')[1];
    expect(deliveredRaw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { createHash } = await import('node:crypto');
    expect(tokens[0].tokenHash).toBe(createHash('sha256').update(deliveredRaw, 'utf8').digest('hex'));
    expect(JSON.stringify(tokens[0])).not.toContain(deliveredRaw);
  });

  it('unverified users can still log in (no login gating in M3.12)', async () => {
    if (!dbAvailable) return;

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: VERIFY_EMAIL, password: 'StrongPassword123!' },
    });
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email: VERIFY_EMAIL, password: 'StrongPassword123!' },
    });

    expect(loginResponse.statusCode).toBe(200);
    expect(loginResponse.json().accessToken).toBeDefined();
  });

  it('resend returns identical 204s for unknown, suspended, and verified accounts', async () => {
    if (!dbAvailable) return;
    const { authService } = await import('../services/auth.service.js');

    for (const email of ['ghost@example.com', VERIFY_EMAIL]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/resend',
        payload: { email },
      });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
    }

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: VERIFY_EMAIL, password: 'StrongPassword123!' },
    });
    const sent: CapturedEmail[] = [];
    await authService.resendVerificationEmail(VERIFY_EMAIL, '127.0.0.1', capturingMailer(sent));
    expect(sent).toHaveLength(1);

    // Verify, then resend again: silent no-op, no new token.
    const rawToken = sent[0].verificationUrl.split('token=')[1];
    const confirmResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-verification/confirm',
      payload: { token: rawToken },
    });
    expect(confirmResponse.statusCode).toBe(204);
    const second: CapturedEmail[] = [];
    await authService.resendVerificationEmail(VERIFY_EMAIL, '127.0.0.1', capturingMailer(second));
    expect(second).toHaveLength(0);
    // Registration token + resent token, both consumed, none created by the no-op.
    expect(await prisma.emailVerificationToken.count()).toBe(2);
  });

  it('resend supersedes previous tokens and rejects malformed bodies with 400', async () => {
    if (!dbAvailable) return;
    const { authService } = await import('../services/auth.service.js');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: VERIFY_EMAIL, password: 'StrongPassword123!' },
    });

    const first: CapturedEmail[] = [];
    const second: CapturedEmail[] = [];
    await authService.resendVerificationEmail(VERIFY_EMAIL, '127.0.0.1', capturingMailer(first));
    await authService.resendVerificationEmail(VERIFY_EMAIL, '127.0.0.1', capturingMailer(second));

    const rows = await prisma.emailVerificationToken.findMany({
      orderBy: { createdAt: 'asc' },
    });
    // Registration token + two resends, only the newest usable.
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.consumedAt === null)).toHaveLength(1);

    const staleRaw = first[0].verificationUrl.split('token=')[1];
    const staleResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-verification/confirm',
      payload: { token: staleRaw },
    });
    expect(staleResponse.statusCode).toBe(401);

    for (const payload of [{}, { email: 'not-an-email' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/resend',
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

// ────────────────────────────────────────────────────────
// 20. Email verification — confirm (M3.12)
// ────────────────────────────────────────────────────────

describe('email verification — confirm', () => {
  const VERIFY_EMAIL = 'verify-confirm@example.com';

  type CapturedEmail = { to: string; verificationUrl: string };

  async function registerAndCapture(email = VERIFY_EMAIL): Promise<{ userId: string; rawToken: string }> {
    const { authService } = await import('../services/auth.service.js');
    const sent: CapturedEmail[] = [];
    const user = await authService.register(
      { email, password: 'StrongPassword123!' },
      {
        sendVerificationEmail: async (message: CapturedEmail): Promise<void> => {
          sent.push(message);
        },
      },
    );
    expect(sent).toHaveLength(1);
    return { userId: user.id, rawToken: sent[0].verificationUrl.split('token=')[1] };
  }

  it('confirms atomically: token consumed and user stamped, sessions untouched', async () => {
    if (!dbAvailable) return;
    const { userId, rawToken } = await registerAndCapture();

    // Establish a live session before confirmation.
    const browserLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email: VERIFY_EMAIL, password: 'StrongPassword123!' },
    });
    expect(browserLogin.statusCode).toBe(200);
    const refreshCookie = parseSetCookie(browserLogin.headers['set-cookie'])
      .find((c) => c.startsWith('refreshToken='))!
      .split(';')[0];

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-verification/confirm',
      payload: { token: rawToken },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');

    const { createHash } = await import('node:crypto');
    const row = await prisma.emailVerificationToken.findUnique({
      where: { tokenHash: createHash('sha256').update(rawToken, 'utf8').digest('hex') },
    });
    expect(row).not.toBeNull();
    expect(row!.consumedAt).not.toBeNull();
    const stored = await prisma.user.findUnique({ where: { id: userId } });
    expect(stored!.emailVerifiedAt).not.toBeNull();

    // Sessions and JWTs are unaffected: refresh still works.
    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(refreshResponse.statusCode).toBe(200);
  });

  it('rejects unknown, malformed, expired, and consumed tokens with one identical 401', async () => {
    if (!dbAvailable) return;
    const { rawToken } = await registerAndCapture();
    const { createHash } = await import('node:crypto');

    const consumed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-verification/confirm',
      payload: { token: rawToken },
    });
    expect(consumed.statusCode).toBe(204);

    const { authService } = await import('../services/auth.service.js');
    const sent: CapturedEmail[] = [];
    await prisma.user.update({
      where: { email: VERIFY_EMAIL },
      data: { emailVerifiedAt: null },
    });
    await authService.resendVerificationEmail(VERIFY_EMAIL, '127.0.0.1', {
      sendVerificationEmail: async (message: CapturedEmail): Promise<void> => {
        sent.push(message);
      },
    });
    const expiredRaw = sent[0].verificationUrl.split('token=')[1];
    await prisma.emailVerificationToken.update({
      where: { tokenHash: createHash('sha256').update(expiredRaw, 'utf8').digest('hex') },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const bodies: string[] = [];
    for (const token of ['not-a-token', rawToken, expiredRaw]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/confirm',
        payload: { token },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
      bodies.push(parityBody(response.json()));
    }

    for (const body of bodies) {
      expect(body).toBe(bodies[0]);
    }
  });

  it('replays fail and concurrent confirms have exactly one winner', async () => {
    if (!dbAvailable) return;
    const { rawToken } = await registerAndCapture();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-verification/confirm',
      payload: { token: rawToken },
    });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-verification/confirm',
      payload: { token: rawToken },
    });
    expect(second.statusCode).toBe(401);

    const { rawToken: rawToken2 } = await registerAndCapture('verify-race@example.com');
    const [winner, loser] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/confirm',
        payload: { token: rawToken2 },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/email-verification/confirm',
        payload: { token: rawToken2 },
      }),
    ]);
    const statuses = [winner.statusCode, loser.statusCode].sort();
    expect(statuses).toEqual([204, 401]);

    const stored = await prisma.user.findUnique({ where: { email: 'verify-race@example.com' } });
    expect(stored!.emailVerifiedAt).not.toBeNull();
  });

  it('already-verified accounts succeed idempotently without moving the timestamp', async () => {
    if (!dbAvailable) return;
    const { userId, rawToken } = await registerAndCapture();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-verification/confirm',
      payload: { token: rawToken },
    });
    expect(first.statusCode).toBe(204);
    const stamped = (await prisma.user.findUnique({ where: { id: userId } }))!.emailVerifiedAt;
    expect(stamped).not.toBeNull();

    // Craft a second live token simulating race residue, then confirm.
    const { createHash, randomBytes } = await import('node:crypto');
    const residueRaw = randomBytes(32).toString('base64url');
    await prisma.emailVerificationToken.create({
      data: {
        id: 'e_residue_verify_test_0001',
        userId,
        tokenHash: createHash('sha256').update(residueRaw, 'utf8').digest('hex'),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-verification/confirm',
      payload: { token: residueRaw },
    });
    expect(response.statusCode).toBe(204);
    expect((await prisma.user.findUnique({ where: { id: userId } }))!.emailVerifiedAt).toEqual(
      stamped,
    );
  });

  it('fails safely for deleted users without resurrection', async () => {
    if (!dbAvailable) return;
    const { userId, rawToken } = await registerAndCapture();

    await prisma.emailVerificationToken.deleteMany({ where: { userId } });
    await prisma.passwordResetToken.deleteMany({ where: { userId } });
    const sessions = await prisma.session.findMany({ where: { userId }, select: { id: true } });
    await prisma.refreshToken.deleteMany({
      where: { sessionId: { in: sessions.map((s) => s.id) } },
    });
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.emailVerificationToken.deleteMany({ where: { userId } });
    await prisma.credential.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-verification/confirm',
      payload: { token: rawToken },
    });
    expect(response.statusCode).toBe(401);
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
  });

  it('cannot verify another account: the token row owns the target', async () => {
    if (!dbAvailable) return;
    const { rawToken } = await registerAndCapture('verify-owner@example.com');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'verify-bystander@example.com', password: 'StrongPassword123!' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-verification/confirm',
      payload: { token: rawToken },
    });
    expect(response.statusCode).toBe(204);

    // The bystander stays unverified; the owner is verified. The confirm
    // contract accepts no identity field that could redirect the target.
    const owner = await prisma.user.findUnique({ where: { email: 'verify-owner@example.com' } });
    const bystander = await prisma.user.findUnique({ where: { email: 'verify-bystander@example.com' } });
    expect(owner!.emailVerifiedAt).not.toBeNull();
    expect(bystander!.emailVerifiedAt).toBeNull();
  });

  it('leaves no credential material in failure bodies', async () => {
    if (!dbAvailable) return;
    const probe = 'probe-verification-credential-value';

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-verification/confirm',
      payload: { token: probe },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(probe);
    expect(response.body).not.toContain('tokenHash');
  });
});

// ────────────────────────────────────────────────────────
// 21. Revoke all sessions — integration (M3.13)
// ────────────────────────────────────────────────────────

describe('POST /api/v1/auth/sessions/revoke-all — integration', () => {
  async function registerUser(email: string): Promise<{ userId: string }> {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'StrongPassword123!' },
    });
    expect(registerResponse.statusCode).toBe(201);
    return { userId: (registerResponse.json() as { id: string }).id };
  }

  async function browserLogin(email: string): Promise<{ accessToken: string; refreshCookie: string }> {
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email, password: 'StrongPassword123!' },
    });
    expect(loginResponse.statusCode).toBe(200);
    const cookies = parseSetCookie(loginResponse.headers['set-cookie']);
    const refreshCookie = cookies
      .find((c) => c.startsWith('refreshToken='))!
      .split(';')[0];
    const accessCookie = cookies
      .find((c) => c.startsWith('accessToken='))!
      .split(';')[0]
      .slice('accessToken='.length);
    return { accessToken: accessCookie, refreshCookie };
  }

  async function liveSessions(userId: string) {
    return prisma.session.findMany({ where: { userId, revokedAt: null } });
  }

  it('revokes one session and blocks its refresh (Test A)', async () => {
    if (!dbAvailable) return;
    const { userId } = await registerUser('revoke-one@example.com');
    const { accessToken, refreshCookie } = await browserLogin('revoke-one@example.com');
    expect(await liveSessions(userId)).toHaveLength(1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-all',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(await liveSessions(userId)).toHaveLength(0);

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(refreshResponse.statusCode).toBe(401);
  });

  it('revokes many sessions at once (Test B)', async () => {
    if (!dbAvailable) return;
    const { userId } = await registerUser('revoke-many@example.com');
    const cookies: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const login = await browserLogin('revoke-many@example.com');
      cookies.push(login.refreshCookie);
    }
    expect(await liveSessions(userId)).toHaveLength(3);

    // A fresh access token authenticates the revoke-all call itself.
    const apiLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email: 'revoke-many@example.com', password: 'StrongPassword123!' },
    });
    const callerToken = (apiLogin.json() as { accessToken: string }).accessToken;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-all',
      headers: { authorization: `Bearer ${callerToken}` },
    });
    expect(response.statusCode).toBe(204);
    expect(await liveSessions(userId)).toHaveLength(0);

    for (const cookie of cookies) {
      const refreshResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie },
      });
      expect(refreshResponse.statusCode).toBe(401);
    }
  });

  it('preserves existing revokedAt timestamps and succeeds with zero sessions (Tests C, D)', async () => {
    if (!dbAvailable) return;
    const { userId } = await registerUser('revoke-idempotent@example.com');
    await browserLogin('revoke-idempotent@example.com');

    const apiLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email: 'revoke-idempotent@example.com', password: 'StrongPassword123!' },
    });
    const callerToken = (apiLogin.json() as { accessToken: string }).accessToken;
    const headers = { authorization: `Bearer ${callerToken}` };

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-all',
      headers,
    });
    expect(first.statusCode).toBe(204);
    const revokedAt = (await prisma.session.findMany({ where: { userId } })).map(
      (session) => session.revokedAt?.getTime(),
    );

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-all',
      headers,
    });
    expect(second.statusCode).toBe(204);
    expect(second.body).toBe('');
    const reread = (await prisma.session.findMany({ where: { userId } })).map(
      (session) => session.revokedAt?.getTime(),
    );
    expect(reread).toEqual(revokedAt);

    // A user with zero sessions still succeeds.
    await registerUser('revoke-empty@example.com');
    const emptyLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email: 'revoke-empty@example.com', password: 'StrongPassword123!' },
    });
    const emptyToken = (emptyLogin.json() as { accessToken: string }).accessToken;
    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-all',
      headers: { authorization: `Bearer ${emptyToken}` },
    });
    expect(empty.statusCode).toBe(204);
  });

  it('leaves other users sessions fully usable (Test E)', async () => {
    if (!dbAvailable) return;
    await registerUser('revoke-alice@example.com');
    await registerUser('revoke-bob@example.com');
    const alice = await browserLogin('revoke-alice@example.com');
    const bob = await browserLogin('revoke-bob@example.com');
    const bobUser = await prisma.user.findUniqueOrThrow({ where: { email: 'revoke-bob@example.com' } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-all',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(response.statusCode).toBe(204);

    // Bob is unaffected: refresh works and rows stay live.
    const bobRefresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: bob.refreshCookie },
    });
    expect(bobRefresh.statusCode).toBe(200);
    expect(await liveSessions(bobUser.id)).toHaveLength(1);

    // Alice is revoked.
    const aliceRefresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: alice.refreshCookie },
    });
    expect(aliceRefresh.statusCode).toBe(401);
  });

  it('allows a fresh login afterwards while history is retained (Test G)', async () => {
    if (!dbAvailable) return;
    const { userId } = await registerUser('revoke-relogin@example.com');
    const first = await browserLogin('revoke-relogin@example.com');

    const revokeResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-all',
      headers: { authorization: `Bearer ${first.accessToken}` },
    });
    expect(revokeResponse.statusCode).toBe(204);

    const second = await browserLogin('revoke-relogin@example.com');
    const sessions = await prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0].revokedAt).not.toBeNull();
    expect(sessions[1].revokedAt).toBeNull();

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: second.refreshCookie },
    });
    expect(refreshResponse.statusCode).toBe(200);
  });

  it('leaves a just-issued access JWT usable until expiry (Test H)', async () => {
    if (!dbAvailable) return;
    await registerUser('revoke-jwt@example.com');
    const { accessToken } = await browserLogin('revoke-jwt@example.com');

    const revokeResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-all',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(revokeResponse.statusCode).toBe(204);

    // Stateless access JWT drains naturally: still accepted post-revocation.
    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meResponse.statusCode).toBe(200);
  });

  it('requires authentication and ignores forged or foreign identities', async () => {
    if (!dbAvailable) return;
    await registerUser('revoke-auth@example.com');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-all',
    });
    expect(missing.statusCode).toBe(401);

    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-all',
      headers: { authorization: 'Bearer forged.invalid.token' },
    });
    expect(forged.statusCode).toBe(401);

    // Query strings and bodies cannot redirect the target.
    const { accessToken } = await browserLogin('revoke-auth@example.com');
    const redirected = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-all?userId=u_victim00000000000000000000',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { userId: 'u_victim00000000000000000000' },
    });
    expect(redirected.statusCode).toBe(204);
  });
});

// ────────────────────────────────────────────────────────
// 22. Revoke-all concurrency and durability (M3.13)
// ────────────────────────────────────────────────────────

describe('revoke-all concurrency and durability — integration', () => {
  async function registerAndLogin(email: string): Promise<{ refreshCookie: string }> {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'StrongPassword123!' },
    });
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'text/html' },
      payload: { email, password: 'StrongPassword123!' },
    });
    const refreshCookie = parseSetCookie(loginResponse.headers['set-cookie'])
      .find((c) => c.startsWith('refreshToken='))!
      .split(';')[0];
    return { refreshCookie };
  }

  it('refresh racing revoke-all ends revoked with no usable successor', async () => {
    if (!dbAvailable) return;
    const email = 'race-refresh-revokeall@example.com';
    await registerAndLogin(email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(1);
    const cookie = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email, password: 'StrongPassword123!' },
      })
    ).headers['set-cookie'];
    const refreshCookie = parseSetCookie(cookie).find((c) => c.startsWith('refreshToken='))!.split(';')[0];

    const apiLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email, password: 'StrongPassword123!' },
    });
    const callerToken = (apiLogin.json() as { accessToken: string }).accessToken;

    const [refreshResponse] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: refreshCookie } }),
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
        headers: { authorization: `Bearer ${callerToken}` },
      }),
    ]);

    expect([200, 401]).toContain(refreshResponse.statusCode);
    expect(await prisma.session.findMany({ where: { userId: user.id, revokedAt: null } })).toHaveLength(0);
    const aftermatch = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: refreshCookie },
    });
    expect(aftermatch.statusCode).toBe(401);
  });

  it('login racing revoke-all leaves a deterministic final state', async () => {
    if (!dbAvailable) return;
    const email = 'race-login-revokeall@example.com';
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'StrongPassword123!' },
    });
    const apiLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email, password: 'StrongPassword123!' },
    });
    const callerToken = (apiLogin.json() as { accessToken: string }).accessToken;
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    const [loginResponse, revokeResponse] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { accept: 'text/html' },
        payload: { email, password: 'StrongPassword123!' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
        headers: { authorization: `Bearer ${callerToken}` },
      }),
    ]);

    expect(loginResponse.statusCode).toBe(200);
    expect(revokeResponse.statusCode).toBe(204);
    // Whatever the commit order, every pre-existing session is revoked and
    // at most the post-revoke login session remains live.
    const live = await prisma.session.findMany({ where: { userId: user.id, revokedAt: null } });
    expect(live.length).toBeLessThanOrEqual(1);
  });

  it('logout racing revoke-all stays revoked without resurrection', async () => {
    if (!dbAvailable) return;
    const email = 'race-logout-revokeall@example.com';
    const { refreshCookie } = await registerAndLogin(email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const apiLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email, password: 'StrongPassword123!' },
    });
    const callerToken = (apiLogin.json() as { accessToken: string }).accessToken;

    const [logoutResponse, revokeResponse] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: refreshCookie } }),
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-all',
        headers: { authorization: `Bearer ${callerToken}` },
      }),
    ]);

    expect(logoutResponse.statusCode).toBe(204);
    expect(revokeResponse.statusCode).toBe(204);
    expect(await prisma.session.findMany({ where: { userId: user.id, revokedAt: null } })).toHaveLength(0);
  });

  it('revocation persists across application rebuild with a fresh client', async () => {
    if (!dbAvailable) return;
    const email = 'race-durable-revokeall@example.com';
    const { refreshCookie } = await registerAndLogin(email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const apiLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { accept: 'application/json' },
      payload: { email, password: 'StrongPassword123!' },
    });
    const revokeResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-all',
      headers: { authorization: `Bearer ${(apiLogin.json() as { accessToken: string }).accessToken}` },
    });
    expect(revokeResponse.statusCode).toBe(204);

    const freshPrisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    const { buildApp } = await import('../../../app/app.js');
    const freshApp = await buildApp();
    try {
      expect(await freshPrisma.session.findMany({ where: { userId: user.id, revokedAt: null } })).toHaveLength(0);
      const refreshResponse = await freshApp.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: refreshCookie },
      });
      expect(refreshResponse.statusCode).toBe(401);
    } finally {
      await freshApp.close();
      await freshPrisma.$disconnect();
    }
  });
});
