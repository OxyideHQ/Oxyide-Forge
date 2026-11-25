import { describe, expect, it } from 'vitest';

import { envSchema } from './env.schema.js';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const { config } = await import('./index.js');
const TEST_DATABASE_URL = 'postgresql://localhost:5432/oxyide_test?sslmode=require';
const TEST_JWT_SECRET = 'test-jwt-secret-key-min-32-chars-long';

describe('environment configuration', () => {
  it('accepts a valid configuration', () => {
    const parsed = envSchema.parse({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: '3000',
      LOG_LEVEL: 'info',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
    });

    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.HOST).toBe('0.0.0.0');
    expect(parsed.PORT).toBe(3000);
    expect(parsed.LOG_LEVEL).toBe('info');
    expect(parsed.JWT_SECRET).toBe(TEST_JWT_SECRET);
  });

  it('uses safe defaults when optional values are missing', () => {
    const parsed = envSchema.parse({
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
    });

    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.HOST).toBe('0.0.0.0');
    expect(parsed.PORT).toBe(3000);
    expect(parsed.LOG_LEVEL).toBe('info');
    expect(parsed.JWT_SECRET).toBe(TEST_JWT_SECRET);
    expect(parsed.APP_BASE_URL).toBe('http://localhost:3000');
  });

  it('accepts an explicit application base URL and strips trailing slashes', () => {
    const parsed = envSchema.parse({
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
      APP_BASE_URL: 'https://app.example.com/',
    });

    expect(parsed.APP_BASE_URL).toBe('https://app.example.com');
  });

  it('rejects a non-URL application base URL', () => {
    expect(() =>
      envSchema.parse({
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: TEST_JWT_SECRET,
        APP_BASE_URL: 'not-a-url',
      }),
    ).toThrow();
  });

  it('rejects a plaintext application base URL in production', () => {
    expect(() =>
      envSchema.parse({
        NODE_ENV: 'production',
        DATABASE_URL: `${TEST_DATABASE_URL}`,
        JWT_SECRET: TEST_JWT_SECRET,
        APP_BASE_URL: 'http://app.example.com',
      }),
    ).toThrow();
  });

  it('rejects an invalid host', () => {
    expect(() =>
      envSchema.parse({
        HOST: 'bad host',
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: TEST_JWT_SECRET,
      }),
    ).toThrow();
  });

  it('rejects an invalid port', () => {
    expect(() =>
      envSchema.parse({
        PORT: '70000',
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: TEST_JWT_SECRET,
      }),
    ).toThrow();
  });

  it('rejects an invalid log level', () => {
    expect(() =>
      envSchema.parse({
        LOG_LEVEL: 'verbose',
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: TEST_JWT_SECRET,
      }),
    ).toThrow();
  });

  it('rejects a missing database URL', () => {
    expect(() =>
      envSchema.parse({
        JWT_SECRET: TEST_JWT_SECRET,
      }),
    ).toThrow();
  });

  it('rejects a missing JWT secret', () => {
    expect(() =>
      envSchema.parse({
        DATABASE_URL: TEST_DATABASE_URL,
      }),
    ).toThrow();
  });

  it('rejects an empty JWT secret', () => {
    expect(() =>
      envSchema.parse({
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: '   ',
      }),
    ).toThrow();
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() =>
      envSchema.parse({
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: 'short-secret',
      }),
    ).toThrow();
  });

  describe('Redis configuration', () => {
    it('accepts a valid Redis URL', () => {
      const parsed = envSchema.parse({
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: TEST_JWT_SECRET,
        REDIS_URL: 'redis://localhost:6379',
      });

      expect(parsed.REDIS_URL).toBe('redis://localhost:6379');
    });

    it('accepts a rediss:// URL for TLS connections', () => {
      const parsed = envSchema.parse({
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: TEST_JWT_SECRET,
        REDIS_URL: 'rediss://redis.example.com:6380',
      });

      expect(parsed.REDIS_URL).toBe('rediss://redis.example.com:6380');
    });

    it('defaults REDIS_URL to undefined when not provided', () => {
      const parsed = envSchema.parse({
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: TEST_JWT_SECRET,
      });

      expect(parsed.REDIS_URL).toBeUndefined();
    });

    it('trims whitespace from REDIS_URL', () => {
      const parsed = envSchema.parse({
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: TEST_JWT_SECRET,
        REDIS_URL: '  redis://localhost:6379  ',
      });

      expect(parsed.REDIS_URL).toBe('redis://localhost:6379');
    });

    it('rejects an invalid REDIS_URL protocol', () => {
      expect(() =>
        envSchema.parse({
          DATABASE_URL: TEST_DATABASE_URL,
          JWT_SECRET: TEST_JWT_SECRET,
          REDIS_URL: 'http://localhost:6379',
        }),
      ).toThrow();
    });

    it('rejects an empty REDIS_URL', () => {
      expect(() =>
        envSchema.parse({
          DATABASE_URL: TEST_DATABASE_URL,
          JWT_SECRET: TEST_JWT_SECRET,
          REDIS_URL: '   ',
        }),
      ).toThrow();
    });

    it('excludes cache config when REDIS_URL is not set', () => {
      expect(config.cache).toBeUndefined();
    });
  });

  describe('SMTP configuration (M11.2)', () => {
    const VALID_SMTP = {
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_SECURITY: 'starttls',
    } as const;

    it('leaves every SMTP variable undefined when unconfigured', () => {
      const parsed = envSchema.parse({
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: TEST_JWT_SECRET,
      });

      expect(parsed.SMTP_HOST).toBeUndefined();
      expect(parsed.SMTP_PORT).toBeUndefined();
      expect(parsed.SMTP_USER).toBeUndefined();
      expect(parsed.SMTP_PASSWORD).toBeUndefined();
      expect(parsed.SMTP_SECURITY).toBeUndefined();
    });

    it('accepts a complete authenticated configuration', () => {
      const parsed = envSchema.parse({
        ...VALID_SMTP,
        SMTP_USER: 'forge',
        SMTP_PASSWORD: 'correct-horse-battery-staple',
      });

      expect(parsed.SMTP_HOST).toBe('smtp.example.com');
      expect(parsed.SMTP_PORT).toBe(587);
      expect(parsed.SMTP_SECURITY).toBe('starttls');
      expect(parsed.SMTP_USER).toBe('forge');
    });

    it('accepts a credential-less development relay with plaintext mode', () => {
      const parsed = envSchema.parse({
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: TEST_JWT_SECRET,
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        SMTP_SECURITY: 'plaintext',
      });

      expect(parsed.SMTP_USER).toBeUndefined();
      expect(parsed.SMTP_PASSWORD).toBeUndefined();
    });

    it('accepts smtps mode', () => {
      const parsed = envSchema.parse({ ...VALID_SMTP, SMTP_SECURITY: 'smtps', SMTP_PORT: '465' });

      expect(parsed.SMTP_SECURITY).toBe('smtps');
      expect(parsed.SMTP_PORT).toBe(465);
    });

    it('rejects a port-only partial configuration without SMTP_HOST', () => {
      expect(() =>
        envSchema.parse({
          DATABASE_URL: TEST_DATABASE_URL,
          JWT_SECRET: TEST_JWT_SECRET,
          SMTP_PORT: '587',
          SMTP_SECURITY: 'starttls',
        }),
      ).toThrow(/SMTP_HOST/);
    });

    it('rejects a missing port when the host is set (no assumed 587)', () => {
      expect(() =>
        envSchema.parse({
          DATABASE_URL: TEST_DATABASE_URL,
          JWT_SECRET: TEST_JWT_SECRET,
          SMTP_HOST: 'smtp.example.com',
          SMTP_SECURITY: 'starttls',
        }),
      ).toThrow(/SMTP_PORT/);
    });

    it('rejects a missing security mode when the host is set (no silent default)', () => {
      expect(() =>
        envSchema.parse({
          DATABASE_URL: TEST_DATABASE_URL,
          JWT_SECRET: TEST_JWT_SECRET,
          SMTP_HOST: 'smtp.example.com',
          SMTP_PORT: '587',
        }),
      ).toThrow(/SMTP_SECURITY/);
    });

    it('rejects an unknown security mode', () => {
      expect(() =>
        envSchema.parse({ ...VALID_SMTP, SMTP_SECURITY: 'ssl' }),
      ).toThrow();
    });

    it.each([['0'], ['65536'], ['587.5'], ['smtp'], ['-25']])(
      'rejects invalid port %s',
      (port) => {
        expect(() =>
          envSchema.parse({ ...VALID_SMTP, SMTP_PORT: port }),
        ).toThrow();
      },
    );

    it('rejects a username without a password', () => {
      expect(() =>
        envSchema.parse({ ...VALID_SMTP, SMTP_USER: 'forge' }),
      ).toThrow(/together/);
    });

    it('rejects a password without a username', () => {
      expect(() =>
        envSchema.parse({ ...VALID_SMTP, SMTP_PASSWORD: 'x'.repeat(16) }),
      ).toThrow(/together/);
    });

    it('rejects credentials with plaintext transport', () => {
      expect(() =>
        envSchema.parse({
          ...VALID_SMTP,
          SMTP_SECURITY: 'plaintext',
          SMTP_USER: 'forge',
          SMTP_PASSWORD: 'correct-horse-battery-staple',
        }),
      ).toThrow(/plaintext/);
    });

    it('rejects an empty host', () => {
      expect(() =>
        envSchema.parse({ ...VALID_SMTP, SMTP_HOST: '   ' }),
      ).toThrow();
    });

    it('does not trim meaningful password whitespace', () => {
      const parsed = envSchema.parse({
        ...VALID_SMTP,
        SMTP_USER: 'forge',
        SMTP_PASSWORD: '  spaced secret  ',
      });

      expect(parsed.SMTP_PASSWORD).toBe('  spaced secret  ');
    });

    it('excludes smtp config when SMTP_HOST is not set', () => {
      expect(config.smtp).toBeUndefined();
    });
  });

  it('does not apply unsafe production secret defaults', () => {
    const parsed = envSchema.parse({
      NODE_ENV: 'production',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
      APP_BASE_URL: 'https://app.example.com',
    });

    expect(parsed.NODE_ENV).toBe('production');
    expect(parsed.HOST).toBe('0.0.0.0');
    expect(parsed.PORT).toBe(3000);
    expect(parsed.LOG_LEVEL).toBe('info');
    expect(parsed.JWT_SECRET).toBe(TEST_JWT_SECRET);
    expect(parsed.APP_BASE_URL).toBe('https://app.example.com');
  });

  it('produces strongly typed configuration values', () => {
    expect(typeof config.host).toBe('string');
    expect(typeof config.port).toBe('number');
    expect(typeof config.logLevel).toBe('string');
    expect(typeof config.databaseUrl).toBe('string');
    expect(typeof config.auth.jwtSecret).toBe('string');
    expect(config.auth.jwtAlgorithm).toBe('HS256');
    expect(config.auth.accessTokenTtlSeconds).toBe(900);
    expect(config.auth.bcryptCostFactor).toBe(12);
    expect(config.auth.cookie.enabled).toBe(config.nodeEnv !== 'production');
    expect(config.auth.refreshTokenTtlSeconds).toBe(604800);
    expect(config.auth.refreshCookie.name).toBe('refreshToken');
    expect(config.auth.refreshCookie.httpOnly).toBe(true);
    expect(config.auth.refreshCookie.path).toBe('/api/v1/auth/refresh');
    expect(config.auth.refreshCookie.enabled).toBe(config.auth.cookie.enabled);
    expect(config.auth.passwordResetTtlSeconds).toBe(3600);
    expect(config.auth.emailVerificationTtlSeconds).toBe(86400);
    expect(config.auth.loginThrottle.accountThreshold).toBe(5);
    expect(config.auth.loginThrottle.accountWindowSeconds).toBe(900);
    expect(config.auth.loginThrottle.ipThreshold).toBe(30);
    expect(config.auth.loginThrottle.ipWindowSeconds).toBe(900);
    expect(config.auth.bruteForce.baseDelayMs).toBe(250);
    expect(config.auth.bruteForce.maxDelayMs).toBe(2000);
    expect(config.auth.bruteForce.escalationStart).toBe(1);
    expect(config.auth.accountLockout.failureThreshold).toBe(5);
    expect(config.auth.accountLockout.lockoutDurationSeconds).toBe(1800);
    expect(config.auth.recoveryThrottle.accountThreshold).toBe(5);
    expect(config.auth.recoveryThrottle.accountWindowSeconds).toBe(3600);
    expect(config.auth.recoveryThrottle.ipThreshold).toBe(30);
    expect(config.auth.recoveryThrottle.ipWindowSeconds).toBe(3600);
    expect(config.auth.passwordPolicy.minLength).toBe(12);
    expect(config.auth.passwordPolicy.maxBytes).toBe(72);
    expect(config.http.bodyLimitBytes).toBe(1048576);
    expect(config.http.maxParamLength).toBe(100);
    expect(typeof config.appBaseUrl).toBe('string');
    // cache is optional — absent when REDIS_URL is not set
    expect(config.cache).toBeUndefined();
  });

  it('does not read process.env outside the config layer', () => {
    expect(config).toBeDefined();
    expect(config.host).toBeTypeOf('string');
    expect(config.auth).toBeDefined();
    // cache is optional — may or may not be present depending on REDIS_URL
  });

  describe('DATABASE_URL connection parameters', () => {
    const baseUrl = 'postgresql://dbuser:dbpass@localhost:5432/oxyide_test';
    const withParams = (params: string): string => `${baseUrl}?${params}`;
    const validEnv = (databaseUrl: string): Record<string, string> => ({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: TEST_JWT_SECRET,
    });

    it('accepts a URL without connection parameters (Prisma defaults apply)', () => {
      const parsed = envSchema.parse(validEnv(baseUrl));

      expect(parsed.DATABASE_URL).toBe(baseUrl);
    });

    it.each([
      ['connection_limit', '1'],
      ['connection_limit', '5'],
      ['connection_limit', '200'],
      ['pool_timeout', '1'],
      ['pool_timeout', '10'],
      ['connect_timeout', '1'],
      ['connect_timeout', '5'],
    ])('accepts valid %s=%s', (name, value) => {
      const parsed = envSchema.parse(validEnv(withParams(`${name}=${value}`)));

      expect(parsed.DATABASE_URL).toBe(withParams(`${name}=${value}`));
    });

    it.each([
      ['connection_limit', '0'],
      ['connection_limit', '-1'],
      ['connection_limit', 'abc'],
      ['connection_limit', '1.5'],
      ['connection_limit', '  '],
      ['pool_timeout', '0'],
      ['pool_timeout', '-5'],
      ['pool_timeout', 'abc'],
      ['pool_timeout', '1.5'],
      ['connect_timeout', '0'],
      ['connect_timeout', '-1'],
      ['connect_timeout', 'abc'],
      ['connect_timeout', '2.5'],
    ])('rejects invalid %s=%s', (name, value) => {
      expect(() => envSchema.parse(validEnv(withParams(`${name}=${value}`)))).toThrow();
    });

    it.each([['connection_limit'], ['pool_timeout'], ['connect_timeout'], ['sslmode']])(
      'rejects a duplicated %s parameter as ambiguous',
      (name) => {
        expect(() =>
          envSchema.parse(validEnv(withParams(`${name}=5&${name}=10`))),
        ).toThrow();
      },
    );

    it('does not echo the URL password in a parameter validation error', () => {
      let message = '';
      try {
        envSchema.parse(validEnv(withParams('connection_limit=abc')));
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).not.toContain('dbpass');
    });

    it('accepts credentials with URL-encoded special characters', () => {
      const parsed = envSchema.parse(
        validEnv('postgresql://dbuser:p%40ss%3Aword@localhost:5432/oxyide_test'),
      );

      expect(parsed.DATABASE_URL).toBe(
        'postgresql://dbuser:p%40ss%3Aword@localhost:5432/oxyide_test',
      );
    });

    it('does not echo encoded credentials when a later parameter is invalid', () => {
      let message = '';
      try {
        envSchema.parse(
          validEnv('postgresql://dbuser:p%40ss%3Aword@localhost:5432/oxyide_test?pool_timeout=abc'),
        );
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).not.toContain('p%40ss');
      expect(message).not.toContain('p@ss');
    });
  });

  describe('DATABASE_URL sslmode', () => {
    const baseUrl = 'postgresql://dbuser:dbpass@localhost:5432/oxyide_test';
    const validEnv = (databaseUrl: string, nodeEnv?: string): Record<string, string> => ({
      ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}),
      DATABASE_URL: databaseUrl,
      JWT_SECRET: TEST_JWT_SECRET,
    });

    it.each(['development', 'test'])('accepts a URL without sslmode in %s', (nodeEnv) => {
      const parsed = envSchema.parse(validEnv(baseUrl, nodeEnv));

      expect(parsed.DATABASE_URL).toBe(baseUrl);
    });

    it.each(['development', 'test'])('accepts sslmode=require in %s', (nodeEnv) => {
      const parsed = envSchema.parse(validEnv(`${baseUrl}?sslmode=require`, nodeEnv));

      expect(parsed.DATABASE_URL).toBe(`${baseUrl}?sslmode=require`);
    });

    it.each(['development', 'test'])('accepts sslmode=disable in %s', (nodeEnv) => {
      const parsed = envSchema.parse(validEnv(`${baseUrl}?sslmode=disable`, nodeEnv));

      expect(parsed.DATABASE_URL).toBe(`${baseUrl}?sslmode=disable`);
    });

    it.each(['verify-ca', 'verify-full', 'prefer', 'allow', 'bogus'])(
      'rejects sslmode=%s (silently ignored by Prisma, so allowing it would mislead)',
      (mode) => {
        expect(() => envSchema.parse(validEnv(`${baseUrl}?sslmode=${mode}`))).toThrow();
      },
    );
  });

  describe('production TLS enforcement', () => {
    const baseUrl = 'postgresql://dbuser:dbpass@localhost:5432/oxyide_prod';

    it('accepts production with sslmode=require', () => {
      const parsed = envSchema.parse({
        NODE_ENV: 'production',
        DATABASE_URL: `${baseUrl}?sslmode=require`,
        JWT_SECRET: TEST_JWT_SECRET,
        APP_BASE_URL: 'https://app.example.com',
      });

      expect(parsed.NODE_ENV).toBe('production');
    });

    it.each([[undefined], ['disable'], ['verify-full'], ['bogus']])(
      'rejects production with sslmode=%s',
      (mode) => {
        const databaseUrl = mode === undefined ? baseUrl : `${baseUrl}?sslmode=${mode}`;
        let message = '';
        try {
          envSchema.parse({
            NODE_ENV: 'production',
            DATABASE_URL: databaseUrl,
            JWT_SECRET: TEST_JWT_SECRET,
          });
        } catch (error: unknown) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toContain('sslmode=require');
        expect(message).not.toContain('dbpass');
      },
    );

    it('accepts production with a complete SMTP configuration (mail works in prod)', () => {
      const parsed = envSchema.parse({
        NODE_ENV: 'production',
        DATABASE_URL: `${baseUrl}?sslmode=require`,
        JWT_SECRET: TEST_JWT_SECRET,
        APP_BASE_URL: 'https://app.example.com',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_SECURITY: 'starttls',
        SMTP_USER: 'forge',
        SMTP_PASSWORD: 'correct-horse-battery-staple',
      });

      expect(parsed.SMTP_SECURITY).toBe('starttls');
      expect(parsed.SMTP_PORT).toBe(587);
    });

    it('accepts production with SMTP unconfigured (NoOp stays valid in prod)', () => {
      const parsed = envSchema.parse({
        NODE_ENV: 'production',
        DATABASE_URL: `${baseUrl}?sslmode=require`,
        JWT_SECRET: TEST_JWT_SECRET,
        APP_BASE_URL: 'https://app.example.com',
      });

      expect(parsed.SMTP_HOST).toBeUndefined();
    });
  });
});

