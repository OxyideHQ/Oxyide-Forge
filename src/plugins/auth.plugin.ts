import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { config } from '../config/index.js';
import type { AuthContext } from '../types/auth-context.js';
import { AppError } from '../shared/errors/app-error.js';
import { ErrorCodes } from '../shared/errors/error-codes.js';

const authPluginCallback: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  await app.register(fastifyJwt, {
    secret: config.auth.jwtSecret,
    sign: {
      algorithm: config.auth.jwtAlgorithm,
    },
    verify: {
      algorithms: [config.auth.jwtAlgorithm],
    },
  });

  app.decorateRequest('auth', undefined);

  function unauthorized(detail: string, code: string = ErrorCodes.AUTH_INVALID_TOKEN): AppError {
    return new AppError(code, 401, detail, { title: 'Unauthorized' });
  }

  app.decorate(
    'authenticate',
    // Throws AppError on any failure (M6.2): the centralized mapper builds
    // the public body and the WWW-Authenticate header. Never replies
    // directly. Success attaches request.auth with no reply side effects.
    async (request: FastifyRequest): Promise<void> => {
      // Transport extraction: bearer header or access-token cookie, never both.
      // Both transports feed the single JWT verification pipeline below, so
      // authentication semantics are identical regardless of transport. Cookie
      // parsing is provided by the cookie plugin; when it is not registered
      // (unit scope, production gate) request.cookies is undefined and the
      // cookie transport is inert — bearer-only behavior is preserved.
      const authHeader = request.headers.authorization;
      const hasBearer = typeof authHeader === 'string' && authHeader.length > 0;
      const cookieToken = request.cookies?.[config.auth.cookie.name];
      const hasCookie = typeof cookieToken === 'string' && cookieToken.length > 0;

      // api-conventions §15.2: exactly one mechanism per request.
      if (hasBearer && hasCookie) {
        throw unauthorized(
          'Authentication credentials were not provided or are invalid.',
          ErrorCodes.AUTH_INVALID_TOKEN,
        );
      }

      let token: string;
      if (hasBearer) {
        const [scheme, value] = (authHeader as string).split(' ');
        if (scheme !== 'Bearer' || !value) {
          throw unauthorized(
            'Authorization header must follow "Bearer <token>" format.',
            ErrorCodes.AUTH_INVALID_TOKEN,
          );
        }
        token = value;
      } else if (hasCookie) {
        token = cookieToken as string;
      } else {
        throw unauthorized(
          'Authentication credentials were not provided or are invalid.',
          ErrorCodes.AUTH_INVALID_TOKEN,
        );
      }

      try {
        const payload = app.jwt.verify<{ sub: string; iat: number; exp: number }>(token);

        if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
          throw unauthorized('Authentication token is invalid.');
        }

        const authContext: AuthContext = {
          sub: payload.sub,
          iat: payload.iat,
          exp: payload.exp,
        };

        request.auth = authContext;
      } catch (error: unknown) {
        if (error instanceof AppError) {
          throw error;
        }
        const isExpired = error instanceof Error && error.message?.includes('expired');
        throw unauthorized(
          isExpired ? 'Authentication token has expired.' : 'Authentication token is invalid.',
          isExpired ? ErrorCodes.AUTH_TOKEN_EXPIRED : ErrorCodes.AUTH_INVALID_TOKEN,
        );
      }
    },
  );
};

export const authPlugin = fp(authPluginCallback, {
  fastify: '5.x',
  name: 'auth-plugin',
});
