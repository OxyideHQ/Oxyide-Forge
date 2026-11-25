import type { FastifyInstance } from 'fastify';

import { disconnectPrisma } from '../platform/database/prisma.js';
import type { ShutdownPhase } from '../types/shutdown-phase.js';

interface ShutdownState {
  shutdownPromise?: Promise<void>;
  onSigint: () => void;
  onSigterm: () => void;
}

const shutdownStates = new WeakMap<FastifyInstance, ShutdownState>();

/**
 * Observable shutdown phase (M9.4).
 *
 * M91-F12: shutdown previously had no observable beginning. Fastify's `close()`
 * runs `preClose` hooks *after* it marks the instance closing and closes the
 * route tree, but *before* the server stops accepting connections — so probes
 * already riding a keep-alive connection were still served, and
 * `/health/ready` kept answering `200` while the instance was on its way out.
 * An orchestrator therefore had no signal to withdraw traffic from before the
 * listener disappeared.
 *
 * `preClose` is the earliest point at which "shutdown has begun" is true and a
 * request can still be answered, which makes it the only correct place to flip
 * this flag. Everything after it (listener closed, `onClose` hooks, Prisma and
 * Redis cleanup) is too late to influence a response.
 *
 * Why an object rather than a plain boolean: a Fastify decoration is read-only,
 * and the phase must be mutated from inside the hook while being read from the
 * route layer.
 *
 * Scope discipline — this is **not** global state and **not** request state.
 * One object is created per application instance and is unreachable from any
 * other instance, so the multi-instance safety the rest of the health contract
 * depends on is preserved. Frozen M8-F03 forbids global mutable *request* state
 * and AsyncLocalStorage; neither is introduced. It mirrors the existing
 * `shutdownStates` WeakMap pattern already in this file: per-instance lifecycle
 * state, never ambient.
 */
/**
 * Registers the observable shutdown phase and the close hook.
 *
 * `preClose` sets `draining` and nothing else: it makes no readiness decision,
 * duplicates no dependency logic, and touches no route. Readiness is decided
 * only by `evaluateReadiness()`.
 */
export function registerLifecycleHooks(app: FastifyInstance): void {
  const phase: ShutdownPhase = { draining: false };
  app.decorate('shutdownPhase', phase);

  app.addHook('preClose', async () => {
    // Runs while the listener still accepts requests, so any probe served
    // during the drain window observes this. Idempotent: a second close() is a
    // no-op rather than an error.
    phase.draining = true;
  });

  app.addHook('onClose', async () => {
    app.log.info('Fastify application shutting down');

    const state = shutdownStates.get(app);
    if (state) {
      process.off('SIGINT', state.onSigint);
      process.off('SIGTERM', state.onSigterm);
      shutdownStates.delete(app);
    }
  });
}

export function installShutdownHandlers(app: FastifyInstance): void {
  if (shutdownStates.has(app)) {
    return;
  }

  const shutdown = async (signal: string): Promise<void> => {
    const state = shutdownStates.get(app);

    if (!state) {
      return;
    }

    if (!state.shutdownPromise) {
      state.shutdownPromise = (async () => {
        app.log.warn({ signal }, 'Received shutdown signal');

        try {
          await app.close();
        } catch (error: unknown) {
          app.log.error({ err: error }, 'Application shutdown failed');
        } finally {
          try {
            await disconnectPrisma();
          } catch (disconnectError: unknown) {
            app.log.error({ err: disconnectError }, 'Prisma disconnect failed during shutdown');
          }
          process.off('SIGINT', state.onSigint);
          process.off('SIGTERM', state.onSigterm);
          shutdownStates.delete(app);
        }
      })();
    }

    await state.shutdownPromise;
  };

  const onSigint = (): void => {
    void shutdown('SIGINT');
  };
  const onSigterm = (): void => {
    void shutdown('SIGTERM');
  };

  shutdownStates.set(app, { onSigint, onSigterm });
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
}
