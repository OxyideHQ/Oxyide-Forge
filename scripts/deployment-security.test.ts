import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * M13.8 — deployment security boundary regression suite.
 *
 * Pins the deployment-time security invariants that earlier milestones built
 * but nothing asserted in one place: CI runs the gates it claims (against a
 * database at or above the documented minimum, with least-privilege,
 * fork-safe, SHA-pinned workflows that touch no production secrets); the
 * container runs unprivileged with no baked-in secrets; the build context
 * excludes local configuration; SMTP never disables certificate
 * verification; examples carry placeholders, never credential-shaped values.
 *
 * Assertions are structural (workflow text, Dockerfile text, source text),
 * matching the M12.8 documentation-drift precedent. No database, Docker, or
 * network is required. The live behaviors (config validation, secret
 * scanning, SAST, SBOM gates, redaction) are covered by their owning suites;
 * this suite pins the deployment-surface facts those suites do not.
 */

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..');

const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const withoutComments = (source: string, marker = '#'): string =>
  source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(marker))
    .join('\n');

/** All non-test TypeScript sources under `src/`. */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (abs.endsWith('.ts') && !abs.endsWith('.test.ts')) out.push(abs);
    }
  };
  walk(path.join(root, 'src'));
  return out;
}

describe('CI validates against a supported database with least privilege', () => {
  const ci = read('.github/workflows/ci.yml');
  const release = read('.github/workflows/release.yml');

  it('both workflows test against PostgreSQL at or above the documented minimum', () => {
    // M138-N01: both services pinned postgres:16 while README, development
    // guide, deployment guide, and the compose stack all require 17+. Gates
    // that validate against a below-minimum database certify a configuration
    // the product does not support.
    for (const [name, workflow] of [
      ['ci.yml', ci],
      ['release.yml', release],
    ] as const) {
      const image = /image:\s*postgres:(\d+)/.exec(workflow);
      expect(image, `${name} must declare a postgres service image`).not.toBeNull();
      expect(Number(image?.[1]), `${name} postgres must be >= 17`).toBeGreaterThanOrEqual(17);
    }
  });

  it('CI permissions are read-only', () => {
    expect(ci).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(ci.includes('contents: write')).toBe(false);
  });

  it('release permissions grant exactly release creation', () => {
    expect(release).toMatch(/permissions:\s*\n\s*contents:\s*write/);
    expect(/contents:\s*(admin|maintain)/.test(release)).toBe(false);
  });

  it('no workflow runs untrusted fork code with secret access', () => {
    // Match YAML trigger keys, not header-comment prose (ci.yml names the
    // forbidden trigger in its own trust-boundary comment precisely to
    // document that it is NOT used).
    for (const workflow of [ci, release]) {
      expect(/^\s+pull_request_target:/m.test(workflow)).toBe(false);
    }
    expect(ci.includes('pull_request')).toBe(true);
  });

  it('third-party actions are SHA-pinned, never mutable tags', () => {
    for (const [name, workflow] of [
      ['ci.yml', ci],
      ['release.yml', release],
    ] as const) {
      const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]);
      expect(uses.length, `${name} must use third-party actions`).toBeGreaterThan(0);
      for (const action of uses) {
        expect(action, `${name}: ${action} must be SHA-pinned`).toMatch(/@[0-9a-f]{40}(?:\s*#|$)/);
      }
    }
  });

  it('the only CI credential is the ephemeral publish token, confined to publishing', () => {
    // Match expression syntax (`${{ secrets.… }}`), not comment prose
    // (ci.yml documents "zero secrets" in its own header comment).
    expect(ci.includes('${{ secrets.')).toBe(false);
    const references = [...release.matchAll(/\$\{\{\s*secrets\.([A-Za-z_]+)/g)].map(
      (match) => match[1],
    );
    expect(references).toEqual(['GITHUB_TOKEN']);
  });
});

describe('the container carries no privilege or secret it should not', () => {
  const dockerfile = withoutComments(read('Dockerfile'));

  it('runs as an unprivileged user', () => {
    expect(dockerfile).toMatch(/^\s*USER\s+(?!root)\S+/m);
  });

  it('installs no OS packages at runtime', () => {
    expect(dockerfile.includes('apk add')).toBe(false);
  });

  it('bakes no secret-bearing assignment into any layer', () => {
    expect(/(DATABASE_URL|JWT_SECRET|SMTP_PASSWORD|REDIS_URL)\s*=\s*\S/.test(dockerfile)).toBe(
      false,
    );
  });
});

describe('the build context excludes local configuration', () => {
  const lines = read('.dockerignore').split('\n').map((line) => line.trim());

  it('excludes real environment files exactly', () => {
    expect(lines).toContain('.env');
  });

  it('still ships the documented example template', () => {
    expect(lines).toContain('!.env.example');
  });
});

describe('SMTP never disables certificate verification', () => {
  it('no production source passes rejectUnauthorized: false', () => {
    // The provider documents this as deliberately never passed; this test
    // makes the discipline repo-wide rather than file-local. Comment lines
    // are excluded: the provider's own doc comment names the forbidden
    // option precisely to forbid it.
    const codeOf = (abs: string): string =>
      readFileSync(abs, 'utf8')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trimStart();
          return (
            !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
          );
        })
        .join('\n');
    const offenders = productionSources().filter((abs) =>
      codeOf(abs).includes('rejectUnauthorized: false'),
    );
    expect(offenders).toEqual([]);
  });

  it('STARTTLS requires negotiation rather than hoping for it', () => {
    expect(read('src/platform/email/smtp-email-provider.ts').includes('requireTLS: true')).toBe(
      true,
    );
  });
});

describe('examples carry placeholders, never credential-shaped values', () => {
  const example = read('.env.example');

  it('the JWT example is self-describing as a replacement prompt', () => {
    expect(example.includes('replace-with-at-least-32-characters')).toBe(true);
  });

  it('no private-key or live-secret shape appears in examples or workflows', () => {
    const bodies = [
      example,
      read('.github/workflows/ci.yml'),
      read('.github/workflows/release.yml'),
    ].join('\n');
    for (const shape of ['BEGIN ', 'PRIVATE KEY', 'ghp_', 'sk-live-']) {
      expect(bodies.includes(shape), `forbidden shape present: ${shape}`).toBe(false);
    }
  });
});
