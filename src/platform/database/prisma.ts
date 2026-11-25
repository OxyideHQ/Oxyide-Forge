import { PrismaClient } from '@prisma/client';

import { config } from '../../config/index.js';

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: config.databaseUrl,
    },
  },
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
