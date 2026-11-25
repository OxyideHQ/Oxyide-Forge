/**
 * Forge-owned metrics abstraction (M8.4): backend-neutral, NoOp by
 * default, with an in-memory implementation for tests and reference.
 *
 * Cardinality is enforced BY CONSTRUCTION, not by review:
 * - The interface exposes exactly three fixed instruments — no custom
 *   instruments, no custom label names, no gauge (nothing in Forge
 *   justifies one).
 * - The single producer (the telemetry plugin) passes exactly
 *   `{ method, route, status }` where `route` is Fastify's route
 *   template (one of the 17 frozen paths, or the literal `'unknown'`
 *   bucket for unmatched URLs) and `method`/`status` come from
 *   server-observed values. Raw URLs, user IDs, request IDs, emails,
 *   IPs, tokens, and query strings cannot appear: there is no parameter
 *   for them to travel through.
 * - Recording never throws and never blocks: the plugin guards customer
 *   implementations, and the built-ins are pure arithmetic.
 *
 * Deliberately absent: per-auth-flow counters. Authentication and
 * authorization already emit structured, countable security events
 * (M8.3); dual instrumentation would double the surface for no new
 * signal.
 */

export type MetricLabels = {
  readonly method: string;
  readonly route: string;
  readonly status: string;
};

export type Counter = {
  increment(labels: MetricLabels): void;
};

export type Histogram = {
  observe(valueSeconds: number, labels: Omit<MetricLabels, 'status'>): void;
};

export type ForgeMetrics = {
  /** Every completed in-pipeline response, by method/route-template/status. */
  httpRequestsTotal: Counter;
  /** Response latency in seconds, by method/route-template. */
  httpRequestDurationSeconds: Histogram;
  /** Completed 5xx responses, by method/route-template/status. */
  httpErrorsTotal: Counter;
};

const noopCounter: Counter = {
  increment: () => {},
};

const noopHistogram: Histogram = {
  observe: () => {},
};

/** Default metrics: the application runs normally with no backend. */
export const noopMetrics: ForgeMetrics = {
  httpRequestsTotal: noopCounter,
  httpRequestDurationSeconds: noopHistogram,
  httpErrorsTotal: noopCounter,
};

export type MetricSample = {
  readonly labels: Record<string, string>;
  readonly value: number;
};

/**
 * In-memory implementation for tests and as the reference customer
 * adapter. Bounded by design: counters accumulate per label-set,
 * histograms keep `{ sum, count }` only (no raw value retention).
 */
export function inMemoryMetrics(): {
  metrics: ForgeMetrics;
  snapshot(): {
    counters: Record<string, ReadonlyArray<MetricSample>>;
    histograms: Record<string, ReadonlyArray<{ labels: Record<string, string>; sum: number; count: number }>>;
  };
} {
  const counters = new Map<string, Map<string, number>>();
  const histograms = new Map<string, Map<string, { sum: number; count: number }>>();

  function keyOf(labels: Record<string, string>): string {
    return Object.keys(labels)
      .sort()
      .map((key) => `${key}=${labels[key]}`)
      .join(',');
  }

  function counter(name: string): Counter {
    return {
      increment(labels: MetricLabels): void {
        let series = counters.get(name);
        if (series === undefined) {
          series = new Map();
          counters.set(name, series);
        }
        const key = keyOf(labels as Record<string, string>);
        series.set(key, (series.get(key) ?? 0) + 1);
      },
    };
  }

  function histogram(name: string): Histogram {
    return {
      observe(valueSeconds: number, labels: Omit<MetricLabels, 'status'>): void {
        if (!Number.isFinite(valueSeconds) || valueSeconds < 0) {
          return;
        }
        let series = histograms.get(name);
        if (series === undefined) {
          series = new Map();
          histograms.set(name, series);
        }
        const key = keyOf(labels as Record<string, string>);
        const current = series.get(key) ?? { sum: 0, count: 0 };
        series.set(key, { sum: current.sum + valueSeconds, count: current.count + 1 });
      },
    };
  }

  const metrics: ForgeMetrics = {
    httpRequestsTotal: counter('http.requests.total'),
    httpRequestDurationSeconds: histogram('http.request.duration.seconds'),
    httpErrorsTotal: counter('http.errors.total'),
  };

  function snapshot(): {
    counters: Record<string, ReadonlyArray<MetricSample>>;
    histograms: Record<string, ReadonlyArray<{ labels: Record<string, string>; sum: number; count: number }>>;
  } {
    const counterSamples: Record<string, Array<MetricSample>> = {};
    for (const [name, series] of counters) {
      counterSamples[name] = [...series].map(([key, value]) => ({
        labels: parseKey(key),
        value,
      }));
    }
    const histogramSamples: Record<
      string,
      Array<{ labels: Record<string, string>; sum: number; count: number }>
    > = {};
    for (const [name, series] of histograms) {
      histogramSamples[name] = [...series].map(([key, { sum, count }]) => ({
        labels: parseKey(key),
        sum,
        count,
      }));
    }
    return { counters: counterSamples, histograms: histogramSamples };
  }

  function parseKey(key: string): Record<string, string> {
    return Object.fromEntries(key.split(',').map((pair) => pair.split('=') as [string, string]));
  }

  return { metrics, snapshot };
}
