import { describe, expect, it } from 'vitest';

import { extractTraceContext, TRACEPARENT_HEADER } from './trace-context.js';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const VALID_UNSAMPLED = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00';

/**
 * M8.4 — W3C traceparent extraction boundary proofs.
 *
 * Only exact version-00 shapes with non-zero IDs are accepted; everything
 * else yields null (absent context, never an error, never a bypass). The
 * header name constant is pinned so producers and tests cannot drift.
 */
describe('traceparent extraction contract', () => {
  it('exposes the header name', () => {
    expect(TRACEPARENT_HEADER).toBe('traceparent');
  });

  it('accepts a valid version-00 context with the sampled flag', () => {
    expect(extractTraceContext({ traceparent: VALID })).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      sampled: true,
    });
    expect(extractTraceContext({ traceparent: VALID_UNSAMPLED })?.sampled).toBe(false);
  });

  it('accepts the first value of a duplicated header', () => {
    expect(extractTraceContext({ traceparent: [VALID, 'garbage'] })?.traceId).toBe(
      '4bf92f3577b34da6a3ce929d0e0e4736',
    );
  });

  it('rejects unknown versions, ff, zero IDs, and malformed shapes', () => {
    const bad = [
      '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
      '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra',
      '00-xyz',
      '',
      'Bearer secret',
    ];
    for (const value of bad) {
      expect(extractTraceContext({ traceparent: value }), value).toBeNull();
    }
  });

  it('rejects hostile and non-string input without throwing', () => {
    expect(extractTraceContext(null)).toBeNull();
    expect(extractTraceContext(undefined)).toBeNull();
    expect(extractTraceContext('traceparent: x')).toBeNull();
    expect(extractTraceContext({ traceparent: 42 })).toBeNull();
    expect(extractTraceContext({ traceparent: { nested: 'x' } })).toBeNull();
    expect(extractTraceContext({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\r\nX-Injected: yes' })).toBeNull();
    expect(extractTraceContext({ traceparent: `00-${'ab'.repeat(64)}-00f067aa0ba902b7-01` })).toBeNull();
    expect(extractTraceContext({})).toBeNull();
  });
});
