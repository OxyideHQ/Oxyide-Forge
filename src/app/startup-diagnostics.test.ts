import { describe, expect, it } from 'vitest';

import { classifyStartupFailure } from './startup-diagnostics.js';

/**
 * M12.7 — startup diagnostic classification tests.
 *
 * The classifier is the only new behavior in this milestone, so it carries
 * the bulk of the coverage: stable categories for every failure shape the
 * bootstrap can actually throw, deterministic output, remediation for every
 * known variable, and — most importantly — proof that hostile values never
 * appear in any diagnostic string. Zod errors are constructed by hand (not
 * by parsing hostile env through the real schema) so each case is minimal
 * and the invalid *value* under test is explicit.
 */

function zodError(issues: Array<{ path: Array<string | number>; message: string }>) {
  const error = new Error('parse failed') as Error & { issues: unknown };
  Object.defineProperty(error, 'name', { value: 'ZodError' });
  error.issues = issues;
  return error;
}

describe('classifyStartupFailure', () => {
  it('classifies a missing required variable', () => {
    const diagnostic = classifyStartupFailure(
      zodError([{ path: ['DATABASE_URL'], message: 'Required' }]),
    );

    expect(diagnostic.category).toBe('configuration');
    expect(diagnostic.title).toBe('Invalid configuration (DATABASE_URL)');
    expect(diagnostic.details).toEqual(['DATABASE_URL: is missing.']);
    expect(diagnostic.remediation.length).toBeGreaterThan(0);
    expect(diagnostic.remediation.join(' ')).toContain('postgresql://');
    expect(diagnostic.see).toContain('development.md');
  });

  it('classifies an invalid value with its constraint intact', () => {
    const diagnostic = classifyStartupFailure(
      zodError([
        { path: ['JWT_SECRET'], message: 'JWT_SECRET must be at least 32 characters' },
      ]),
    );

    expect(diagnostic.category).toBe('configuration');
    expect(diagnostic.details).toEqual(['JWT_SECRET: JWT_SECRET must be at least 32 characters']);
  });

  it('classifies a partial SMTP group with one title and per-variable lines', () => {
    const diagnostic = classifyStartupFailure(
      zodError([
        { path: ['SMTP_PORT'], message: 'SMTP_PORT is required when SMTP_HOST is set' },
        {
          path: ['SMTP_SECURITY'],
          message: 'SMTP_SECURITY is required when SMTP_HOST is set (one of smtps, starttls, plaintext)',
        },
      ]),
    );

    expect(diagnostic.category).toBe('configuration');
    expect(diagnostic.title).toBe('Invalid configuration');
    expect(diagnostic.details).toHaveLength(2);
    expect(diagnostic.details[0]).toContain('SMTP_PORT');
  });

  it('classifies a port conflict without echoing the address', () => {
    const conflict = Object.assign(
      new Error('listen EADDRINUSE: address already in use 0.0.0.0:9999'),
      { code: 'EADDRINUSE' },
    );
    const diagnostic = classifyStartupFailure(conflict);

    expect(diagnostic.category).toBe('port');
    expect(diagnostic.title).toContain('EADDRINUSE');
    expect(diagnostic.remediation.join(' ')).toContain('PORT=');
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain('0.0.0.0:9999');
    expect(serialized).not.toContain('9999');
  });

  it('classifies an Error as a bootstrap failure', () => {
    const diagnostic = classifyStartupFailure(new Error('plugin exploded'));

    expect(diagnostic.category).toBe('bootstrap');
    expect(diagnostic.details).toHaveLength(1);
    expect(diagnostic.remediation.length).toBeGreaterThan(0);
  });

  it('classifies a non-Error throw as unexpected without crashing', () => {
    for (const thrown of ['string failure', null, undefined, 42]) {
      const diagnostic = classifyStartupFailure(thrown);

      expect(diagnostic.category).toBe('unexpected');
      expect(diagnostic.title).toBe('Unexpected startup failure');
    }
  });

  it('is deterministic', () => {
    const error = zodError([{ path: ['PORT'], message: 'PORT must be a valid TCP port' }]);

    expect(classifyStartupFailure(error)).toEqual(classifyStartupFailure(error));
  });

  it('covers every schema variable with remediation', async () => {
    const { envSchema } = await import('../config/env.schema.js');
    const inner = (
      envSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } }
    )._def.schema;
    const variables = Object.keys(inner.shape);

    expect(variables.length).toBeGreaterThan(0);
    for (const variable of variables) {
      const diagnostic = classifyStartupFailure(
        zodError([{ path: [variable], message: 'Required' }]),
      );

      expect(
        diagnostic.remediation,
        `no remediation for ${variable}`,
      ).not.toEqual(['Correct the value in .env (development) or the process environment (production), then restart.']);
    }
  });
});

