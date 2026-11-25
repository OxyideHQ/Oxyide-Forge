import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

// Mock users service for the subject-existence contract (M4.6)
const mockFindById = vi.fn();

vi.mock('../../users/users.service.js', () => ({
  usersService: {
    findById: mockFindById,
  },
}));

const { requireAuth } = await import('./require-auth.js');
const { authPlugin } = await import('../../../plugins/auth.plugin.js');

const { registerGlobalErrorHandler } = await import('../../../app/app.js');

describe('requireAuth guard', () => {
  let app: FastifyInstance;

  const mockUser = {
    id: 'user-1',
    email: 'alice@example.com',
    displayName: 'Alice',
    status: 'active',
    role: 'user',
    emailVerifiedAt: null,
    lockedUntil: null,
    createdAt: new Date('2026-01-15T09:30:00.000Z'),
    updatedAt: new Date('2026-01-15T09:30:00.000Z'),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(mockUser);

    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    await app.register(authPlugin);

    app.get('/protected', { preHandler: [requireAuth] }, async () => ({
      userId: 'authenticated',
    }));

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('returns 401 when Authorization header is not Bearer format', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Basic abc123' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 401 when Authorization header has no token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer ' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 401 when token is invalid', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer invalid-token' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 401 when token is expired', async () => {
    // Create an expired token manually
    const crypto = await import('node:crypto');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'user-1',
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 3600,
      }),
    ).toString('base64url');
    const signature = crypto
      .createHmac('sha256', 'test-jwt-secret-key-min-32-chars-long')
      .update(`${header}.${payload}`)
      .digest('base64url');
    const expiredToken = `${header}.${payload}.${signature}`;

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${expiredToken}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('allows access with a valid token', async () => {
    const token = app.jwt.sign({ sub: 'user-1' });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
      expect(mockFindById).toHaveBeenCalledWith('user-1');
  });

  it('returns 401 when the token subject no longer exists (M4.6 F3)', async () => {
    mockFindById.mockResolvedValueOnce(null);
    const token = app.jwt.sign({ sub: 'deleted-user' });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
    expect(response.headers['www-authenticate']).toContain('Bearer');
  });

  it('propagates subject-store failures instead of bypassing authentication', async () => {
    mockFindById.mockRejectedValueOnce(new Error('connection terminated'));
    const token = app.jwt.sign({ sub: 'user-1' });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(500);
  });

  it('sets WWW-Authenticate header on 401 responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain('Bearer');
  });
});
