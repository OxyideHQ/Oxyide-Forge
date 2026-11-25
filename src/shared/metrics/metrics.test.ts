import { describe, expect, it } from 'vitest';

import { inMemoryMetrics, noopMetrics } from './metrics.js';

/**
 * M8.4 — metrics boundary proofs.
 *
 * NoOp implementations never throw and record nothing; the in-memory
 * implementation accumulates counters and `{ sum, count }` histograms for
 * tests and reference. Cardinality is by construction (fixed instruments,
 * three label names), proven end-to-end in the telemetry suites.
 */
describe('metrics boundary', () => {
  it('noop instruments never throw and never retain', () => {
    expect(() => {
      noopMetrics.httpRequestsTotal.increment({ method: 'GET', route: '/health/live', status: '200' });
      noopMetrics.httpRequestDurationSeconds.observe(0.01, { method: 'GET', route: '/health/live' });
      noopMetrics.httpErrorsTotal.increment({ method: 'GET', route: '/health/live', status: '500' });
    }).not.toThrow();
  });

  it('in-memory counters accumulate per label set', () => {
    const { metrics, snapshot } = inMemoryMetrics();
    metrics.httpRequestsTotal.increment({ method: 'GET', route: '/health/live', status: '200' });
    metrics.httpRequestsTotal.increment({ method: 'GET', route: '/health/live', status: '200' });
    metrics.httpRequestsTotal.increment({ method: 'POST', route: '/api/v1/auth/login', status: '401' });
    const samples = snapshot().counters['http.requests.total'];
    expect(samples).toContainEqual({
      labels: { method: 'GET', route: '/health/live', status: '200' },
      value: 2,
    });
    expect(samples).toContainEqual({
      labels: { method: 'POST', route: '/api/v1/auth/login', status: '401' },
      value: 1,
    });
  });

  it('in-memory histograms keep sum and count, never raw values', () => {
    const { metrics, snapshot } = inMemoryMetrics();
    metrics.httpRequestDurationSeconds.observe(0.1, { method: 'GET', route: '/health/live' });
    metrics.httpRequestDurationSeconds.observe(0.3, { method: 'GET', route: '/health/live' });
    const series = snapshot().histograms['http.request.duration.seconds'];
    expect(series).toHaveLength(1);
    expect(series[0].labels).toEqual({ method: 'GET', route: '/health/live' });
    expect(series[0].sum).toBeCloseTo(0.4);
    expect(series[0].count).toBe(2);
  });

  it('in-memory histograms ignore non-finite and negative observations', () => {
    const { metrics, snapshot } = inMemoryMetrics();
    metrics.httpRequestDurationSeconds.observe(Number.NaN, { method: 'GET', route: '/x' });
    metrics.httpRequestDurationSeconds.observe(Number.POSITIVE_INFINITY, { method: 'GET', route: '/x' });
    metrics.httpRequestDurationSeconds.observe(-1, { method: 'GET', route: '/x' });
    expect(snapshot().histograms['http.request.duration.seconds'] ?? []).toHaveLength(0);
  });

  it('fresh instances share no state', () => {
    const first = inMemoryMetrics();
    first.metrics.httpRequestsTotal.increment({ method: 'GET', route: '/a', status: '200' });
    expect(inMemoryMetrics().snapshot().counters['http.requests.total'] ?? []).toHaveLength(0);
  });
});
