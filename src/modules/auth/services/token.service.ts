import type { FastifyInstance } from 'fastify';

import { ErrorCodes } from '../../../shared/errors/error-codes.js';

export interface AccessTokenPayload {
  sub: string;
}

export interface AccessTokenClaims {
  sub: string;
  iat: number;
  exp: number;
}

export class AuthTokenError extends Error {
  readonly code: string;

  constructor(message: string, code: string = ErrorCodes.AUTH_INVALID_TOKEN) {
    super(message);
    this.name = 'AuthTokenError';
    this.code = code;
  }
}

/**
 * Creates and signs a new access token for the given subject.
 * Delegates to the application's configured @fastify/jwt instance.
 * Token uses HS256 algorithm and 15-minute TTL as configured.
 */
export function createAccessToken(
  app: FastifyInstance,
  payload: AccessTokenPayload,
): string {
  if (!payload || typeof payload.sub !== 'string' || payload.sub.trim() === '') {
    throw new AuthTokenError('Subject (sub) claim is required and must be a non-empty string');
  }

  return app.jwt.sign({ sub: payload.sub }, { expiresIn: 900 });
}

/**
 * Alias for createAccessToken.
 */
export const signAccessToken = createAccessToken;

/**
 * Verifies and decodes an access token.
 * Delegates to the application's configured @fastify/jwt instance.
 * Validates HS256 signature, expiration, and ensures required claims are present.
 */
export function verifyAccessToken(
  app: FastifyInstance,
  token: string,
): AccessTokenClaims {
  if (!token || typeof token !== 'string') {
    throw new AuthTokenError('Token must be a non-empty string');
  }

  try {
    const payload = app.jwt.verify<AccessTokenClaims>(token);

    return {
      sub: payload.sub,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch (error: unknown) {
    if (error instanceof AuthTokenError) {
      throw error;
    }

    const err = error as { code?: string; message?: string };
    if (err.message?.includes('expired')) {
      throw new AuthTokenError('Authorization token expired', ErrorCodes.AUTH_TOKEN_EXPIRED);
    }

    throw new AuthTokenError('Authorization token is invalid', ErrorCodes.AUTH_INVALID_TOKEN);
  }
}

/**
 * Alias for verifyAccessToken.
 */
export const validateAccessToken = verifyAccessToken;

export const tokenService = {
  createAccessToken,
  signAccessToken,
  verifyAccessToken,
  validateAccessToken,
};
