import type { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';
import { installShutdownHandlers } from './lifecycle.js';

export async function startServer(app: FastifyInstance): Promise<FastifyInstance> {
  const { host, port } = config;

  // Install the signal handlers BEFORE listening (M9.5). Previously they were
  // installed after `listen()` resolved, leaving a window in which the socket
  // was already accepting connections but SIGTERM/SIGINT would fall through to
  // Node's default behavior — an abrupt exit with no drain, in exactly the
  // window a container stop is most likely to land. Installing first is safe: if
  // `listen()` then fails, `main.ts` calls `app.close()`, whose `onClose` hook
  // removes the handlers again.
  installShutdownHandlers(app);

  await app.listen({ host, port });
  app.log.info({ host, port }, 'Fastify application started');

  return app;
}