describe('bootstrap wiring', () => {
  it('routes every startup failure through classification in main.ts', async () => {
    // Import specifiers and identifier use, never substrings: the entry point
    // must dynamically import the app graph inside its guarded boundary (so
    // import-time configuration throws are caught) and must classify before
    // logging. If either disappears, configuration failures silently revert
    // to raw library dumps.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');

    expect(source).toContain(`import('./app/app.js')`);
    expect(source).toContain('classifyStartupFailure(error)');
    expect(source).toContain('startupFailure');
  });
});

describe('diagnostic secret safety', () => {
  const sentinels = {
    jwt: 'TEST_JWT_SECRET_SHOULD_NEVER_APPEAR_q7',
    dbPassword: 'TEST_DATABASE_PASSWORD_SHOULD_NEVER_APPEAR_w3',
    smtpPassword: 'TEST_SMTP_PASSWORD_SHOULD_NEVER_APPEAR_e8',
    smtpUser: 'TEST_SMTP_USER_SHOULD_NEVER_APPEAR_r4',
  };

  it('falls back safely on malformed issue shapes without throwing', () => {
    const malformed = new Error('parse failed') as Error & { issues: unknown };
    Object.defineProperty(malformed, 'name', { value: 'ZodError' });
    malformed.issues = [
      { path: [], message: 'Required' },
      { path: [42], message: 'Required' },
      { path: ['SMTP_HOST'], message: 42 },
      {},
      null,
    ];

    const diagnostic = classifyStartupFailure(malformed);

    expect(diagnostic.category).toBe('configuration');
    expect(diagnostic.details.length).toBeGreaterThan(0);
    expect(diagnostic.remediation.length).toBeGreaterThan(0);
  });

  it('strips received-value fragments from reproduced messages', () => {
    const diagnostic = classifyStartupFailure(
      zodError([
        {
          path: ['SMTP_SECURITY'],
          message: `Invalid enum value. Expected 'smtps' | 'starttls' | 'plaintext', received '${sentinels.smtpPassword}'`,
        },
      ]),
    );

    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain(sentinels.smtpPassword);
    expect(serialized).toContain("Expected 'smtps' | 'starttls' | 'plaintext'");
  });

  it('the real schema never emits secret values in failures', async () => {
    const { envSchema } = await import('../config/env.schema.js');
    const failures: string[] = [];
    const cases: Array<Record<string, string>> = [
      {
        DATABASE_URL: 'postgresql://localhost:5432/x',
        JWT_SECRET: sentinels.jwt,
        PORT: 'not-a-port',
      },
      {
        DATABASE_URL: `http://dbuser:${sentinels.dbPassword}@localhost:5432/x`,
        JWT_SECRET: 'test-jwt-secret-key-min-32-chars-long',
      },
      {
        DATABASE_URL: 'postgresql://localhost:5432/x',
        JWT_SECRET: 'test-jwt-secret-key-min-32-chars-long',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_SECURITY: 'plaintext',
        SMTP_USER: sentinels.smtpUser,
        SMTP_PASSWORD: sentinels.smtpPassword,
      },
    ];
    for (const input of cases) {
      try {
        envSchema.parse(input);
      } catch (error: unknown) {
        failures.push(JSON.stringify(classifyStartupFailure(error)));
      }
    }

    expect(failures).toHaveLength(3);
    for (const serialized of failures) {
      for (const sentinel of Object.values(sentinels)) {
        expect(serialized, `diagnostic leaked ${sentinel}`).not.toContain(sentinel);
      }
    }
  });

  it('never echoes port numbers or addresses from conflicts', () => {
    const diagnostic = classifyStartupFailure(
      Object.assign(new Error('listen EADDRINUSE: address already in use 10.1.2.3:5432'), {
        code: 'EADDRINUSE',
      }),
    );

    expect(JSON.stringify(diagnostic)).not.toContain('10.1.2.3');
    expect(JSON.stringify(diagnostic)).not.toContain('5432');
  });
});
