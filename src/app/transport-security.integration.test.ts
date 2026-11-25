import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('./app.js');
const { config } = await import('../config/index.js');
const { buildResetUrl } = await import(
  '../modules/auth/services/password-reset.service.js'
);
const { securityHeadersPlugin } = await import(
  '../plugins/security-headers.plugin.js'
);

let app: FastifyInstance;
let dbAvailable = false;

async function cleanDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EmailVerificationToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "PasswordResetToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "RefreshToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Session" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "LoginThrottle" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Credential" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
}

beforeAll(async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run integration tests with NODE_ENV=production: suites truncate tables.',
    );
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    throw new Error(
      'PostgreSQL unavailable: integration tests require a running database at DATABASE_URL.',
    );
  }

  app = await buildApp();
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await cleanDatabase();
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanDatabase();
  }
  await app?.close();
  await prisma.$disconnect();
});

const EXPECTED_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

type HeaderBag = Record<string, string | string[] | undefined>;
type Probe = { method: 'GET' | 'POST'; url: string; payload?: string | Record<string, unknown> };

function headersOf(response: { headers: unknown }): HeaderBag {
  return response.headers as unknown as HeaderBag;
}

function expectNoHsts(headers: HeaderBag): void {
  expect(headers['strict-transport-security']).toBeUndefined();
}

function expectSecurityHeaders(headers: HeaderBag): void {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    expect(headers[name]).toBe(value);
  }
  expect(String(headers['permissions-policy'])).toContain('camera=()');
  expectNoHsts(headers);
}

/**
 * M5.9 — transport security adversarial suite (live).
 *
 * Proves the no-trust proxy posture under hostile forwarded metadata:
 * spoofed proto/host/for/Forwarded/X-Real-IP values change NOTHING about
 * throttle identity, emailed-link hosts, cookie flags, or CORS behavior —
 * because nothing security-relevant reads them. Also pins the HSTS
 * absence contract (edge-owned; app emits nothing in any environment)
 * and the header matrix on transport-relevant statuses.
 * Covers M59-INV-001…009 and AC-005…017/024…027.
 */
