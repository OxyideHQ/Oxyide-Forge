import type { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from '../modules/auth/routes/auth.routes.js';
import { registerHealthRoutes } from '../modules/health/health.route.js';
import { registerUserRoutes } from '../modules/users/routes/user.routes.js';
import { registerRoleRoutes } from '../modules/roles/routes/role.routes.js';
import { registerNoteRoutes } from '../modules/notes/routes/note.routes.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(registerAuthRoutes);
  await app.register(registerUserRoutes);
  await app.register(registerRoleRoutes);
  await app.register(registerNoteRoutes);
  await app.register(registerHealthRoutes);
}
