import { describe, expect, it, vi } from 'vitest';

import { createCacheService } from './cache.service.js';

function createMockRedis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
  };
}

describe('cacheService', () => {
  describe('get', () => {
    it('returns null when key does not exist', async () => {
      const mock = createMockRedis();
      const service = createCacheService(mock as never);

      const result = await service.get('missing-key');

      expect(result).toBeNull();
      expect(mock.get).toHaveBeenCalledWith('missing-key');
    });

    it('returns the value when key exists', async () => {
      const mock = createMockRedis();
      mock.get.mockResolvedValue('cached-value');
      const service = createCacheService(mock as never);

      const result = await service.get('existing-key');

      expect(result).toBe('cached-value');
    });
  });

  describe('set', () => {
    it('sets a key without TTL', async () => {
      const mock = createMockRedis();
      const service = createCacheService(mock as never);

      await service.set('my-key', 'my-value');

      expect(mock.set).toHaveBeenCalledWith('my-key', 'my-value');
    });

    it('sets a key with TTL in seconds', async () => {
      const mock = createMockRedis();
      const service = createCacheService(mock as never);

      await service.set('my-key', 'my-value', { ttlSeconds: 60 });

      expect(mock.set).toHaveBeenCalledWith('my-key', 'my-value', 'EX', 60);
    });
  });

  describe('del', () => {
    it('deletes a key', async () => {
      const mock = createMockRedis();
      const service = createCacheService(mock as never);

      await service.del('my-key');

      expect(mock.del).toHaveBeenCalledWith('my-key');
    });
  });

  describe('exists', () => {
    it('returns true when key exists', async () => {
      const mock = createMockRedis();
      mock.exists.mockResolvedValue(1);
      const service = createCacheService(mock as never);

      const result = await service.exists('existing-key');

      expect(result).toBe(true);
      expect(mock.exists).toHaveBeenCalledWith('existing-key');
    });

    it('returns false when key does not exist', async () => {
      const mock = createMockRedis();
      mock.exists.mockResolvedValue(0);
      const service = createCacheService(mock as never);

      const result = await service.exists('missing-key');

      expect(result).toBe(false);
    });
  });
});
