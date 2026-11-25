#!/usr/bin/env node
/**
 * Grafana dashboard generator (M16.1).
 *
 * Reads a maintained manifest describing the dashboard and its panels, and
 * generates a deterministic Grafana-compatible dashboard JSON document using
 * ONLY the metric names and bounded labels confirmed in the application:
 *
 *   - forge_http_requests_total{method,route,status}     (counter)
 *   - forge_http_errors_total{method,route,status}       (counter)
 *   - forge_http_request_duration_seconds{method,route}  (histogram)
 *
 * Labels `method`, `route`, and `status` are bounded BY CONSTRUCTION: `route`
 * is a Fastify route template (or the literal 'unknown' for unmatched URLs) —
 * never a raw URL, ID, email, IP, token, or query string. The generator
 * rejects any manifest referencing other metrics or labels.
 *
 * The generator is deterministic: same manifest in, same JSON out. Repeated
 * runs produce byte-identical content (no timestamps, sorted series).
 *
 * Usage:
 *   node scripts/generate-dashboards.cjs
 *   node scripts/generate-dashboards.cjs --manifest <path> --out <path>
 *   node scripts/generate-dashboards.cjs --check   (validate manifest only)
 *
 * Exit codes: 0 = success; 1 = generation/validation failure; 2 = config error.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_DIR = __dirname;
const ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_MANIFEST = path.join(ROOT, 'observability', 'grafana', 'dashboards', 'manifest.json');
const DEFAULT_OUT = path.join(ROOT, 'observability', 'grafana', 'dashboards', 'oxyide-forge.json');

/** Verified metric instruments (src/shared/metrics/prometheus.ts). */
const VERIFIED_METRICS = Object.freeze({
  requests: 'forge_http_requests_total',
  errors: 'forge_http_errors_total',
  duration: 'forge_http_request_duration_seconds',
});

/** Bounded labels (src/shared/metrics/metrics.ts): the ONLY permitted label names. */
const BOUNDED_LABELS = Object.freeze(['method', 'route', 'status']);

/** Panel types this generator supports. */
const SUPPORTED_PANEL_TYPES = Object.freeze(['timeseries', 'stat', 'piechart', 'table']);

function fail(message, code) {
  process.stderr.write(`generate-dashboards: ${message}\n`);
  process.exit(code);
}

/**
 * Validates the manifest structure. Returns { errors: string[] }.
 * Every reference is checked against the verified metric/label allowlists.
 */
