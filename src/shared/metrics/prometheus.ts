/**
 * Prometheus-exposition adapter for Forge's bounded metrics (M14.3).
 *
 * Forge already instruments requests through the `ForgeMetrics` abstraction and
 * the telemetry plugin, with cardinality bounded BY CONSTRUCTION: the only labels
 * are `{ method, route, status }`, where `route` is a Fastify route template (or
 * the literal `'unknown'` for unmatched URLs) — never a raw URL, ID, email, IP,
 * token, or query string. This adapter implements `ForgeMetrics` and renders the
 * accumulated samples in the Prometheus text exposition format (v0.0.4), so a
 * customer gains a scrape-ready `/metrics` endpoint. Dependency-free (built-in
 * Node only) to keep the release surface and `npm audit --omit=dev` unchanged.
 *
 * Boundedness guarantees preserved:
 *   - fixed instrument set; no custom metrics or label names;
 *   - fixed histogram bucket edges (a small constant set → bounded series);
 *   - label values travel only through `ForgeMetrics`, which carries no
 *     sensitive dimension — a caller physically cannot record a secret;
 *   - `render()` is deterministic (sorted series), and recording never throws.
 */

import type { ForgeMetrics } from './metrics.js';

/** Fixed histogram bucket edges, in seconds (constant set → bounded series). */
const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
] as const;

const METRIC_NAMES = {
  requests: 'forge_http_requests_total',
  errors: 'forge_http_errors_total',
  duration: 'forge_http_request_duration_seconds',
} as const;

function formatValue(value: number): string {
  // Deterministic numeric rendering: integers verbatim, floats with fixed
  // precision and no trailing zeros (keeps `render()` byte-stable for tests).
  if (Number.isInteger(value)) return String(value);
  return Number(value.toFixed(6)).toString();
}

/** Escape a label value per the Prometheus text format rules. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Serialize a label set with keys in stable (alphabetical) order. */
function serializeLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const inner = keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(',');
  return `{${inner}}`;
}

function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

export type PrometheusMetrics = {
  metrics: ForgeMetrics;
  /** Prometheus text exposition (v0.0.4); deterministic across calls. */
  render(): string;
};

export function prometheusMetrics(): PrometheusMetrics {
  const counters = new Map<string, Map<string, number>>();
  // Histogram: for each label-set -> { bucketCounts: number[], sum, count }.
  const histograms = new Map<string, Map<string, { bucketCounts: number[]; sum: number; count: number }>>();

  function incrementCounter(target: Map<string, Map<string, number>>, name: string, labels: Record<string, string>): void {
    let series = target.get(name);
    if (series === undefined) {
      series = new Map();
      target.set(name, series);
    }
    const key = labelKey(labels);
    series.set(key, (series.get(key) ?? 0) + 1);
  }

  function parseLabels(key: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const pair of key.split(',')) {
      const [k, v] = pair.split('=') as [string, string];
      out[k] = v ?? '';
    }
    return out;
  }

  const metrics = {
    httpRequestsTotal: {
      increment(labels): void {
        incrementCounter(counters, METRIC_NAMES.requests, labels as Record<string, string>);
      },
    },
    httpErrorsTotal: {
      increment(labels): void {
        incrementCounter(counters, METRIC_NAMES.errors, labels as Record<string, string>);
      },
    },
    httpRequestDurationSeconds: {
      observe(valueSeconds, labels): void {
        if (!Number.isFinite(valueSeconds) || valueSeconds < 0) return;
        let series = histograms.get(METRIC_NAMES.duration);
        if (series === undefined) {
          series = new Map();
          histograms.set(METRIC_NAMES.duration, series);
        }
        const key = labelKey(labels as Record<string, string>);
        const current = series.get(key) ?? { bucketCounts: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 };
        for (let i = 0; i < DURATION_BUCKETS.length; i++) {
          if (valueSeconds <= (DURATION_BUCKETS[i] as number)) current.bucketCounts[i] = (current.bucketCounts[i] ?? 0) + 1;
        }
        current.sum += valueSeconds;
        current.count += 1;
        series.set(key, current);
      },
    },
  } as ForgeMetrics;

  function render(): string {
    const lines: string[] = [];

    const emitCounter = (name: string, help: string): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      const series = counters.get(name);
      if (series) {
        for (const [key, value] of [...series].sort(([a], [b]) => a.localeCompare(b))) {
          lines.push(`${name}${serializeLabels(parseLabels(key))} ${formatValue(value)}`);
        }
      }
    };

    emitCounter(METRIC_NAMES.requests, 'Total HTTP requests completed.');
    emitCounter(METRIC_NAMES.errors, 'Total HTTP 5xx responses completed.');

    const histName = METRIC_NAMES.duration;
    lines.push(`# HELP ${histName} HTTP response latency in seconds.`);
    lines.push(`# TYPE ${histName} histogram`);
    const histSeries = histograms.get(histName);
    if (histSeries) {
      for (const [key, acc] of [...histSeries].sort(([a], [b]) => a.localeCompare(b))) {
        const base = parseLabels(key);
        for (let i = 0; i < DURATION_BUCKETS.length; i++) {
          lines.push(
            `${histName}_bucket${serializeLabels({ ...base, le: String(DURATION_BUCKETS[i]) })} ${formatValue(acc.bucketCounts[i] ?? 0)}`,
          );
        }
        lines.push(`${histName}_bucket${serializeLabels({ ...base, le: '+Inf' })} ${formatValue(acc.count)}`);
        lines.push(`${histName}_sum${serializeLabels(base)} ${formatValue(acc.sum)}`);
        lines.push(`${histName}_count${serializeLabels(base)} ${formatValue(acc.count)}`);
      }
    }

    return `${lines.join('\n')}\n`;
  }

  return { metrics, render };
}
