/**
 * M9.5 — graceful shutdown must be armed before the socket is open.
 *
 * `startServer` used to install the SIGINT/SIGTERM handlers *after*
 * `app.listen()` resolved. In that window the server was already accepting
 * connections while signals fell through to Node's default behavior — an abrupt
 * exit with no drain, precisely when a container stop is most likely to arrive.
 *
 * These tests pin the ordering, prove the handlers are removed again on close so
 * they cannot leak, and prove repeated arming stays idempotent.
 */

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { buildApp } = await import('./app.js');
const { startServer } = await import('./server.js');
const { installShutdownHandlers } = await import('./lifecycle.js');
const { prisma } = await import('../platform/database/prisma.js');

const signalListeners = (): number =>
  process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    throw new Error('PostgreSQL unavailable: this suite requires a running database.');
  }
});

describe('M9.5 startServer signal handling', () => {
  // Each test binds the configured port for real, so every instance is closed
  // before the next one starts; leaving them open would collide on EADDRINUSE.
  let instance: FastifyInstance | undefined;

  afterEach(async () => {
    if (instance !== undefined) {
      await instance.close();
      instance = undefined;
    }
  });

  it('arms the shutdown handlers before the listener opens', async () => {
    const baseline = signalListeners();
    instance = await buildApp({ loggerStream: process.stderr });

    let atListenTime: number | undefined;
    // Record the process listener count at the moment `listen()` is invoked —
    // the assertion that distinguishes "armed before" from "armed after".
    const original = instance.listen.bind(instance);
    const spy = vi.spyOn(instance, 'listen');
    spy.mockImplementation(((...args: unknown[]) => {
      atListenTime = signalListeners();
      return (original as (...a: unknown[]) => unknown)(...args);
    }) as typeof instance.listen);

    await startServer(instance);

    expect(atListenTime).toBe(baseline + 2);
    expect(signalListeners()).toBe(baseline + 2);
  });

  it('does not leak process listeners across a start/close cycle', async () => {
    const baseline = signalListeners();
    instance = await buildApp({ loggerStream: process.stderr });

    await startServer(instance);
    expect(signalListeners()).toBe(baseline + 2);

    await instance.close();
    instance = undefined;

    // `onClose` removes them again, so a repeated start/stop cycle cannot
    // accumulate process listeners — the failure mode that turns many restarts
    // into a crash.
    expect(signalListeners()).toBe(baseline);
  });

  it('stays idempotent when arming is requested more than once', async () => {
    const baseline = signalListeners();
    instance = await buildApp({ loggerStream: process.stderr });

    await startServer(instance);
    installShutdownHandlers(instance);
    installShutdownHandlers(instance);

    expect(signalListeners()).toBe(baseline + 2);

    await instance.close();
    instance = undefined;
    expect(signalListeners()).toBe(baseline);
  });

  it('exposes the drain signal once shutdown begins', async () => {
    const app = await buildApp({ loggerStream: process.stderr });
    instance = app;
    await startServer(app);

    expect(app.shutdownPhase.draining).toBe(false);

    // `preClose` runs asynchronously inside close(), so the flag is observed
    // after the close settles rather than synchronously — the same ordering
    // constraint M9.4 established for the drain window.
    await app.close();
    instance = undefined;

    expect(app.shutdownPhase.draining).toBe(true);
  });
});