function validateManifest(manifest) {
  const errors = [];
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return { errors: ['manifest must be a JSON object'] };
  }
  if (typeof manifest.title !== 'string' || manifest.title.length === 0) {
    errors.push('manifest.title must be a non-empty string');
  }
  if (typeof manifest.uid !== 'string' || manifest.uid.length === 0) {
    errors.push('manifest.uid must be a non-empty string (stable dashboard UID)');
  }
  // Optional dashboard-level settings (validated when present).
  if (manifest.timezone !== undefined && typeof manifest.timezone !== 'string') {
    errors.push('manifest.timezone must be a string');
  }
  if (manifest.refresh !== undefined && typeof manifest.refresh !== 'string') {
    errors.push('manifest.refresh must be a string (e.g. "30s")');
  }
  if (manifest.time !== undefined) {
    if (
      typeof manifest.time !== 'object' ||
      manifest.time === null ||
      typeof manifest.time.from !== 'string' ||
      typeof manifest.time.to !== 'string'
    ) {
      errors.push('manifest.time must be an object with string "from" and "to"');
    }
  }
  if (manifest.datasource !== undefined) {
    if (
      typeof manifest.datasource !== 'object' ||
      manifest.datasource === null ||
      typeof manifest.datasource.type !== 'string' ||
      typeof manifest.datasource.uid !== 'string'
    ) {
      errors.push('manifest.datasource must be an object with string "type" and "uid"');
    }
  }
  if (manifest.tags !== undefined && !Array.isArray(manifest.tags)) {
    errors.push('manifest.tags must be an array of strings');
  }
  if (!Array.isArray(manifest.panels) || manifest.panels.length === 0) {
    errors.push('manifest.panels must be a non-empty array');
    return { errors };
  }
  const seenIds = new Set();
  const metricNames = new Set(Object.values(VERIFIED_METRICS));
  // Histogram exposition derives _bucket/_sum/_count series from the base
  // name (src/shared/metrics/prometheus.ts render()). These are legitimate.
  const histogramBase = VERIFIED_METRICS.duration;
  const isKnownMetric = (ref) =>
    metricNames.has(ref) ||
    (ref === `${histogramBase}_bucket` || ref === `${histogramBase}_sum` || ref === `${histogramBase}_count`);
  manifest.panels.forEach((panel, index) => {
    const where = `panels[${index}]`;
    if (typeof panel !== 'object' || panel === null) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!Number.isInteger(panel.id) || panel.id <= 0) {
      errors.push(`${where}.id must be a positive integer`);
    } else if (seenIds.has(panel.id)) {
      errors.push(`${where}.id ${panel.id} is duplicated (panel IDs must be unique)`);
    } else {
      seenIds.add(panel.id);
    }
    if (typeof panel.title !== 'string' || panel.title.length === 0) {
      errors.push(`${where}.title must be a non-empty string`);
    }
    if (!SUPPORTED_PANEL_TYPES.includes(panel.type)) {
      errors.push(`${where}.type must be one of: ${SUPPORTED_PANEL_TYPES.join(', ')}`);
    }
    // Targets: new `targets[]` form preferred; legacy single `expr` accepted.
    const targets = Array.isArray(panel.targets)
      ? panel.targets
      : typeof panel.expr === 'string'
        ? [{ expr: panel.expr, refId: 'A' }]
        : null;
    if (targets === null || targets.length === 0) {
      errors.push(`${where} must define a non-empty "targets" array or a single "expr" string`);
    } else {
      const seenRefIds = new Set();
      targets.forEach((target, targetIndex) => {
        const twhere = `${where}.targets[${targetIndex}]`;
        if (typeof target !== 'object' || target === null) {
          errors.push(`${twhere} must be an object`);
          return;
        }
        if (typeof target.expr !== 'string' || target.expr.length === 0) {
          errors.push(`${twhere}.expr must be a non-empty PromQL expression string`);
          return;
        }
        const refId = target.refId ?? String.fromCharCode(65 + targetIndex);
        if (seenRefIds.has(refId)) {
          errors.push(`${twhere}.refId '${refId}' is duplicated within the panel`);
        } else {
          seenRefIds.add(refId);
        }
        if (target.legendFormat !== undefined && typeof target.legendFormat !== 'string') {
          errors.push(`${twhere}.legendFormat must be a string`);
        }
        // The expression must reference only verified metrics…
        const referenced = extractMetricRefs(target.expr);
        for (const ref of referenced) {
          if (!isKnownMetric(ref)) {
            errors.push(
              `${twhere}.expr references unknown metric '${ref}' (allowed: ${[...metricNames].join(', ')})`,
            );
          }
        }
        // …and only bounded labels in by()/on()/grouping clauses.
        const labels = extractGroupingLabels(target.expr);
        for (const label of labels) {
          if (!BOUNDED_LABELS.includes(label) && label !== 'le') {
            errors.push(
              `${twhere}.expr groups by unbounded label '${label}' (allowed: ${BOUNDED_LABELS.join(', ')})`,
            );
          }
        }
      });
    }
    if (panel.unit !== undefined && typeof panel.unit !== 'string') {
      errors.push(`${where}.unit must be a string`);
    }
    if (panel.description !== undefined && typeof panel.description !== 'string') {
      errors.push(`${where}.description must be a string`);
    }
  });
  return { errors };
}

