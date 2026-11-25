/**
 * M9.5 — Docker / deployment contract tests.
 *
 * These assert the *definition* of the container health contract: the
 * Dockerfile's HEALTHCHECK, the build-context exclusions, and the compose
 * wiring. They need no Docker daemon, so they run in the normal suite and fail
 * loudly if the definition drifts.
 *
 * The runtime half of the deployment lifecycle — start, dependency failure,
 * recovery without restart, graceful shutdown — is driven by
 * `scripts/verify-deployment.cjs` (`npm run verify:deployment`), which boots the
 * real compiled server over real HTTP. It is a script rather than a suite entry
 * because it spawns a server and needs a live PostgreSQL, which the unit suite
 * must never depend on.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const dockerignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');

const healthcheck = /HEALTHCHECK\b([\s\S]*?)\n\s*CMD\s+([^\n]+)/.exec(dockerfile);
const healthcheckOptions = healthcheck?.[1] ?? '';
const healthcheckCommand = healthcheck?.[2] ?? '';

const composeAppSection = compose.split('  app:')[1] ?? '';

describe('M9.5 Dockerfile healthcheck definition', () => {
  it('declares exactly one HEALTHCHECK', () => {
    expect(healthcheck).not.toBeNull();
    expect(dockerfile.match(/^HEALTHCHECK\b/gm)).toHaveLength(1);
  });

  it('probes readiness, never liveness', () => {
    // A container-health check on liveness would report a database outage as a
    // process fault and invite a restart that fixes nothing.
    expect(healthcheckCommand).toContain('/health/ready');
    expect(healthcheckCommand).not.toContain('/health/live');
  });

  it('targets loopback only, with no external dependency', () => {
    expect(healthcheckCommand).toContain('127.0.0.1');
    expect(healthcheckCommand).not.toMatch(/localhost|\bhost\.docker\.internal\b/);
  });

  it('uses the container listening port rather than a hardcoded one', () => {
    expect(healthcheckCommand).toMatch(/\$\{PORT/);
  });

  it('fails on any non-success status', () => {
    expect(healthcheckCommand).toContain('|| exit 1');
  });

  it('uses the preinstalled busybox wget and adds no package', () => {
    expect(healthcheckCommand).toContain('wget');
    // `apk add` anywhere in the file would mean the image grew a package for
    // healthchecking alone.
    expect(dockerfile).not.toMatch(/apk add/);
  });

  it('exposes no credential, token, or connection string', () => {
    expect(healthcheckCommand).not.toMatch(
      /DATABASE_URL|REDIS_URL|JWT_SECRET|password|secret|token|:\/\/[^"]*@/i,
    );
  });

  it('bounds the probe inside the check timeout', () => {
    const probeTimeout = /-T\s+(\d+)/.exec(healthcheckCommand)?.[1];
    const checkTimeout = /--timeout=(\d+)s/.exec(healthcheckOptions)?.[1];
    expect(probeTimeout).toBeDefined();
    expect(checkTimeout).toBeDefined();
    // A probe that can outlive its own check would let checks pile up.
    expect(Number(probeTimeout)).toBeLessThan(Number(checkTimeout));
  });

  it('allows a startup grace period that covers measured startup', () => {
    const startPeriod = /--start-period=(\d+)s/.exec(healthcheckOptions)?.[1];
    expect(startPeriod).toBeDefined();
    // Measured application startup on the reference host is 2.4-2.9s; the
    // grace window must clear that with room for a cold database.
    expect(Number(startPeriod)).toBeGreaterThanOrEqual(15);
  });

  it('sets interval and retries so a transient blip is not fatal', () => {
    const interval = /--interval=(\d+)s/.exec(healthcheckOptions)?.[1];
    const retries = /--retries=(\d+)/.exec(healthcheckOptions)?.[1];
    const timeout = /--timeout=(\d+)s/.exec(healthcheckOptions)?.[1];
    expect(Number(retries)).toBeGreaterThanOrEqual(2);
    expect(Number(interval)).toBeGreaterThanOrEqual(Number(timeout));
  });
});

describe('M9.5 image hygiene', () => {
  it('runs as a non-root user', () => {
    expect(/^\s*USER\s+(?!root)\S+/m.test(dockerfile)).toBe(true);
  });

  it('exposes the application port', () => {
    expect(dockerfile).toMatch(/^EXPOSE\s+\d+/m);
  });

  it('starts the compiled entrypoint', () => {
    expect(dockerfile).toMatch(/^CMD\s+\["node",\s*"dist\/main\.js"\]/m);
  });

  it('never bakes local configuration into the image', () => {
    // The single most important exclusion: a developer's .env carries
    // DATABASE_URL, JWT secret, and REDIS_URL.
    expect(dockerignore).toMatch(/^\.env$/m);
    expect(dockerignore).toMatch(/^\.git$/m);
    expect(dockerignore).toMatch(/^node_modules$/m);
    expect(dockerignore).toMatch(/^dist$/m);
  });
});

describe('M9.5 compose wiring', () => {
  it('declares no credential literal', () => {
    const code = compose
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/(DATABASE_URL|JWT_SECRET|REDIS_URL)\s*=\s*\S/);
    expect(code).not.toMatch(/postgresql:\/\/[^$\s]/);
  });

  it('requires secrets from the environment rather than defaulting them', () => {
    expect(compose).toContain('${DATABASE_URL:?');
    expect(compose).toContain('${JWT_SECRET:?');
    expect(compose).toContain('${POSTGRES_PASSWORD:?');
  });

  it('never defaults the optional Redis URL to an empty string (M95-F01)', () => {
    // `${REDIS_URL:-}` expands to "", which validated configuration rejects as
    // an error rather than treating it as absent — so it would stop the
    // container from starting for anyone without Redis.
    expect(compose).not.toMatch(/REDIS_URL:\s*\$\{REDIS_URL:-?\}/);
  });

  it('waits for database health before starting the application', () => {
    expect(/depends_on:[\s\S]*?condition:\s*service_healthy/.test(compose)).toBe(true);
  });

  it('forwards signals so the graceful-shutdown path can run', () => {
    expect(/^\s*init:\s*true$/m.test(compose)).toBe(true);
    expect(/stop_grace_period:\s*\d+s/.test(compose)).toBe(true);
  });

  it('does not override the verified image healthcheck', () => {
    expect(/^\s*healthcheck:/m.test(composeAppSection)).toBe(false);
  });

  it('introduces no orchestrator beyond Docker Compose', () => {
    // M9.5 verifies Docker only. Kubernetes/ECS/CloudWatch must not appear.
    expect(compose).not.toMatch(/kubernetes|kind:\s*(Deployment|StatefulSet|Service)/i);
  });
});