describe('configuration immutability (M5.2)', () => {
  it('freezes the canonical config object at every level', () => {
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.auth)).toBe(true);
    expect(Object.isFrozen(config.auth.loginThrottle)).toBe(true);
    expect(Object.isFrozen(config.auth.bruteForce)).toBe(true);
    expect(Object.isFrozen(config.auth.accountLockout)).toBe(true);
    expect(Object.isFrozen(config.auth.cookie)).toBe(true);
    expect(Object.isFrozen(config.auth.refreshCookie)).toBe(true);
    expect(Object.isFrozen(config.http)).toBe(true);
  });

  it('throws on top-level reassignment instead of widening access', () => {
    expect(() => {
      config.port = 9999;
    }).toThrow(TypeError);
    expect(config.port).not.toBe(9999);
  });

  it('throws on nested security-policy mutation', () => {
    expect(() => {
      config.auth.loginThrottle.accountThreshold = 999;
    }).toThrow(TypeError);
    expect(() => {
      config.auth.cookie.secure = false;
    }).toThrow(TypeError);
    expect(config.auth.loginThrottle.accountThreshold).toBe(5);
    expect(config.auth.cookie.secure).toBe(process.env.NODE_ENV === 'production');
  });
});

describe('configuration secret safety (M5.2)', () => {
  function serializedFailure(input: Record<string, string>): string {
    try {
      envSchema.parse(input);
    } catch (error: unknown) {
      return JSON.stringify(error);
    }
    expect.unreachable('expected configuration validation to fail');
  }

  it('never echoes the JWT secret in validation failures', () => {
    const fragment = 'zz9-secret-fragment';
    const serialized = serializedFailure({
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: fragment,
    });
    expect(serialized).not.toContain(fragment);
  });

  it('never echoes database credentials in URL validation failures', () => {
    const badProtocol = serializedFailure({
      DATABASE_URL: 'http://dbuser:dbpass123@localhost:5432/oxyide_test',
      JWT_SECRET: TEST_JWT_SECRET,
    });
    expect(badProtocol).not.toContain('dbpass123');
    expect(badProtocol).not.toContain('dbuser');
  });

  it('never echoes the SMTP password in coherence failures', () => {
    const userSentinel = 'smtp-user-sentinel-9x';
    const passwordSentinel = 'smtp-password-sentinel-8q';
    const serialized = serializedFailure({
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_SECURITY: 'plaintext',
      SMTP_USER: userSentinel,
      SMTP_PASSWORD: passwordSentinel,
    });
    expect(serialized).not.toContain(passwordSentinel);
    expect(serialized).not.toContain(userSentinel);
  });

  it('never echoes SMTP credentials in partial-configuration failures', () => {
    const passwordSentinel = 'smtp-lone-password-sentinel-7z';
    const serialized = serializedFailure({
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
      SMTP_PASSWORD: passwordSentinel,
    });
    expect(serialized).not.toContain(passwordSentinel);
  });
});

