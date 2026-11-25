import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * M13.7 — deployment workflow separation regression suite.
 *
 * The deployment workflow is BUILD → MIGRATE → DEPLOY → VERIFY, with each
 * phase owning exactly one responsibility. The historical failure mode this
 * pins is phase-blurring: startup secretly migrating, seeding, or validating
 * releases; lifecycle hooks smuggling behavior; container/compose commands
 * bypassing the canonical entry point.
 *
 * Assertions are structural (script text, file contents, documented command
 * surface), matching the M12.8 documentation-drift approach: they pin the
 * separation contract without re-implementing it. No database, Docker, or
 * network is required. Every test corresponds to an M13.7 workflow gate.
 */

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..');

const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const withoutComments = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

describe('canonical lifecycle commands are distinct responsibilities', () => {
  const scripts = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

  it('build compiles TypeScript and nothing else', () => {
    expect(scripts.scripts.build).toBe('tsc --project tsconfig.json');
  });

  it('start runs the compiled entry point directly', () => {
    expect(scripts.scripts.start).toBe('node dist/main.js');
  });

  it('start performs no build, migration, seed, or validation work', () => {
    const start = scripts.scripts.start;
    for (const forbidden of [
      'migrate',
      'seed',
      'prisma',
      'tsc ',
      'tsc-',
      'tsx',
      'vitest',
      'eslint',
      'release-validate',
      'verify-deployment',
      'npm run',
      '&&',
    ]) {
      expect(start.includes(forbidden), `npm start must not contain ${forbidden}`).toBe(false);
    }
  });

  it('no npm lifecycle hook can smuggle startup behavior', () => {
    // A `prestart` running migrations would reintroduce exactly the
    // startup-migration this milestone forbids, invisibly.
    const hooks = Object.keys(scripts.scripts).filter(
      (name) =>
        name.startsWith('pre') ||
        name.startsWith('post') ||
        ['prepare', 'install'].includes(name),
    );
    expect(hooks).toEqual([]);
  });
});

describe('application startup never migrates or seeds', () => {
  const startupSources = [
    read('src/main.ts'),
    read('src/app/server.ts'),
    read('src/app/lifecycle.ts'),
  ].join('\n');

  it.each(['migrate deploy', 'migrate dev', 'db push', 'migrate reset', 'db seed', 'seed.ts'])(
    'startup code never invokes %s',
    (forbidden) => {
      expect(startupSources.includes(forbidden)).toBe(false);
    },
  );

  it('the production seed entry point refuses production', () => {
    // Seed exists for development/test only; the refusal is the boundary
    // between "tool exists" and "tool can harm production".
    expect(read('prisma/seed.ts')).toMatch(/production/);
  });
});

describe('container and compose use the canonical startup path', () => {
  it('Dockerfile CMD is the compiled entry point with no wrapper', () => {
    // Match only the exec-form CMD (the HEALTHCHECK's `CMD wget …`
    // continuation line is a different instruction).
    const cmd = withoutComments(read('Dockerfile'))
      .split('\n')
      .find((line) => /^\s*CMD\s*\[/.test(line));
    expect(cmd?.trim()).toBe('CMD ["node", "dist/main.js"]');
  });

  it('Dockerfile performs no migration or seed at build or runtime', () => {
    const code = withoutComments(read('Dockerfile'));
    for (const forbidden of ['migrate deploy', 'migrate dev', 'db push', 'db seed', 'seed.ts']) {
      expect(code.includes(forbidden)).toBe(false);
    }
  });

  it('compose does not override the image startup command', () => {
    // An override here would bypass the verified CMD without changing the
    // Dockerfile, splitting the production startup path in two.
    const appService = read('docker-compose.yml').split(/^ {2}app:/m)[1] ?? '';
    expect(/^\s*command:/m.test(appService)).toBe(false);
  });

  it('compose requires secrets from the environment instead of defaulting them', () => {
    const compose = read('docker-compose.yml');
    for (const variable of ['DATABASE_URL', 'JWT_SECRET', 'POSTGRES_PASSWORD']) {
      expect(compose.includes(`\${${variable}:?`)).toBe(true);
    }
  });
});

describe('deployment documentation states the separated workflow', () => {
  const deployment = read('docs/deployment.md');

  it('names each lifecycle phase with its canonical command', () => {
    for (const command of [
      'npm ci',
      'npm run build',
      'npx prisma migrate deploy',
      'npx prisma migrate status',
      'node dist/main.js',
      '/health/live',
      '/health/ready',
    ]) {
      expect(deployment.includes(command), `docs/deployment.md must name ${command}`).toBe(true);
    }
  });

  it('prohibits production migration shortcuts in one place', () => {
    for (const prohibited of ['prisma migrate dev', 'prisma db push', 'prisma migrate reset']) {
      expect(deployment.includes(prohibited)).toBe(true);
    }
  });

  it('routes migration, backup, and recovery detail to their owning documents', () => {
    for (const doc of ['docs/migrations.md', 'docs/backup-recovery.md', 'docs/rollback-recovery.md']) {
      expect(deployment.includes(doc), `docs/deployment.md must reference ${doc}`).toBe(true);
    }
  });

  it('contains no broken copy-paste setup commands', () => {
    // M13.7-N01: the Installation section shipped `cp.env.example.env`
    // (missing spaces), which fails on every shell. Fixed; pinned here.
    expect(deployment.includes('cp.env.example')).toBe(false);
    expect(deployment.includes('cp .env.example .env')).toBe(true);
  });
});
