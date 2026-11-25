/**
 * Prisma seed entry point (M2.2).
 *
 * Explicitly invoked via `npm run db:seed` (or `npx prisma db seed`). It is
 * NEVER invoked by application startup, bootstrap, lifecycle hooks, or
 * deployment scripts.
 *
 * Current scope: the schema holds application data only (User, Credential,
 * Session, RefreshToken)
 * plus code-owned authorization (roles/permissions live in
 * `src/modules/authorization`, not in the database). There is therefore no
 * legitimate baseline reference data to insert, and this seed performs no
 * fabricated business-data insertion. The mechanism below is the
 * production-grade entry point future reference-data operations plug into:
 * each operation must be deterministic and idempotent (prefer upsert on a
 * stable natural key) and must never create users, credentials, or any
 * application records without an explicitly documented requirement.
 *
 * Safety properties:
 * - Successful runs exit 0; any failure exits non-zero (never a silent pass).
 * - Production execution is refused: no production seed content is defined.
 * - No destructive operations: no reset, no truncate, no deletes.
 * - Error output never contains secrets (see toSafeMessage).
 * - The Prisma connection is always released before exit.
 */
/**
 * Runtime Prisma initialization-error constructor, loaded lazily AFTER
 * configuration validation.
 *
 * @prisma/client autoloads the repository .env file as a side effect of
 * being imported. A static runtime import at the top of this file would run
 * before validation and silently restore a deliberately missing DATABASE_URL,
 * defeating the missing-configuration failure contract. The constructor below
 * is therefore populated by dynamic import inside main(), after the config
 * import has validated the true operator environment.
 */
type PrismaInitErrorConstructor = abstract new (...args: never[]) => Error;

let PrismaInitError: PrismaInitErrorConstructor | undefined;

type SeedResult = {
  processed: number;
};

type SeedOperation = {
  readonly name: string;
  run: () => Promise<SeedResult>;
};

// Baseline reference-data operations. EMPTY for the current schema: User and
// Credential rows are application data created through registration, and
// authorization data lives in code. Add future reference-data operations here
// only with a documented requirement; each must be deterministic, idempotent,
// and safe to re-run (see the module contract above).
const operations: SeedOperation[] = [];

/**
 * Render an error for seed output without leaking secrets. Zod validation
 * failures echo received values, so they are replaced with a fixed message.
 * Prisma connection failures may embed connection details, so only the
 * stable error code is kept. Any URL userinfo in other messages is redacted.
 */
function toSafeMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'ZodError') {
    return 'invalid environment configuration (required values missing or malformed; values withheld)';
  }
  const InitializationError = PrismaInitError;
  if (InitializationError !== undefined && error instanceof InitializationError) {
    const code =
      'errorCode' in error && typeof error.errorCode === 'string'
        ? ` [${error.errorCode}]`
        : '';
    return `could not connect to PostgreSQL${code} (verify DATABASE_URL connectivity)`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/:\/\/[^/\s]*@[^\s]*/g, '://***');
}

async function main(): Promise<void> {
  // Configuration is imported dynamically so a validation failure is raised
  // inside main() and flows through the safe error handler below. A static
  // import would throw during module evaluation instead, bypassing redaction.
  const { config } = await import('../src/config/index.js');
  // Loaded only after validation above: importing the Prisma runtime earlier
  // would autoload .env and mask a missing DATABASE_URL (see PrismaInitError note).
  PrismaInitError = (await import('@prisma/client')).Prisma.PrismaClientInitializationError;
  const { disconnectPrisma, prisma } = await import('../src/platform/database/prisma.js');

  try {
    if (config.nodeEnv === 'production') {
      throw new Error(
        'Seed is disabled in production: no production seed content is defined for this starter.',
      );
    }

    // Verify database connectivity before doing anything else: a seed that
    // cannot reach PostgreSQL must fail loudly instead of reporting success.
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error: unknown) {
      throw new Error(`seed connectivity check failed: ${toSafeMessage(error)}`);
    }

    console.log(`Seed started (environment: ${config.nodeEnv}).`);

    let processed = 0;
    for (const operation of operations) {
      try {
        const result = await operation.run();
        console.log(`- ${operation.name}: ${result.processed} records processed.`);
        processed += result.processed;
      } catch (error: unknown) {
        throw new Error(`seed operation '${operation.name}' failed: ${toSafeMessage(error)}`);
      }
    }

    if (operations.length === 0) {
      console.log('No baseline seed data is defined for the current schema; nothing to insert.');
    }
    console.log(`Seed completed successfully (${processed} records processed).`);
  } finally {
    await disconnectPrisma();
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(`Seed failed: ${toSafeMessage(error)}`);
  process.exitCode = 1;
}
