import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

// Mock users service
const mockFindById = vi.fn();
const mockUpdate = vi.fn();
const mockRemove = vi.fn();

vi.mock('../users.service.js', () => ({
  usersService: {
    findById: mockFindById,
    update: mockUpdate,
    remove: mockRemove,
  },
}));

// Mock user policy
const mockCanReadUser = vi.fn();
const mockCanUpdateUser = vi.fn();
const mockCanDeleteUser = vi.fn();

vi.mock('../../authorization/policies/user.policy.js', () => ({
  userPolicy: {
    canReadUser: mockCanReadUser,
    canUpdateUser: mockCanUpdateUser,
    canDeleteUser: mockCanDeleteUser,
  },
}));

// Mock authorization service (used by requirePermission guard)
const mockCan = vi.fn();

vi.mock('../../authorization/services/authorization.service.js', () => ({
  authorizationService: {
    can: mockCan,
    hasRole: vi.fn(),
    getPermissionsForRole: vi.fn(),
    getRoles: vi.fn(),
  },
}));

const { registerUserRoutes } = await import('./user.routes.js');
const { authPlugin } = await import('../../../plugins/auth.plugin.js');
const { registerGlobalErrorHandler } = await import('../../../app/app.js');

describe('userRoutes', () => {
  let app: FastifyInstance;

  const mockUser = {
    id: 'user-123',
    email: 'alice@example.com',
    displayName: 'Alice',
    status: 'active',
    role: 'user',
    createdAt: new Date('2026-01-15T09:30:00.000Z'),
    updatedAt: new Date('2026-01-15T09:30:00.000Z'),
  };

  const mockPublicUser = {
    id: 'user-123',
    email: 'alice@example.com',
    displayName: 'Alice',
    status: 'active',
    role: 'user',
    createdAt: '2026-01-15T09:30:00.000Z',
    updatedAt: '2026-01-15T09:30:00.000Z',
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default guard-lookup subject: requireAuth verifies existence per
    // request (M4.6), so every authenticated test starts with a live subject
    // unless it queues its own findById values first.
    mockFindById.mockResolvedValue(mockUser);

    app = Fastify({
      logger: false,
      ajv: {
        customOptions: {
          removeAdditional: false,
          coerceTypes: false,
        },
      },
    });
    registerGlobalErrorHandler(app);
    await app.register(authPlugin);
    await app.register(registerUserRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/v1/users/:id', () => {
    it('returns 200 with PublicUser for authenticated self-read', async () => {
      mockCanReadUser.mockResolvedValueOnce(true);
      mockFindById.mockResolvedValueOnce(mockUser);

      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(mockPublicUser);
    });

    it('returns 200 with PublicUser for admin read', async () => {
      mockCanReadUser.mockResolvedValueOnce(true);
      mockFindById.mockResolvedValueOnce(mockUser);

      const token = app.jwt.sign({ sub: 'admin-user' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(mockPublicUser);
    });

    it('ignores query identity fields and authorizes the path id (M4.4 trust boundary)', async () => {
      mockCanReadUser.mockResolvedValueOnce(true);
      mockFindById.mockResolvedValueOnce(mockUser);

      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/user-123?userId=other-user&ownerId=other-user',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(mockCanReadUser).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user-123' }),
        'user-123',
      );
      expect(mockFindById).toHaveBeenCalledWith('user-123');
    });

    it('returns 401 when not authenticated', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/user-123',
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when policy denies access', async () => {
      mockCanReadUser.mockResolvedValueOnce(false);

      const token = app.jwt.sign({ sub: 'other-user' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.code).toBe('AUTH_FORBIDDEN');
    });

    it('denies when the subject disappears between authentication and policy evaluation (M4.11)', async () => {
      // Deterministic interleaving equivalent: requireAuth observes a live
      // subject (guard lookup hits), then the mapping denies as it does for
      // a deleted/demoted subject. The protected read must not execute.
      mockFindById.mockResolvedValueOnce(mockUser);
      mockCanReadUser.mockResolvedValueOnce(false);

      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(403);
      expect(mockFindById).toHaveBeenCalledTimes(1);
    });

    it('returns 404 when user does not exist', async () => {
      mockCanReadUser.mockResolvedValueOnce(true);
      mockFindById.mockResolvedValueOnce(mockUser);
      mockFindById.mockResolvedValueOnce(null);

      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/nonexistent',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.code).toBe('USERS_NOT_FOUND');
    });

    it('returns 414 for an oversized identifier without touching services (M5.3)', async () => {
      // The explicit maxParamLength transport cap rejects at routing time,
      // before authentication, schemas, or handlers run. The framework 414
      // body echoes the request URL (no stack, SQL, or secrets) — the only
      // security property needed is that nothing is executed or leaked.
      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${'u'.repeat(200)}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(414);
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('stack');
      expect(mockFindById).not.toHaveBeenCalled();
    });

    it('response contains only PublicUser fields', async () => {
      mockCanReadUser.mockResolvedValueOnce(true);
      mockFindById.mockResolvedValueOnce(mockUser);

      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const keys = Object.keys(response.json()).sort();
      expect(keys).toEqual(['createdAt', 'displayName', 'email', 'id', 'role', 'status', 'updatedAt']);
    });

    it('does not expose sensitive fields', async () => {
      mockCanReadUser.mockResolvedValueOnce(true);
      mockFindById.mockResolvedValueOnce(mockUser);

      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const bodyStr = JSON.stringify(response.json());
      expect(bodyStr).not.toContain('passwordHash');
      expect(bodyStr).not.toContain('$2b$');
    });
  });

  describe('PUT /api/v1/users/:id', () => {
    it('returns 200 with updated PublicUser for self-update', async () => {
      mockCanUpdateUser.mockResolvedValueOnce(true);
      const updatedUser = { ...mockUser, displayName: 'Updated Name' };
      mockUpdate.mockResolvedValueOnce(updatedUser);

      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName: 'Updated Name' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().displayName).toBe('Updated Name');
    });

    it('returns 200 with updated PublicUser for admin update', async () => {
      mockCanUpdateUser.mockResolvedValueOnce(true);
      const updatedUser = { ...mockUser, status: 'inactive' };
      mockUpdate.mockResolvedValueOnce(updatedUser);

      const token = app.jwt.sign({ sub: 'admin-user' });
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'inactive' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('inactive');
    });

    it('returns 401 when not authenticated', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/user-123',
        payload: { displayName: 'Updated' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when policy denies access', async () => {
      mockCanUpdateUser.mockResolvedValueOnce(false);

      const token = app.jwt.sign({ sub: 'other-user' });
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName: 'Updated' },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.code).toBe('AUTH_FORBIDDEN');
    });

    it('returns 404 when user does not exist', async () => {
      mockCanUpdateUser.mockResolvedValueOnce(true);
      mockUpdate.mockResolvedValueOnce(null);

      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/nonexistent',
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName: 'Updated' },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.code).toBe('USERS_NOT_FOUND');
    });

    it('silently ignores status field for self-update', async () => {
      mockCanUpdateUser.mockResolvedValueOnce(true);
      mockFindById.mockResolvedValueOnce(mockUser);

      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'inactive' },
      });

      // Should return the existing user (no update performed)
      expect(response.statusCode).toBe(200);
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(response.json().displayName).toBe('Alice');
    });

    it('returns 400 for status with invalid enum value', async () => {
      mockCanUpdateUser.mockResolvedValueOnce(true);

      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'bogus' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 for invalid status value', async () => {
      const token = app.jwt.sign({ sub: 'admin-user' });
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'invalid-status' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when body carries identity fields (M4.4 trust boundary)', async () => {
      for (const payload of [
        { displayName: 'Alice', userId: 'other-user' },
        { displayName: 'Alice', ownerId: 'other-user' },
        { displayName: 'Alice', id: 'other-user' },
      ]) {
        const token = app.jwt.sign({ sub: 'user-123' });
        const response = await app.inject({
          method: 'PUT',
          url: '/api/v1/users/user-123',
          headers: { authorization: `Bearer ${token}` },
          payload,
        });

        expect(response.statusCode).toBe(400);
      }
      expect(mockCanUpdateUser).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    describe('body schema validation (coerceTypes: false)', () => {
      it('rejects displayName as number', async () => {
        mockCanUpdateUser.mockResolvedValueOnce(true);
        const token = app.jwt.sign({ sub: 'user-123' });
        const response = await app.inject({
          method: 'PUT',
          url: '/api/v1/users/user-123',
          headers: { authorization: `Bearer ${token}` },
          payload: { displayName: 12345 },
        });
        expect(response.statusCode).toBe(400);
      });

      it('rejects displayName as boolean', async () => {
        mockCanUpdateUser.mockResolvedValueOnce(true);
        const token = app.jwt.sign({ sub: 'user-123' });
        const response = await app.inject({
          method: 'PUT',
          url: '/api/v1/users/user-123',
          headers: { authorization: `Bearer ${token}` },
          payload: { displayName: true },
        });
        expect(response.statusCode).toBe(400);
      });

      it('rejects displayName as object', async () => {
        mockCanUpdateUser.mockResolvedValueOnce(true);
        const token = app.jwt.sign({ sub: 'user-123' });
        const response = await app.inject({
          method: 'PUT',
          url: '/api/v1/users/user-123',
          headers: { authorization: `Bearer ${token}` },
          payload: { displayName: {} },
        });
        expect(response.statusCode).toBe(400);
      });

      it('rejects displayName as array', async () => {
        mockCanUpdateUser.mockResolvedValueOnce(true);
        const token = app.jwt.sign({ sub: 'user-123' });
        const response = await app.inject({
          method: 'PUT',
          url: '/api/v1/users/user-123',
          headers: { authorization: `Bearer ${token}` },
          payload: { displayName: [] },
        });
        expect(response.statusCode).toBe(400);
      });

      it('rejects additional properties', async () => {
        mockCanUpdateUser.mockResolvedValueOnce(true);
        const token = app.jwt.sign({ sub: 'user-123' });
        const response = await app.inject({
          method: 'PUT',
          url: '/api/v1/users/user-123',
          headers: { authorization: `Bearer ${token}` },
          payload: { foo: 'bar' },
        });
        expect(response.statusCode).toBe(400);
      });

      it('accepts displayName as null', async () => {
        mockCanUpdateUser.mockResolvedValueOnce(true);
        mockUpdate.mockResolvedValueOnce({ ...mockUser, displayName: null });
        const token = app.jwt.sign({ sub: 'user-123' });
        const response = await app.inject({
          method: 'PUT',
          url: '/api/v1/users/user-123',
          headers: { authorization: `Bearer ${token}` },
          payload: { displayName: null },
        });
        expect(response.statusCode).toBe(200);
      });

      it('accepts valid string displayName', async () => {
        mockCanUpdateUser.mockResolvedValueOnce(true);
        mockUpdate.mockResolvedValueOnce({ ...mockUser, displayName: 'Bob' });
        const token = app.jwt.sign({ sub: 'user-123' });
        const response = await app.inject({
          method: 'PUT',
          url: '/api/v1/users/user-123',
          headers: { authorization: `Bearer ${token}` },
          payload: { displayName: 'Bob' },
        });
        expect(response.statusCode).toBe(200);
      });

      it('accepts valid status enum value', async () => {
        mockCanUpdateUser.mockResolvedValueOnce(true);
        mockUpdate.mockResolvedValueOnce({ ...mockUser, status: 'suspended' });
        const token = app.jwt.sign({ sub: 'admin-user' });
        const response = await app.inject({
          method: 'PUT',
          url: '/api/v1/users/user-123',
          headers: { authorization: `Bearer ${token}` },
          payload: { status: 'suspended' },
        });
        expect(response.statusCode).toBe(200);
      });
    });

    it('sets displayName to null when explicitly provided', async () => {
      mockCanUpdateUser.mockResolvedValueOnce(true);
      const updatedUser = { ...mockUser, displayName: null };
      mockUpdate.mockResolvedValueOnce(updatedUser);

      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName: null },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().displayName).toBeNull();
    });
  });

  describe('DELETE /api/v1/users/:id', () => {
    it('returns 204 for successful admin delete', async () => {
      mockCan.mockResolvedValueOnce({ granted: true, reason: 'Granted.' });
      mockCanDeleteUser.mockResolvedValueOnce(true);
      mockRemove.mockResolvedValueOnce(true);

      const token = app.jwt.sign({ sub: 'admin-user' });
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(204);
    });

    it('consults the centralized user policy for the delete decision (M4.3)', async () => {
      mockCan.mockResolvedValueOnce({ granted: true, reason: 'Granted.' });
      mockCanDeleteUser.mockResolvedValueOnce(true);
      mockRemove.mockResolvedValueOnce(true);

      const token = app.jwt.sign({ sub: 'admin-user' });
      await app.inject({
        method: 'DELETE',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(mockCanDeleteUser).toHaveBeenCalledTimes(1);
      expect(mockCanDeleteUser).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'admin-user' }),
        'user-123',
      );
    });

    it('returns 401 when not authenticated', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/users/user-123',
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when user lacks users:delete permission', async () => {
      mockCan.mockResolvedValueOnce({ granted: false, reason: 'Not authorized.' });

      const token = app.jwt.sign({ sub: 'regular-user' });
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.code).toBe('AUTH_FORBIDDEN');
    });

    it('returns 403 when trying to delete self', async () => {
      mockCan.mockResolvedValueOnce({ granted: true, reason: 'Granted.' });
      mockCanDeleteUser.mockResolvedValueOnce(false);

      const token = app.jwt.sign({ sub: 'user-123' });
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/users/user-123',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.detail).toBe('You cannot delete your own account.');
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('returns 404 when user does not exist', async () => {
      mockCan.mockResolvedValueOnce({ granted: true, reason: 'Granted.' });
      mockCanDeleteUser.mockResolvedValueOnce(true);
      mockRemove.mockResolvedValueOnce(false);

      const token = app.jwt.sign({ sub: 'admin-user' });
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/users/nonexistent',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.code).toBe('USERS_NOT_FOUND');
    });
  });
});
