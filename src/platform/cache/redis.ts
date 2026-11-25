import { Redis } from 'ioredis';

/**
 * Redis client — platform-level infrastructure.
 * Owns client construction and connection lifecycle.
 * Modules must not import this file directly; use the cache service.
 *
 * Redis is optional infrastructure. This module exports factory functions;
 * the plugin layer decides when to create a client.
 */

const DEFAULT_OPTIONS = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
} as const;

/**
 * Creates a Redis client configured for the application.
 * The client starts in lazy mode and must be connected explicitly.
 */
export function createRedisClient(url: string): Redis {
  return new Redis(url, DEFAULT_OPTIONS);
}

/**
 * Disconnects a Redis client gracefully.
 * No-op if the client is already disconnected.
 */
export async function disconnectRedis(client: Redis): Promise<void> {
  if (client.status === 'ready' || client.status === 'connect') {
    await client.quit();
  }
}
