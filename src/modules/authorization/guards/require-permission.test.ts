import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const mockCan = vi.fn();

vi.mock('../services/authorization.service.js', () => ({
  authorizationService: {
    can: mockCan,
  },
}));

const { requirePermission } = await import('./require-permission.js');
const { authPlugin } = await import('../../../plugins/auth.plugin.js');
const { UserPermissions } = await import('../permissions/user.permissions.js');
const { AUTH_FORBIDDEN_DETAIL } = await import('../../../shared/errors/error-mapper.js');

const { registerGlobalErrorHandler } = await import('../../../app/app.js');

describe('requirePermission guard', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();

    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    await app.register(authPlugin);

    app.get(
      '/protected',
      { preHandler: [app.authenticate, requirePermission(UserPermissions.DELETE)] },
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
      url: '/protected',
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('returns 403 when permission is denied, with the generic public detail', async () => {
    // The service reason is operator-only; the public detail is the
    // centralized constant and never the service-supplied string.
    mockCan.mockResolvedValueOnce({
      granted: false,
      reason: "Role 'user' does not have permission 'users:delete'.",
    });

    const token = app.jwt.sign({ sub: 'user-1' });
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.code).toBe('AUTH_FORBIDDEN');
    expect(body.detail).toBe(AUTH_FORBIDDEN_DETAIL);
    expect(response.payload).not.toContain('users:delete');
    expect(response.payload).not.toContain("Role 'user'");
  });

  it('allows access when permission is granted', async () => {
    mockCan.mockResolvedValueOnce({ granted: true, reason: 'Granted.' });

    const token = app.jwt.sign({ sub: 'user-1' });
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it('passes AuthContext to the authorization service', async () => {
    mockCan.mockResolvedValueOnce({ granted: true, reason: 'Granted.' });

    const token = app.jwt.sign({ sub: 'user-123' });
    await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(mockCan).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-123' }),
      UserPermissions.DELETE,
    );
  });

  it('returns 403 with RFC 7807 problem details format and no service vocabulary', async () => {
    mockCan.mockResolvedValueOnce({
      granted: false,
      reason: 'Insufficient permissions: users:delete.',
    });

    const token = app.jwt.sign({ sub: 'user-1' });
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body).toHaveProperty('type');
    expect(body).toHaveProperty('title');
    expect(body).toHaveProperty('status', 403);
    expect(body).toHaveProperty('detail');
    expect(body).toHaveProperty('code');
    // M6.8: exact six-field allowlist, and the service reason is absent.
    expect(Object.keys(body).sort()).toEqual([
      'code',
      'detail',
      'instance',
      'status',
      'title',
      'type',
    ]);
    expect(response.payload).not.toContain('Insufficient permissions');
    expect(response.payload).not.toContain('users:delete');
  });
});
