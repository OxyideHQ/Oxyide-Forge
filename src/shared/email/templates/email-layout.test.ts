import { describe, expect, it } from 'vitest';

import {
  EMAIL_FOOTER_TEXT,
  renderEmailLayout,
  renderEmailText,
  type EmailLayoutContent,
} from './email-layout.js';

/**
 * M11.4 — shared layout/component tests.
 *
 * The layout is shared by all three authentication templates, so a defect here
 * is a defect in every Forge email. These tests pin the email-client
 * constraints, the deterministic text rendering, and the escaping contract of
 * the one caller-supplied field (the action URL).
 */

const CONTENT: EmailLayoutContent = {
  subject: 'Reset your Oxyide password',
  heading: 'Reset your password',
  paragraphs: ['Use the link below to choose a new Oxyide password.'],
  action: { label: 'Choose a new password', url: 'https://app.example.com/reset?token=abc123' },
  closing: 'If you did not request a password reset, no account change was made.',
  notice: 'The link can be used once and expires on its own.',
};

const WITHOUT_ACTION: EmailLayoutContent = {
  ...CONTENT,
  action: undefined,
};

describe('renderEmailLayout', () => {
  it('produces a complete, table-based document', () => {
    const html = renderEmailLayout(CONTENT);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>Reset your Oxyide password</title>');
    expect(html).toContain('<table role="presentation"');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('renders the action as a link and repeats the URL in plain text form', () => {
    const html = renderEmailLayout(CONTENT);

    expect(html).toContain('<a href="https://app.example.com/reset?token=abc123"');
    expect(html).toContain('https://app.example.com/reset?token=abc123');
    expect(html).toContain('Choose a new password</a>');
  });

  it('omits the action entirely when a template has no link', () => {
    const html = renderEmailLayout(WITHOUT_ACTION);

    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
  });

  it('escapes a hostile action URL in the href attribute', () => {
    const html = renderEmailLayout({
      ...CONTENT,
      action: { label: 'Go', url: 'https://x.example/?a=1&b=" onmouseover="alert(1)' },
    });

    // The escape is what matters: the attacker's quotes became entities, so the
    // anchor still has exactly the two attributes we wrote. Asserting "no
    // `onmouseover` substring" would be wrong — the escaped text legitimately
    // contains those characters (the M78-F04 detector-vs-code class).
    expect(html).toContain('&quot; onmouseover=&quot;alert(1)');
    const anchor = /<a href="([^"]*)" style="([^"]*)">([^<]*)<\/a>/.exec(html);
    expect(anchor, 'anchor is not a well-formed two-attribute element').not.toBeNull();
    expect(anchor?.[1]).toContain('&quot;');
    expect(anchor?.[1]).not.toContain('"');
  });

  it('escapes caller data embedded in a paragraph', () => {
    const html = renderEmailLayout({
      ...CONTENT,
      paragraphs: ['<script>alert(1)</script>'],
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('contains no executable, remote, or tracking content', () => {
    const html = renderEmailLayout(CONTENT);

    for (const forbidden of [
      '<script',
      '<iframe',
      '<form',
      '<object',
      '<embed',
      '<style',
      '<link',
      '<img',
      'onclick',
      'onload',
      'onerror',
      'http://',
      '//fonts.',
      'data:',
      'javascript:',
    ]) {
      expect(html, `layout contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('defines no brand colours or fonts', () => {
    const html = renderEmailLayout(CONTENT);

    // Forge has no brand palette; a template must never invent one.
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(html).not.toContain('rgb(');
    expect(html).not.toContain('@font-face');
    expect(html).not.toContain('googleapis');
  });
});

describe('renderEmailText', () => {
  it('renders paragraphs separated by a blank line, deterministically', () => {
    const text = renderEmailText(CONTENT);

    expect(text.split('\n\n')).toEqual([
      'Use the link below to choose a new Oxyide password.',
      'Choose a new password:',
      'https://app.example.com/reset?token=abc123',
      CONTENT.closing,
      CONTENT.notice,
      EMAIL_FOOTER_TEXT,
    ]);
  });

  it('omits the action block when a template has no link', () => {
    const text = renderEmailText(WITHOUT_ACTION);

    expect(text).not.toContain('http');
    expect(text).not.toContain(':');
  });

  it('never leaks our own markup into the plain-text output', () => {
    const text = renderEmailText({
      ...CONTENT,
      paragraphs: ['<script>alert(1)</script> is not markup here'],
    });

    for (const forbidden of ['<!DOCTYPE', '<html', '<p ', '<table', '<a href', 'style=', 'href=']) {
      expect(text, `text output contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('preserves the action URL byte-for-byte so it can be copied', () => {
    const url = 'https://app.example.com/reset-password?token=aB3-_xY9&extra=%20';
    const text = renderEmailText({ ...CONTENT, action: { label: 'Go', url } });

    expect(text).toContain(url);
  });

  it('always ends with the shared footer', () => {
    expect(renderEmailText(CONTENT).endsWith(EMAIL_FOOTER_TEXT)).toBe(true);
    expect(renderEmailText(WITHOUT_ACTION).endsWith(EMAIL_FOOTER_TEXT)).toBe(true);
  });
});