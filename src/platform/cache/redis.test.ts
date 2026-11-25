import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

// Mock ioredis before importing the module under test.
const mockQuit = vi.fn().mockResolvedValue('OK');
const mockConnect = vi.fn().mockResolvedValue(undefined);

vi.mock('ioredis', () => {
  return {
    Redis: vi.fn().mockImplementation(() => ({
      quit: mockQuit,
      connect: mockConnect,
      on: vi.fn().mockReturnThis(),
      status: 'ready',
    })),
  };
});

const { createRedisClient, disconnectRedis } = await import('./redis.js');

describe('Redis client', () => {
  describe('createRedisClient', () => {
    it('creates a Redis client with the configured URL', async () => {
      const { Redis } = await import('ioredis');
      createRedisClient('redis://localhost:6379');

      expect(Redis).toHaveBeenCalledWith(
        'redis://localhost:6379',
        expect.objectContaining({
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          lazyConnect: true,
        }),
      );
    });

    it('creates a client with rediss:// protocol for TLS connections', async () => {
      const { Redis } = await import('ioredis');
      createRedisClient('rediss://redis.example.com:6380');

      expect(Redis).toHaveBeenCalledWith(
        'rediss://redis.example.com:6380',
        expect.objectContaining({
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          lazyConnect: true,
        }),
      );
    });

    it('returns a client instance', () => {
      const client = createRedisClient('redis://localhost:6379');
      expect(client).toBeDefined();
    });
  });

  describe('disconnectRedis', () => {
    it('calls quit when client is ready', async () => {
      const client = createRedisClient('redis://localhost:6379');
      (client as { status: string }).status = 'ready';
      mockQuit.mockClear();

      await disconnectRedis(client);
      expect(mockQuit).toHaveBeenCalled();
    });

    it('calls quit when client is connecting', async () => {
      const client = createRedisClient('redis://localhost:6379');
      (client as { status: string }).status = 'connect';
      mockQuit.mockClear();

      await disconnectRedis(client);
      expect(mockQuit).toHaveBeenCalled();
    });

    it('does not call quit when client is already ended', async () => {
      const client = createRedisClient('redis://localhost:6379');
      (client as { status: string }).status = 'end';
      mockQuit.mockClear();

      await disconnectRedis(client);
      expect(mockQuit).not.toHaveBeenCalled();
    });

    it('does not call quit when client is in wait-ready state', async () => {
      const client = createRedisClient('redis://localhost:6379');
      (client as { status: string }).status = 'wait';
      mockQuit.mockClear();

      await disconnectRedis(client);
      expect(mockQuit).not.toHaveBeenCalled();
    });
  });
});