describe('CORS origin allowlist (M5.3)', () => {
  it('leaves CORS disabled when unconfigured', () => {
    const parsed = envSchema.parse({
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
    });

    expect(parsed.CORS_ALLOWED_ORIGINS).toBeUndefined();
  });

  it('accepts explicit origins and strips trailing slashes', () => {
    const parsed = envSchema.parse({
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
      CORS_ALLOWED_ORIGINS: 'https://app.example.com/, http://localhost:3000',
    });

    expect(parsed.CORS_ALLOWED_ORIGINS).toEqual([
      'https://app.example.com',
      'http://localhost:3000',
    ]);
  });

  it('deduplicates repeated origins deterministically', () => {
    const parsed = envSchema.parse({
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
      CORS_ALLOWED_ORIGINS: 'https://app.example.com, https://app.example.com',
    });

    expect(parsed.CORS_ALLOWED_ORIGINS).toEqual(['https://app.example.com']);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['empty entry', 'https://app.example.com,'],
    ['double comma', 'https://a.example,,https://b.example'],
    ['non-URL', 'not-a-url'],
    ['non-HTTP scheme', 'ftp://app.example.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data URL', 'data:text/plain,hi'],
    ['path present', 'https://app.example.com/spa'],
    ['query present', 'https://app.example.com?x=1'],
    ['userinfo present', 'https://user@app.example.com'],
  ])('rejects %s', (_label, value) => {
    expect(() =>
      envSchema.parse({
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: TEST_JWT_SECRET,
        CORS_ALLOWED_ORIGINS: value,
      }),
    ).toThrow();
  });
});

