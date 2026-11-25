import pino from 'pino';

import { createLoggerOptions } from './shared/logging/logger-options.js';
import type { FastifyInstance } from 'fastify';
import { classifyStartupFailure } from './app/startup-diagnostics.js';

// Same centralized boundary as the application pipeline (M5.6): fatal
// startup/shutdown errors are serialized and redacted identically. The
// level stays at the Pino default here deliberately — this logger must
// work even when configuration parsing itself has failed, so it cannot
// depend on config.
const startupLogger = pino(createLoggerOptions());

async function bootstrap(): Promise<void> {
  // The application graph is imported here — inside the guarded boundary —
  // rather than at module top level. Configuration is parsed at import time
  // (src/config/index.ts), so a static import would let a config failure
  // bypass this handler entirely and surface as a raw library dump. Deferred
  // imports route every startup failure, including invalid configuration,
  // through the single classified fatal path below. Type-only imports stay
  // static: they are erased at compile time and evaluate nothing.
  let app: FastifyInstance | undefined;
  let disconnectPrisma: (() => Promise<void>) | undefined;

  try {
    const [appModule, serverModule, prismaModule] = await Promise.all([
      import('./app/app.js'),
      import('./app/server.js'),
      import('./platform/database/prisma.js'),
    ]);
    disconnectPrisma = prismaModule.disconnectPrisma;
    app = await appModule.buildApp();
    await serverModule.startServer(app);
  } catch (error: unknown) {
    const logger = app?.log ?? startupLogger;
    // Developer/operator diagnostic (M12.7): stable category, safe detail
    // lines, and remediation attached as structured fields. The raw error is
    // still logged as `err` for the operator pipeline — classification never
    // replaces it, and neither channel reaches an HTTP response.
    const diagnostic = classifyStartupFailure(error);
    logger.error(
      { err: error, startupFailure: diagnostic },
      `Fatal startup error: ${diagnostic.title}`,
    );

    if (app) {
      try {
        await app.close();
      } catch (closeError: unknown) {
        logger.error({ err: closeError }, 'Failed to close application after startup error');
      }
    }

    try {
      // May be unset when the failure happened before the application graph
      // loaded (e.g. invalid configuration): disconnecting is best-effort.
      await disconnectPrisma?.();
    } catch (disconnectError: unknown) {
      logger.error({ err: disconnectError }, 'Failed to disconnect Prisma after startup error');
    }

    process.exitCode = 1;
  }
}

void bootstrap();