/** Extracts bare metric identifiers from a PromQL expression. */
function extractMetricRefs(expr) {
  // Strip by()/without() grouping clauses first: label names inside them
  // (route, status, …) are not metric references.
  const withoutGrouping = expr.replace(/\b(?:by|without)\s*\([^)]*\)/gi, ' ');
  const refs = new Set();
  const re = /\b([a-z_:][a-z0-9_:]*)(?=\s*[{([]|$)/gi;
  let match;
  while ((match = re.exec(withoutGrouping)) !== null) {
    const name = match[1];
    // Skip PromQL keywords and functions.
    if (['sum', 'rate', 'avg', 'min', 'max', 'count', 'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'histogram_quantile', 'increase', 'irate', 'topk', 'bottomk', 'sort', 'and', 'or', 'unless'].includes(name.toLowerCase())) {
      continue;
    }
    refs.add(name);
  }
  // Also catch bare metric names standing alone (e.g. as a range-vector
  // argument already covered above, or a bare series selector without braces).
  // Identifiers followed by `)` or `,` that survive keyword filtering are
  // metric candidates; label names were already removed with grouping clauses.
  const bareRe = /\b([a-z_][a-z0-9_]*:[a-z0-9_:]*|[a-z_][a-z0-9_]{3,})\b/gi;
  while ((match = bareRe.exec(withoutGrouping)) !== null) {
    const name = match[1];
    if (['sum', 'rate', 'avg', 'min', 'max', 'count', 'histogram_quantile', 'increase', 'irate', 'topk', 'bottomk', 'sort'].includes(name.toLowerCase())) {
      continue;
    }
    // Skip single common words that are clearly not metrics (units, literals).
    if (!name.includes('_') && !name.includes(':')) continue;
    refs.add(name);
  }
  return [...refs];
}

/** Extracts label names used in by()/without() grouping clauses. */
function extractGroupingLabels(expr) {
  const labels = new Set();
  const re = /\b(?:by|without)\s*\(\s*([^)]*)\)/gi;
  let match;
  while ((match = re.exec(expr)) !== null) {
    for (const label of match[1].split(',')) {
      const trimmed = label.trim();
      if (trimmed.length > 0) labels.add(trimmed);
    }
  }
  return [...labels];
}

/** Builds one Grafana panel object from a manifest panel. */
function buildPanel(manifestPanel, gridY, defaultDatasourceUid) {
  const rawTargets = Array.isArray(manifestPanel.targets)
    ? manifestPanel.targets
    : [{ expr: manifestPanel.expr, refId: 'A' }];
  const targets = rawTargets.map((target, index) => {
    const built = {
      expr: target.expr,
      refId: target.refId ?? String.fromCharCode(65 + index),
      datasource: { type: 'prometheus', uid: defaultDatasourceUid },
    };
    if (target.legendFormat) built.legendFormat = target.legendFormat;
    return built;
  });
  const panel = {
    id: manifestPanel.id,
    title: manifestPanel.title,
    type: manifestPanel.type,
    description: manifestPanel.description ?? '',
    gridPos: { h: 8, w: 12, x: (manifestPanel.id % 2 === 0 ? 12 : 0), y: gridY },
    targets,
    datasource: { type: 'prometheus', uid: defaultDatasourceUid },
  };
  if (manifestPanel.legend) {
    panel.options = { legend: { displayMode: 'table', showLegend: true, calcs: [] } };
  }
  if (manifestPanel.unit) {
    panel.fieldConfig = {
      defaults: { unit: manifestPanel.unit },
      overrides: [],
    };
  }
  return panel;
}

/** Generates the dashboard document from a validated manifest. */
function generateDashboard(manifest) {
  const datasourceUid =
    manifest.datasource && typeof manifest.datasource.uid === 'string'
      ? manifest.datasource.uid
      : '${DS_PROMETHEUS}';
  let gridY = 0;
  const panels = manifest.panels.map((panel) => {
    const built = buildPanel(panel, gridY, datasourceUid);
    gridY += 8;
    return built;
  });
  const dashboard = {
    uid: manifest.uid,
    title: manifest.title,
    description: manifest.description ?? '',
    tags: manifest.tags ?? ['oxyide-forge'],
    timezone: manifest.timezone ?? 'browser',
    schemaVersion: 39,
    version: 1,
    panels,
  };
  if (manifest.refresh) dashboard.refresh = manifest.refresh;
  if (manifest.time) dashboard.time = { from: manifest.time.from, to: manifest.time.to };
  return dashboard;
}

function parseArgs(argv) {
  const args = {
    manifest: process.env.DASHBOARD_MANIFEST || DEFAULT_MANIFEST,
    out: process.env.DASHBOARD_OUT || DEFAULT_OUT,
    check: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--manifest') args.manifest = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--check') args.check = true;
    else fail(`unknown argument '${argv[i]}' (use --help)`, 2);
  }
  if (args.manifest === undefined || args.out === undefined) fail('missing --manifest/--out value', 2);
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/generate-dashboards.cjs [--manifest <path>] [--out <path>] [--check]\n' +
        '  Generates a Grafana dashboard JSON from a manifest (default: observability/grafana/dashboards/manifest.json).\n' +
        '  --check validates the manifest without writing output.\n' +
        '  Exit codes: 0 success; 1 generation/validation failure; 2 config error.\n',
    );
    return;
  }
  let raw;
  try {
    raw = fs.readFileSync(args.manifest, 'utf8');
  } catch (error) {
    fail(`cannot read manifest '${args.manifest}': ${error.message}`, 2);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    fail(`manifest '${args.manifest}' is not valid JSON: ${error.message}`, 1);
  }
  const { errors } = validateManifest(manifest);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`generate-dashboards: manifest error: ${error}\n`);
    process.exit(1);
  }
  if (args.check) {
    process.stdout.write(`manifest OK: '${manifest.title}' (${manifest.panels.length} panels)\n`);
    return;
  }
  const dashboard = generateDashboard(manifest);
  const output = `${JSON.stringify(dashboard, null, 2)}\n`;
  try {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, output, 'utf8');
  } catch (error) {
    fail(`cannot write output '${args.out}': ${error.message}`, 1);
  }
  process.stdout.write(`dashboard written: ${args.out} (${manifest.panels.length} panels)\n`);
}

if (require.main === module) {
  main();
}

module.exports = { validateManifest, generateDashboard, extractMetricRefs, extractGroupingLabels };
