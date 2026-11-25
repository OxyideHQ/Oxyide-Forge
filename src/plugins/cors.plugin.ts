import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import cors from '@fastify/cors';

import { config } from '../config/index.js';

/**
 * CORS policy — strict opt-in allowlist (M5.3).
 *
 * Disabled entirely unless the operator configures `CORS_ALLOWED_ORIGINS`:
 * with no allowlist the plugin registers nothing and responses carry no
 * cross-origin headers (previous behavior preserved exactly).
 *
 * When enabled, origins match exactly against the validated allowlist — no
 * substring, suffix, prefix, or regex matching, and no reflection of the
 * request Origin. Credentials are never enabled: bearer clients need only
 * explicit origins (not cookies), and host-only auth cookies cannot work
 * cross-origin by construction. Preflight is answered by the plugin before
 * any authentication hook runs; disallowed origins receive no
 * `Access-Control-*` headers at all.
 */
const corsPluginCallback: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  if (!config.cors) {
    return;
  }

  const allowedOrigins = config.cors.allowedOrigins;
  await app.register(cors, {
    origin: (origin, callback) => {
      if (typeof origin === 'string' && allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    maxAge: 86400,
  });
};

export const corsPlugin = fp(corsPluginCallback, {
  fastify: '5.x',
  name: 'cors-plugin',
});
