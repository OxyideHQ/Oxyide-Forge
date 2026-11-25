import { describe, expect, it } from 'vitest';

import { escapeHtml } from './html-escape.js';

/**
 * M11.4 — HTML escaping unit tests.
 *
 * The escaper is the entire sanitization boundary between template data and
 * markup, so it is tested against the hostile inputs an email pipeline can
 * plausibly meet rather than against a hand-picked happy path.
 */

/** Hostile values used across the escaping and template suites. */
export const HOSTILE_VALUES = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><a href="https://evil.example/">click</a>',
  "'><svg onload=alert(1)>",
  '& < > " \'',
  '&amp; already-escaped-looking',
  'javascript:alert(1)',
  'line\nbreak',
  '',
] as const;

describe('escapeHtml', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &#39;');
  });

  it('neutralises script injection', () => {
    const escaped = escapeHtml('<script>alert(1)</script>');

    expect(escaped).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escaped).not.toContain('<script');
  });

  it('neutralises attribute break-out in both quote styles', () => {
    expect(escapeHtml('" onmouseover="alert(1)')).not.toContain('"');
    expect(escapeHtml("' onmouseover='alert(1)")).not.toContain("'");
  });

  it('escapes ampersands exactly once, never re-escaping an escape', () => {
    const once = escapeHtml('a & b');
    expect(once).toBe('a &amp; b');
    expect(once).not.toContain('&amp;amp;');
  });

  it('is total and deterministic', () => {
    for (const value of HOSTILE_VALUES) {
      expect(escapeHtml(value)).toBe(escapeHtml(value));
      expect(typeof escapeHtml(value)).toBe('string');
    }
  });

  it('preserves content: escaping changes representation, never meaning', () => {
    for (const value of HOSTILE_VALUES) {
      // Removing markup restores the original text exactly.
      const restored = escapeHtml(value)
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&amp;', '&');
      expect(restored).toBe(value);
    }
  });

  it('leaves ordinary text untouched', () => {
    const plain = 'Reset your Oxyide password (30 minutes).';
    expect(escapeHtml(plain)).toBe(plain);
  });
});