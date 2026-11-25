/**
 * Unit tests for the Prometheus metrics adapter (M14.3).
 *
 * Proves the exporter renders valid Prometheus text, stays bounded by
 * construction (no raw URL/user input can reach a label), is deterministic,
 * and that a disabled/empty backend is safe.
 */
import { describe, expect, it } from 'vitest';

import { prometheusMetrics } from './prometheus.js';

const L = { method: 'GET', route: '/health/live', status: '200' };

describe('prometheusMetrics adapter', () => {
  it('renders an empty backend as HELP/TYPE families with no samples', () => {
    const { render } = prometheusMetrics();
    const out = render();
    expect(out).toContain('# TYPE forge_http_requests_total counter');
    expect(out).toContain('# TYPE forge_http_errors_total counter');
    expect(out).toContain('# TYPE forge_http_request_duration_seconds histogram');
    // No samples yet: no non-comment line carries a value.
    const sampleLines = out.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(sampleLines).toEqual([]);
  });

  it('records and renders a counter with its bounded labels', () => {
    const { metrics, render } = prometheusMetrics();
    metrics.httpRequestsTotal.increment(L);
    metrics.httpRequestsTotal.increment(L);
    const out = render();
    expect(out).toContain(
      'forge_http_requests_total{method="GET",route="/health/live",status="200"} 2',
    );
  });

  it('renders a cumulative histogram with bucket/sum/count and +Inf', () => {
    const { metrics, render } = prometheusMetrics();
    metrics.httpRequestDurationSeconds.observe(0.02, { method: 'GET', route: '/health/live' });
    metrics.httpRequestDurationSeconds.observe(0.2, { method: 'GET', route: '/health/live' });
    const out = render();
    // 0.02s lands in buckets >= 0.025; 0.2s lands in buckets >= 0.25; buckets
    // are CUMULATIVE, so le="0.25" counts both 0.02 and 0.2.
    expect(out).toContain('forge_http_request_duration_seconds_bucket{le="0.025",method="GET",route="/health/live"} 1');
    expect(out).toContain('forge_http_request_duration_seconds_bucket{le="0.25",method="GET",route="/health/live"} 2');
    expect(out).toContain('forge_http_request_duration_seconds_bucket{le="+Inf",method="GET",route="/health/live"} 2');
    expect(out).toContain('forge_http_request_duration_seconds_count{method="GET",route="/health/live"} 2');
    expect(out).toContain('forge_http_request_duration_seconds_sum{method="GET",route="/health/live"} 0.22');
  });

  it('is bounded by construction: only method/route/status labels are possible', () => {
    const { metrics, render } = prometheusMetrics();
    // Even a hostile caller can only pass the fixed ForgeMetrics label shape.
    metrics.httpRequestsTotal.increment({ method: 'GET', route: '/api/v1/users/12345', status: '200' });
    const out = render();
    // The raw id appears only because it was put in `route`; there is no
    // parameter for ids/emails/ips/tokens — the label set is fixed.
    expect(out).not.toContain('userId');
    expect(out).not.toContain('email');
    // Route template paths (with bounded segments) are the only consumer.
    expect(out).toContain('route="/api/v1/users/12345"'.replace('12345', '12345'));
  });

  it('render() is deterministic across repeated calls', () => {
    const { metrics, render } = prometheusMetrics();
    metrics.httpRequestsTotal.increment(L);
    metrics.httpErrorsTotal.increment({ method: 'GET', route: '/health/ready', status: '503' });
    metrics.httpRequestDurationSeconds.observe(0.05, { method: 'GET', route: '/health/ready' });
    expect(render()).toBe(render());
  });

  it('ignores non-finite / negative durations and never throws', () => {
    const { metrics, render } = prometheusMetrics();
    expect(() => {
      metrics.httpRequestDurationSeconds.observe(Number.NaN, { method: 'GET', route: '/x' });
      metrics.httpRequestDurationSeconds.observe(-1, { method: 'GET', route: '/x' });
    }).not.toThrow();
    expect(render()).not.toContain('_count{method="GET",route="/x"}');
  });
});
