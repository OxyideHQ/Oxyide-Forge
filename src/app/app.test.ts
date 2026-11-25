import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const [{ config }, { buildApp }, { installShutdownHandlers }] = await Promise.all([
  import('../config/index.js'),
  import('./app.js'),
  import('./lifecycle.js'),
]);

describe('Fastify application bootstrap', () => {
  const applications: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(applications.map((application) => application.close()));
    applications.length = 0;
  });

  it('creates an application with the centralized log configuration', async () => {
    const application = await buildApp();
    applications.push(application);

    expect(application.log.level).toBe(config.logLevel);
  });

  it('does not register undocumented public endpoints', async () => {
    const application = await buildApp();
    applications.push(application);

    const response = await application.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(404);
  });

  it('closes cleanly', async () => {
    const application = await buildApp();

    await expect(application.close()).resolves.toBeUndefined();
  });

  it('installs shutdown handlers only once per application and cleans them up', async () => {
    const application = await buildApp();
    const sigintListenersBefore = process.listenerCount('SIGINT');
    const sigtermListenersBefore = process.listenerCount('SIGTERM');

    installShutdownHandlers(application);
    installShutdownHandlers(application);

    expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListenersBefore + 1);

    await application.close();

    expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListenersBefore);
  });

  it('starts in production with cookie authentication disabled', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const baseUrl = (process.env.DATABASE_URL ?? 'postgresql://localhost:5432/oxyide_test').split(
      '?',
    )[0];
    vi.stubEnv('DATABASE_URL', `${baseUrl}?sslmode=require`);
    vi.stubEnv('APP_BASE_URL', 'https://app.example.com');
    vi.resetModules();

    const { config: prodConfig } = await import('../config/index.js');
    const { buildApp: buildProdApp } = await import('./app.js');

    expect(prodConfig.nodeEnv).toBe('production');
    expect(prodConfig.auth.cookie.enabled).toBe(false);

    const application = await buildProdApp();
    const response = await application.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});

    await application.close();

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
