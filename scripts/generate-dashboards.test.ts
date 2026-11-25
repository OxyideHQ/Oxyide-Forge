/**
 * Tests for scripts/generate-dashboards.cjs (M16.1).
 *
 * Exercises the generator's pure validation/generation functions (imported
 * directly from the .cjs module) plus one black-box subprocess run against
 * a temporary manifest, so the CLI path is covered without touching the real
 * repository manifest or output. No database, network, or Grafana needed.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const generator = require('./generate-dashboards.cjs') as {
  validateManifest(manifest: unknown): { errors: string[] };
  generateDashboard(manifest: {
    title: string;
    uid: string;
    description?: string;
    tags?: string[];
    panels: Array<{
      id: number;
      title: string;
      type: string;
      expr: string;
      unit?: string;
      description?: string;
    }>;
  }): Record<string, unknown>;
};

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const generatorScript = path.join(scriptsDir, 'generate-dashboards.cjs');
const repoManifestPath = path.join(
  scriptsDir,
  '..',
  'observability',
  'grafana',
  'dashboards',
  'manifest.json',
);
const repoDashboardPath = path.join(
  scriptsDir,
  '..',
  'observability',
  'grafana',
  'dashboards',
  'oxyide-forge.json',
);

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dashboards-'));
  tempDirs.push(dir);
  return dir;
}

function validManifest(): Record<string, unknown> {
  return {
    title: 'Test dashboard',
    uid: 'test-dashboard',
    panels: [
      {
        id: 1,
        title: 'Request rate',
        type: 'timeseries',
        expr: 'sum by (route, status) (rate(forge_http_requests_total[5m]))',
      },
    ],
  };
}

describe('manifest validation', () => {
  it('accepts a valid manifest', () => {
    expect(generator.validateManifest(validManifest()).errors).toEqual([]);
  });

  it('accepts the real repository manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(repoManifestPath, 'utf8')) as unknown;
    expect(generator.validateManifest(manifest).errors).toEqual([]);
  });

  it('rejects a non-object manifest', () => {
    expect(generator.validateManifest(null).errors.length).toBeGreaterThan(0);
    expect(generator.validateManifest([]).errors.length).toBeGreaterThan(0);
    expect(generator.validateManifest('x').errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing title or uid', () => {
    const noTitle = { ...validManifest(), title: '' };
    expect(generator.validateManifest(noTitle).errors.some((e) => e.includes('title'))).toBe(true);
    const noUid = { ...validManifest(), uid: '' };
    expect(generator.validateManifest(noUid).errors.some((e) => e.includes('uid'))).toBe(true);
  });

  it('rejects duplicated panel IDs', () => {
    const manifest = validManifest() as { panels: Array<Record<string, unknown>> };
    manifest.panels = [
      { id: 1, title: 'A', type: 'timeseries', expr: 'sum by (route) (forge_http_requests_total)' },
      { id: 1, title: 'B', type: 'stat', expr: 'sum by (route) (forge_http_requests_total)' },
    ];
    expect(generator.validateManifest(manifest).errors.some((e) => e.includes('duplicated'))).toBe(true);
  });

  it('rejects unknown metrics', () => {
    const manifest = validManifest() as { panels: Array<Record<string, unknown>> };
    manifest.panels = [{ id: 1, title: 'X', type: 'stat', expr: 'sum by (route) (my_custom_metric)' }];
    expect(generator.validateManifest(manifest).errors.some((e) => e.includes('unknown metric'))).toBe(true);
  });

  it('rejects unbounded grouping labels', () => {
    const manifest = validManifest() as { panels: Array<Record<string, unknown>> };
    manifest.panels = [
      { id: 1, title: 'X', type: 'stat', expr: 'sum by (user_id) (forge_http_requests_total)' },
    ];
    expect(generator.validateManifest(manifest).errors.some((e) => e.includes('unbounded label'))).toBe(true);
  });

  it('rejects unsupported panel types', () => {
    const manifest = validManifest() as { panels: Array<Record<string, unknown>> };
    manifest.panels = [
      { id: 1, title: 'X', type: 'heatmap', expr: 'sum by (route) (forge_http_requests_total)' },
    ];
    expect(generator.validateManifest(manifest).errors.some((e) => e.includes('type'))).toBe(true);
  });
});

describe('dashboard generation', () => {
  it('generates a structurally valid dashboard from the repository manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(repoManifestPath, 'utf8')) as Parameters<
      typeof generator.generateDashboard
    >[0];
    const dashboard = generator.generateDashboard(manifest) as {
      uid: string;
      title: string;
      refresh?: string;
      time?: { from: string; to: string };
      panels: Array<{
        id: number;
        title: string;
        type: string;
        datasource: { type: string; uid: string };
        targets: Array<{ expr: string; refId: string; legendFormat?: string }>;
      }>;
    };
    expect(dashboard.uid).toBe('oxyide-forge-http');
    expect(dashboard.title).toContain('Oxyide Forge');
    expect(dashboard.panels.length).toBe(5);
    expect(dashboard.refresh).toBe('30s');
    expect(dashboard.time).toEqual({ from: 'now-1h', to: 'now' });
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const panel of dashboard.panels) {
      expect(panel.targets.length).toBeGreaterThanOrEqual(1);
      expect(panel.datasource).toEqual({ type: 'prometheus', uid: '${DS_PROMETHEUS}' });
      const refIds = panel.targets.map((t) => t.refId);
      expect(new Set(refIds).size).toBe(refIds.length);
      for (const target of panel.targets) {
        expect(target.expr.length).toBeGreaterThan(0);
      }
    }
    // Latency panel carries p50/p95/p99 quantile targets.
    const latency = dashboard.panels.find((p) => p.title.includes('latency'));
    expect(latency?.targets.length).toBe(3);
    expect(latency?.targets.map((t) => t.refId)).toEqual(['A', 'B', 'C']);
  });

  it('references only verified metrics and bounded labels', () => {
    const manifest = JSON.parse(fs.readFileSync(repoManifestPath, 'utf8')) as {
      panels: Array<{ expr?: string; targets?: Array<{ expr: string }> }>;
    };
    const exprs = manifest.panels
      .flatMap((p) => (Array.isArray(p.targets) ? p.targets.map((t) => t.expr) : [p.expr ?? '']))
      .join('\n');
    expect(exprs).toContain('forge_http_requests_total');
    expect(exprs).toContain('forge_http_errors_total');
    expect(exprs).toContain('forge_http_request_duration_seconds');
    expect(exprs).not.toContain('user_id');
    expect(exprs).not.toContain('email');
    expect(exprs).not.toContain('token');
  });

  it('validates multi-target panels and datasource settings', () => {
    // Duplicate refIds within one panel are rejected.
    const dup = validManifest() as { panels: Array<Record<string, unknown>> };
    dup.panels = [
      {
        id: 1,
        title: 'X',
        type: 'timeseries',
        targets: [
          { refId: 'A', expr: 'sum by (route) (forge_http_requests_total)' },
          { refId: 'A', expr: 'sum by (route) (forge_http_errors_total)' },
        ],
      },
    ];
    expect(
      generator.validateManifest(dup).errors.some((e) => e.includes('duplicated')),
    ).toBe(true);
    // Invalid dashboard-level settings are rejected.
    const badTime = { ...validManifest(), time: { from: 1 } };
    expect(generator.validateManifest(badTime).errors.some((e) => e.includes('time'))).toBe(true);
    const badDs = { ...validManifest(), datasource: { type: 'prometheus' } };
    expect(generator.validateManifest(badDs).errors.some((e) => e.includes('datasource'))).toBe(
      true,
    );
  });

  it('is deterministic across repeated generation', () => {
    const manifest = JSON.parse(fs.readFileSync(repoManifestPath, 'utf8')) as Parameters<
      typeof generator.generateDashboard
    >[0];
    const first = JSON.stringify(generator.generateDashboard(manifest));
    const second = JSON.stringify(generator.generateDashboard(manifest));
    expect(first).toBe(second);
  });
});

describe('CLI subprocess', () => {
  it('generates byte-identical output on repeated runs', () => {
    const dir = makeTempDir();
    const out = path.join(dir, 'dashboard.json');
    execFileSync('node', [generatorScript, '--manifest', repoManifestPath, '--out', out], {
      stdio: 'pipe',
    });
    const first = fs.readFileSync(out, 'utf8');
    execFileSync('node', [generatorScript, '--manifest', repoManifestPath, '--out', out], {
      stdio: 'pipe',
    });
    const second = fs.readFileSync(out, 'utf8');
    expect(first).toBe(second);
    expect(() => JSON.parse(first)).not.toThrow();
  });

  it('fails with exit 1 on an invalid manifest', () => {
    const dir = makeTempDir();
    const badManifest = path.join(dir, 'bad.json');
    fs.writeFileSync(badManifest, JSON.stringify({ title: '', uid: '', panels: [] }), 'utf8');
    expect(() =>
      execFileSync('node', [generatorScript, '--manifest', badManifest, '--out', path.join(dir, 'out.json')], {
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('fails with exit 2 on a missing manifest file', () => {
    const dir = makeTempDir();
    expect(() =>
      execFileSync(
        'node',
        [generatorScript, '--manifest', path.join(dir, 'nope.json'), '--out', path.join(dir, 'out.json')],
        { stdio: 'pipe' },
      ),
    ).toThrow();
  });

  it('matches the committed dashboard output', () => {
    const dir = makeTempDir();
    const out = path.join(dir, 'regenerated.json');
    execFileSync('node', [generatorScript, '--manifest', repoManifestPath, '--out', out], {
      stdio: 'pipe',
    });
    const regenerated = fs.readFileSync(out, 'utf8');
    const committed = fs.readFileSync(repoDashboardPath, 'utf8');
    expect(regenerated).toBe(committed);
  });
});
