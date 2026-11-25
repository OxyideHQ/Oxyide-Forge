import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

// Mock authorization service — covers both handler usage and guard usage
const mockGetRoles = vi.fn();
const mockGetPermissionsForRole = vi.fn();
const mockCan = vi.fn();

vi.mock('../../authorization/services/authorization.service.js', () => ({
  authorizationService: {
    getRoles: mockGetRoles,
    getPermissionsForRole: mockGetPermissionsForRole,
    can: mockCan,
    hasRole: vi.fn(),
  },
}));

// Mock users service for the requireAuth subject-existence contract (M4.6)
const mockFindById = vi.fn();

vi.mock('../../users/users.service.js', () => ({
  usersService: {
    findById: mockFindById,
  },
}));

const { registerRoleRoutes } = await import('./role.routes.js');
const { authPlugin } = await import('../../../plugins/auth.plugin.js');

const { registerGlobalErrorHandler } = await import('../../../app/app.js');

describe('roleRoutes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default guard-lookup subject (M4.6 subject-existence contract).
    mockFindById.mockResolvedValue({ id: 'admin-user' });

    // Default mock implementations
    mockGetRoles.mockReturnValue(['user', 'admin']);
    mockGetPermissionsForRole.mockImplementation((role: string) => {
      if (role === 'user') {
        return ['auth:login', 'auth:logout', 'users:read:self', 'users:update:self'];
      }
      if (role === 'admin') {
        return [
          'auth:login', 'auth:logout',
          'users:read', 'users:read:self', 'users:update', 'users:update:self', 'users:delete',
          'roles:read', 'roles:create', 'roles:update', 'roles:delete',
        ];
      }
      return [];
    });
    // Default: grant roles:read for admin tokens
    mockCan.mockResolvedValue({ granted: true, reason: 'Granted.' });

    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    await app.register(authPlugin);
    await app.register(registerRoleRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/v1/roles', () => {
    it('returns 200 with list of roles for admin', async () => {
      const token = app.jwt.sign({ sub: 'admin-user' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.roles).toHaveLength(2);
      expect(body.roles[0].name).toBe('user');
      expect(body.roles[1].name).toBe('admin');
    });

    it('returns 401 when not authenticated', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when user lacks roles:read permission', async () => {
      mockCan.mockResolvedValueOnce({ granted: false, reason: 'Not authorized.' });

      const token = app.jwt.sign({ sub: 'regular-user' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.code).toBe('AUTH_FORBIDDEN');
    });

    it('each role includes name and permissions', async () => {
      const token = app.jwt.sign({ sub: 'admin-user' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      for (const role of body.roles) {
        expect(role).toHaveProperty('name');
        expect(role).toHaveProperty('permissions');
        expect(Array.isArray(role.permissions)).toBe(true);
      }
    });
  });

  describe('GET /api/v1/roles/:name', () => {
    it('returns 200 with role and permissions for admin', async () => {
      const token = app.jwt.sign({ sub: 'admin-user' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles/user',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe('user');
      expect(body.permissions).toEqual(['auth:login', 'auth:logout', 'users:read:self', 'users:update:self']);
    });

    it('returns 200 for admin role', async () => {
      const token = app.jwt.sign({ sub: 'admin-user' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles/admin',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe('admin');
      expect(body.permissions).toContain('users:read');
      expect(body.permissions).toContain('roles:read');
    });

    it('returns 401 when not authenticated', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles/user',
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when user lacks roles:read permission', async () => {
      mockCan.mockResolvedValueOnce({ granted: false, reason: 'Not authorized.' });

      const token = app.jwt.sign({ sub: 'regular-user' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles/user',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 404 for unknown role name', async () => {
      const token = app.jwt.sign({ sub: 'admin-user' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/roles/unknown-role',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.code).toBe('ROLES_NOT_FOUND');
    });

    it('returns 414 for an oversized role name without touching services (M5.3)', async () => {
      const token = app.jwt.sign({ sub: 'admin-user' });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/roles/${'r'.repeat(200)}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(414);
      expect(mockGetPermissionsForRole).not.toHaveBeenCalled();
    });
  });
});
