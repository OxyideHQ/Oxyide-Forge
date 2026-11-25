import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';

import { config } from '../config/index.js';

/**
 * Cookie plugin — infrastructure-only.
 * Registers @fastify/cookie for cookie parsing and setting.
 * Does not contain authentication business logic.
 * Does not query the database.
 * Does not verify JWTs.
 */
const cookiePluginCallback: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Production CSRF gate: skip cookie registration so Bearer-only production
  // can start. Cookie-based authentication remains disabled until CSRF exists.
  if (!config.auth.cookie.enabled) {
    app.log.warn(
      'Cookie-based authentication is disabled in production until CSRF protection is implemented. Bearer authentication remains available.',
    );
    return;
  }

  await app.register(cookie, {
    hook: 'onRequest',
    parseOptions: {
      httpOnly: config.auth.cookie.httpOnly,
      secure: config.auth.cookie.secure,
      sameSite: config.auth.cookie.sameSite,
      path: config.auth.cookie.path,
      maxAge: config.auth.cookie.maxAge,
    },
  });
};

export const cookiePlugin = fp(cookiePluginCallback, {
  fastify: '5.x',
  name: 'cookie-plugin',
});
