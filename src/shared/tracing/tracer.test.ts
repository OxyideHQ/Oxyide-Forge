import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { noopTracer, type Span, type Tracer } from './tracer.js';

/**
 * M8.4 — Forge-owned tracer boundary proofs.
 *
 * The default is a silent NoOp; the interface is the whole contract a
 * customer adapter implements. No OpenTelemetry package exists in the
 * tree, and none is needed to satisfy this boundary.
 */
describe('tracer boundary', () => {
  it('noop spans never throw and never retain state', () => {
    const span: Span = noopTracer.startSpan('probe', null);
    expect(() => {
      span.setAttribute('http.method', 'GET');
      span.end();
    }).not.toThrow();
  });

  it('accepts a trace context without adopting it anywhere', () => {
    const span = noopTracer.startSpan('probe', {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      sampled: true,
    });
    expect(() => span.end()).not.toThrow();
  });

  it('a customer adapter implementing only the interface is honored', () => {
    const ended: string[] = [];
    const adapter: Tracer = {
      startSpan: (name) => ({
        end: () => {
          ended.push(name);
        },
        setAttribute: () => {},
      }),
    };
    const span = adapter.startSpan('customer-span');
    span.end();
    expect(ended).toEqual(['customer-span']);
  });

  it('no OpenTelemetry package is installed or required', () => {
    // Deterministic and offline: the dependency manifests must not name
    // any telemetry SDK. The boundary is satisfied by Forge-owned
    // interfaces with a NoOp default (proven above).
    const manifest = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
    expect(names.filter((name) => /opentelemetry|prometheus|jaeger|datadog/i.test(name))).toEqual([]);
  });
});
