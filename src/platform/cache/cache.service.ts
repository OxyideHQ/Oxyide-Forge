import type { Redis } from 'ioredis';

/**
 * Cache service — application-level cache operations.
 * This is the ONLY module that talks to redis.ts directly.
 * Modules use this service for all cache operations.
 *
 * Redis is optional infrastructure. If Redis is unavailable,
 * operations throw and callers decide failure behavior per feature.
 */
export interface CacheService {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/**
 * Creates a cache service bound to a Redis client.
 * The plugin layer provides the client at startup.
 */
export function createCacheService(client: Redis): CacheService {
  return {
    async get(key: string): Promise<string | null> {
      return client.get(key);
    },

    async set(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
      if (options?.ttlSeconds) {
        await client.set(key, value, 'EX', options.ttlSeconds);
      } else {
        await client.set(key, value);
      }
    },

    async del(key: string): Promise<void> {
      await client.del(key);
    },

    async exists(key: string): Promise<boolean> {
      const result = await client.exists(key);
      return result === 1;
    },
  };
}
