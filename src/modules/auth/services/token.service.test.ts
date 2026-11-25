import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const { authPlugin } = await import('../../../plugins/auth.plugin.js');

const {
  createAccessToken,
  signAccessToken,
  verifyAccessToken,
  validateAccessToken,
  tokenService,
  AuthTokenError,
} = await import('./token.service.js');

describe('tokenService', () => {
  const userId = 'usr_1234567890abcdef';

  async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.ready();
    return app;
  }

  it('successfully creates an access token with three JWT segments', async () => {
    const app = await buildTestApp();
    try {
      const token = createAccessToken(app, { sub: userId });

      expect(typeof token).toBe('string');
      const segments = token.split('.');
      expect(segments.length).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('successfully verifies a valid access token and returns correct claims', async () => {
    const app = await buildTestApp();
    try {
      const token = createAccessToken(app, { sub: userId });
      const claims = verifyAccessToken(app, token);

      expect(claims.sub).toBe(userId);
      expect(typeof claims.iat).toBe('number');
      expect(typeof claims.exp).toBe('number');
    } finally {
      await app.close();
    }
  });

  it('returns the correct subject claim', async () => {
    const app = await buildTestApp();
    try {
      const specificSub = 'usr_unique_identifier_999';
      const token = createAccessToken(app, { sub: specificSub });
      const claims = verifyAccessToken(app, token);

      expect(claims.sub).toBe(specificSub);
    } finally {
      await app.close();
    }
  });

  it('sets expiration following the documented 15-minute (900-second) TTL', async () => {
    const app = await buildTestApp();
    try {
      const token = createAccessToken(app, { sub: userId });
      const claims = verifyAccessToken(app, token);

      expect(claims.exp - claims.iat).toBe(900);
    } finally {
      await app.close();
    }
  });

  it('contains ONLY the documented claims (sub, iat, exp)', async () => {
    const app = await buildTestApp();
    try {
      const token = createAccessToken(app, { sub: userId });
      const claims = verifyAccessToken(app, token);

      const claimKeys = Object.keys(claims).sort();
      expect(claimKeys).toEqual(['exp', 'iat', 'sub']);
    } finally {
      await app.close();
    }
  });

  it('fails verification on an invalid or tampered token', async () => {
    const app = await buildTestApp();
    try {
      const token = createAccessToken(app, { sub: userId });
      const tamperedToken = token.slice(0, -5) + 'xxxxx';

      expect(() => verifyAccessToken(app, tamperedToken)).toThrow(AuthTokenError);
    } finally {
      await app.close();
    }
  });

  it('fails verification on a malformed token', async () => {
    const app = await buildTestApp();
    try {
      expect(() => verifyAccessToken(app, 'not.a.valid.jwt.token')).toThrow(AuthTokenError);
      expect(() => verifyAccessToken(app, 'invalid-string')).toThrow(AuthTokenError);
      expect(() => verifyAccessToken(app, '')).toThrow(AuthTokenError);
    } finally {
      await app.close();
    }
  });

  it('fails verification on an expired token with AUTH_TOKEN_EXPIRED error code', async () => {
    const app = await buildTestApp();
    try {
      const expiredToken = app.jwt.sign(
        { sub: userId },
        { expiresIn: -1 },
      );

      let caughtError: unknown;
      try {
        verifyAccessToken(app, expiredToken);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(AuthTokenError);
      expect((caughtError as InstanceType<typeof AuthTokenError>).code).toBe('AUTH_TOKEN_EXPIRED');
    } finally {
      await app.close();
    }
  });

  it('fails verification when token is signed with a different secret', async () => {
    // Construct a JWT manually with a different key
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: userId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 }),
    ).toString('base64url');
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', 'completely-different-signing-secret-key-that-is-long-enough-for-hs256')
      .update(`${header}.${payload}`)
      .digest('base64url');
    const foreignToken = `${header}.${payload}.${signature}`;

    const app = await buildTestApp();
    try {
      expect(() => verifyAccessToken(app, foreignToken)).toThrow(AuthTokenError);
    } finally {
      await app.close();
    }
  });

  it('rejects empty or invalid subject during token creation', async () => {
    const app = await buildTestApp();
    try {
      expect(() => createAccessToken(app, { sub: '' })).toThrow(AuthTokenError);
      expect(() => createAccessToken(app, { sub: '   ' })).toThrow(AuthTokenError);
    } finally {
      await app.close();
    }
  });

  it('provides signAccessToken and validateAccessToken aliases matching create and verify', async () => {
    const app = await buildTestApp();
    try {
      const token = signAccessToken(app, { sub: userId });
      const claims = validateAccessToken(app, token);

      expect(claims.sub).toBe(userId);
    } finally {
      await app.close();
    }
  });

  it('exports tokenService object containing all token operations', () => {
    expect(tokenService.createAccessToken).toBe(createAccessToken);
    expect(tokenService.signAccessToken).toBe(signAccessToken);
    expect(tokenService.verifyAccessToken).toBe(verifyAccessToken);
    expect(tokenService.validateAccessToken).toBe(validateAccessToken);
  });
});
