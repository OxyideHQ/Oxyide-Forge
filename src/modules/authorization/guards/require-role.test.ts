import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const mockHasRole = vi.fn();

vi.mock('../services/authorization.service.js', () => ({
  authorizationService: {
    hasRole: mockHasRole,
  },
}));

const { requireRole } = await import('./require-role.js');
const { authPlugin } = await import('../../../plugins/auth.plugin.js');
const { AUTH_FORBIDDEN_DETAIL } = await import('../../../shared/errors/error-mapper.js');

const { registerGlobalErrorHandler } = await import('../../../app/app.js');

describe('requireRole guard', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();

    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    await app.register(authPlugin);

    app.get(
      '/admin',
      { preHandler: [app.authenticate, requireRole('admin')] },
      async () => ({ ok: true }),
    );

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 when not authenticated', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin',
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('returns 403 with the generic public detail when the role is denied', async () => {
    mockHasRole.mockResolvedValueOnce({
      granted: false,
      reason: "Required role 'admin', user has 'user'.",
    });

    const token = app.jwt.sign({ sub: 'user-1' });
    const response = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.code).toBe('AUTH_FORBIDDEN');
    expect(body.detail).toBe(AUTH_FORBIDDEN_DETAIL);
    // M6.8: neither role name escapes into the public body.
    expect(response.payload).not.toContain("'admin'");
    expect(response.payload).not.toContain("'user'");
    expect(response.payload).not.toContain('Required role');
  });

  it('allows access when role matches', async () => {
    mockHasRole.mockResolvedValueOnce({ granted: true, reason: 'Role match.' });

    const token = app.jwt.sign({ sub: 'admin-1' });
    const response = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it('passes AuthContext to the authorization service', async () => {
    mockHasRole.mockResolvedValueOnce({ granted: true, reason: 'Role match.' });

    const token = app.jwt.sign({ sub: 'admin-123' });
    await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(mockHasRole).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'admin-123' }),
      'admin',
    );
  });

  it('returns 403 with RFC 7807 problem details format', async () => {
    mockHasRole.mockResolvedValueOnce({ granted: false, reason: 'Insufficient role.' });

    const token = app.jwt.sign({ sub: 'user-1' });
    const response = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body).toHaveProperty('type');
    expect(body).toHaveProperty('title');
    expect(body).toHaveProperty('status', 403);
    expect(body).toHaveProperty('detail');
    expect(body).toHaveProperty('code');
  });

  it('returns 401 with WWW-Authenticate header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain('Bearer');
  });
});
