import { afterEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const { buildApp } = await import('../../app/app.js');

describe('health routes', () => {
  const applications: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(applications.map((application) => application.close()));
    applications.length = 0;
  });

  it('returns 200 with an empty object for /health/live, independently of the database', async () => {
    // M9.2: liveness is database-independent by frozen contract (M9-F01), so
    // this suite asserts its exact status and body. No gate is required and
    // none is added — deliberately, because a probe that never touches a
    // dependency must stay provable without one.
    const application = await buildApp();
    applications.push(application);

    const response = await application.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it('ignores the shutdown phase: liveness stays 200 even when draining is set', async () => {
    // M96-01: the liveness handler must never consult shutdown state. During
    // real shutdown Fastify's own short-circuit answers first (M94-F02), so
    // the only window where a draining-aware liveness would differ is a
    // request already past the closing check — which `inject` cannot reach once
    // routes close. This test therefore sets the flag directly on a RUNNING
    // instance, where the transport is fully open: if liveness ever reads
    // `shutdownPhase`, this fails. No database is touched — liveness must stay
    // provable without one.
    const application = await buildApp();
    applications.push(application);

    application.shutdownPhase.draining = true;

    const response = await application.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });
  it('answers /health/ready with an empty object whatever the dependency state', async () => {
    // M9.2: readiness now depends on PostgreSQL, so its status is 200 when the
    // database is usable and 503 when it is not. Pinning one of them here would
    // assert the environment rather than the contract, and would give this
    // database-free suite a hidden dependency on a live server.
    //
    // The exact statuses are frozen where they belong:
    // `health.readiness.integration.test.ts` (real database, simulated outage)
    // and `openapi-contract.test.ts` (the published 200/503 contract).
    const application = await buildApp();
    applications.push(application);

    const response = await application.inject({ method: 'GET', url: '/health/ready' });

    expect([200, 503]).toContain(response.statusCode);
    // The body is an empty object in BOTH states: that is the frozen contract.
    expect(response.json()).toEqual({});
  });
});