describe('API documentation flags (M7.6)', () => {
  const base = {
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_SECRET: TEST_JWT_SECRET,
  };

  it('parses both flags into booleans with the documented defaults', () => {
    const parsed = envSchema.parse(base);

    // OpenAPI on everywhere; UI on except production (absent stays
    // undefined so the production default can be applied centrally).
    expect(parsed.OPENAPI_ENABLED).toBe(true);
    expect(parsed.SWAGGER_UI_ENABLED).toBeUndefined();
  });

  it('accepts the three valid operator combinations', () => {
    expect(
      envSchema.parse({ ...base, OPENAPI_ENABLED: 'true', SWAGGER_UI_ENABLED: 'true' }),
    ).toMatchObject({ OPENAPI_ENABLED: true, SWAGGER_UI_ENABLED: true });
    expect(
      envSchema.parse({ ...base, OPENAPI_ENABLED: 'true', SWAGGER_UI_ENABLED: 'false' }),
    ).toMatchObject({ OPENAPI_ENABLED: true, SWAGGER_UI_ENABLED: false });
    expect(
      envSchema.parse({ ...base, OPENAPI_ENABLED: 'false', SWAGGER_UI_ENABLED: 'false' }),
    ).toMatchObject({ OPENAPI_ENABLED: false, SWAGGER_UI_ENABLED: false });
  });

  it('tolerates surrounding whitespace around the boolean literal but not other casing', () => {
    expect(
      envSchema.parse({ ...base, OPENAPI_ENABLED: ' false ', SWAGGER_UI_ENABLED: ' false ' }),
    ).toMatchObject({ OPENAPI_ENABLED: false, SWAGGER_UI_ENABLED: false });
    expect(() => envSchema.parse({ ...base, OPENAPI_ENABLED: 'TRUE' })).toThrow();
  });

  it.each(['1', '0', 'yes', 'no', 'abc', 'TRUE', ''])('rejects %o as an OpenAPI flag', (value) => {
    expect(() => envSchema.parse({ ...base, OPENAPI_ENABLED: value })).toThrow();
  });

  it.each(['1', 'yes', 'abc', ''])('rejects %o as a Swagger UI flag', (value) => {
    expect(() => envSchema.parse({ ...base, SWAGGER_UI_ENABLED: value })).toThrow();
  });

  it('rejects Swagger UI without OpenAPI instead of silently enabling it', () => {
    expect(() =>
      envSchema.parse({ ...base, OPENAPI_ENABLED: 'false', SWAGGER_UI_ENABLED: 'true' }),
    ).toThrow('SWAGGER_UI_ENABLED requires OPENAPI_ENABLED');
  });

  it('rejects the invalid combination implied by the development UI default', () => {
    // Unset UI defaults to on outside production, so `OPENAPI_ENABLED=false`
    // alone is an invalid request — it asks for nothing to be served.
    expect(() => envSchema.parse({ ...base, OPENAPI_ENABLED: 'false' })).toThrow(
      /SWAGGER_UI_ENABLED requires OPENAPI_ENABLED/,
    );
  });

  it('treats an unset UI flag as off in production, where the default is off', () => {
    const parsed = envSchema.parse({
      ...base,
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://app.example.com',
      OPENAPI_ENABLED: 'false',
    });

    expect(parsed.OPENAPI_ENABLED).toBe(false);
    expect(parsed.SWAGGER_UI_ENABLED).toBeUndefined();
    // Requesting the UI explicitly is still rejected.
    expect(() =>
      envSchema.parse({
        ...base,
        NODE_ENV: 'production',
        APP_BASE_URL: 'https://app.example.com',
        OPENAPI_ENABLED: 'false',
        SWAGGER_UI_ENABLED: 'true',
      }),
    ).toThrow(/SWAGGER_UI_ENABLED requires OPENAPI_ENABLED/);
  });

  it('allows disabling the UI in production while keeping the document', () => {
    const parsed = envSchema.parse({
      ...base,
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://app.example.com',
      DATABASE_URL: `${TEST_DATABASE_URL.split('?')[0]}?sslmode=require`,
      OPENAPI_ENABLED: 'true',
      SWAGGER_UI_ENABLED: 'false',
    });

    expect(parsed.OPENAPI_ENABLED).toBe(true);
    expect(parsed.SWAGGER_UI_ENABLED).toBe(false);
  });

  it('exposes both capabilities as frozen booleans on the canonical config', () => {
    expect(config.docs).toEqual({ openApiEnabled: true, swaggerUiEnabled: true });
    expect(Object.isFrozen(config.docs)).toBe(true);
  });

  it('does not echo flag values or secrets in validation failures', () => {
    let message = '';
    try {
      envSchema.parse({ ...base, OPENAPI_ENABLED: 'false', SWAGGER_UI_ENABLED: 'true' });
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain('SWAGGER_UI_ENABLED requires OPENAPI_ENABLED');
    expect(message).not.toContain(TEST_JWT_SECRET);
    expect(message).not.toContain('dbpass');
  });
});