describe('forwarded-header immunity', () => {
  it(
    'X-Forwarded-Proto spoofing never moves throttle buckets or upgrades requests',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `proto-${Date.now()}@example.com`;

      // Rotating proto values (https spoof, http, lists, mixed case,
      // malformed, duplicates) share ONE socket-IP bucket: 5×204 then 429.
      const protos = ['https', 'http', 'https,http', 'HTTPS', 'gopher', 'https, https'];
      for (let i = 0; i < 5; i += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/password-reset/request',
          headers: { 'x-forwarded-proto': protos[i % protos.length] },
          payload: { email },
        });
        expect(response.statusCode).toBe(204);
      }
      const throttled = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        headers: { 'x-forwarded-proto': 'https' },
        payload: { email },
      });
      expect(throttled.statusCode).toBe(429);
    },
  );

  it(
    'Forwarded / X-Real-IP / X-Forwarded-Host never affect throttle identity or responses',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `fwd-${Date.now()}@example.com`;

      for (let i = 0; i < 5; i += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/password-reset/request',
          headers: {
            forwarded: `for=203.0.${i}.1;proto=https;host=evil.example`,
            'x-real-ip': `198.51.100.${i}`,
            'x-forwarded-host': 'evil.example',
            host: 'victim.example',
          },
          payload: { email },
        });
        expect(response.statusCode).toBe(204);
      }
      // Sixth request from the same socket is throttled regardless of the
      // forged identity headers above.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/password-reset/request',
            headers: { forwarded: 'for=203.0.9.9', host: 'victim.example' },
            payload: { email },
          })
        ).statusCode,
      ).toBe(429);
    },
  );

  it(
    'emailed recovery links never inherit request Host (config base only)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      // Pure function of validated config: no request object is even taken.
      const url = buildResetUrl('raw-token-value');
      expect(url.startsWith(config.appBaseUrl)).toBe(true);
      expect(url).not.toContain('evil.example');
      expect(url).not.toContain('victim.example');

      // End to end: forged Host on the request changes nothing observable.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
        payload: { email: `host-${Date.now()}@example.com` },
      });
      expect(response.statusCode).toBe(204);
    },
  );

  it(
    'cookie flags are proxy-independent (config-derived, never protocol-derived)',
    { timeout: 30000 },
    async () => {
      if (!dbAvailable) return;
      const email = `cookie-proto-${Date.now()}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct-horse-battery-staple' },
      });

      // Proto spoof in either direction leaves Set-Cookie attributes
      // identical: test env has Secure off by config, Strict/HttpOnly on.
      for (const proto of ['https', 'http']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { accept: 'text/html', 'x-forwarded-proto': proto },
          payload: { email, password: 'correct-horse-battery-staple' },
        });
        expect(response.statusCode).toBe(200);
        const setCookie = JSON.stringify(response.headers['set-cookie'] ?? '');
        expect(setCookie).toContain('SameSite=Strict');
        expect(setCookie).toContain('HttpOnly');
      }
    },
  );
});

describe('HSTS absence contract (edge-owned)', () => {
  it(
    'emits no HSTS on any status in any environment',
    { timeout: 60000 },
    async () => {
      if (!dbAvailable) return;
      const email = `hsts-${Date.now()}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct-horse-battery-staple' },
      });

      const probes: Probe[] = [
        { method: 'GET', url: '/health/live' },
        {
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email: `hsts2-${Date.now()}@example.com`, password: 'correct-horse-battery-staple' },
        },
        {
          method: 'POST',
          url: '/api/v1/auth/password-reset/request',
          payload: { email: `hsts3-${Date.now()}@example.com` },
        },
        { method: 'POST', url: '/api/v1/auth/register', payload: { email: 'x' } },
        { method: 'GET', url: '/api/v1/auth/me' },
        { method: 'GET', url: '/no-such-route' },
        {
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: JSON.stringify({
            email: `hsts4-${Date.now()}@example.com`,
            password: 'correct-horse-battery-staple',
            displayName: 'x'.repeat(1048576 + 1024),
          }),
        },
      ];

      for (const probe of probes) {
        const response = await app.inject({
          method: probe.method,
          url: probe.url,
          headers: { 'content-type': 'application/json' },
          payload: probe.payload,
        });
        expectNoHsts(headersOf(response));
        expectSecurityHeaders(headersOf(response));
      }
      // No includeSubDomains/preload strings anywhere either.
      for (const probe of probes.slice(0, 3)) {
        const response = await app.inject({
          method: probe.method,
          url: probe.url,
          payload: probe.payload,
        });
        expect(JSON.stringify(response.headers)).not.toContain('includeSubDomains');
        expect(JSON.stringify(response.headers)).not.toContain('preload');
      }
    },
  );

  it('documents the pre-pipeline router-rejection boundary (414/malformed-URL)', async () => {
    // find-my-way emits 414/400 BEFORE the route pipeline exists, so the
    // onSend security headers cannot apply (Fastify exposes no clean
    // interception point — patching router internals is rejected as
    // fragile version-coupling). Documented boundary (M59-F01, LOW):
    // JSON content-type (no sniffing vector), attacker-supplied bounded
    // path only (non-sensitive), NOTHING logged, no HSTS anywhere.
    for (const url of [`/api/v1/users/${'u'.repeat(200)}`, '/%E0%A4%A']) {
      const response = await app.inject({ method: 'GET', url });
      expect([400, 414]).toContain(response.statusCode);
      expect(String(response.headers['content-type'])).toContain('application/json');
      expectNoHsts(headersOf(response));
    }
  });

  it('emits no HSTS on 500 responses (light app with throwing route)', async () => {
    const light = Fastify({ logger: false });
    await light.register(securityHeadersPlugin);
    light.get('/boom', async () => {
      throw new Error('boom');
    });
    await light.ready();

    try {
      const response = await light.inject({ method: 'GET', url: '/boom' });
      expect(response.statusCode).toBe(500);
      expectNoHsts(headersOf(response));
      expectSecurityHeaders(headersOf(response));
    } finally {
      await light.close();
    }
  });
});
