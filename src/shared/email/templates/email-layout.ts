import { escapeHtml } from './html-escape.js';

/**
 * Shared email layout and components (M11.4).
 *
 * One layout, three templates, no design system. The components exist because
 * all three authentication emails genuinely reuse them (an intro, optional
 * action link, closing guidance, a security notice, a footer); anything a
 * single template needs alone stays inline in that template.
 *
 * Email-client constraints this layout respects (deliberate, not accidental):
 *
 * - Table-based structure. Every mainstream client renders tables; flexbox and
 *   grid are stripped by several of them.
 * - Inline styles only. `<style>` blocks are dropped by Gmail and others.
 * - **No colours.** Forge defines no brand palette (§15: branding must come
 *   from established product configuration, and none exists). Layout therefore
 *   expresses structure — spacing, a border, an underline — and never invents
 *   brand or marketing identity. `border: 1px solid` without a colour renders
 *   in the client's text colour.
 * - No JavaScript, no `<script>`, no `<iframe>`, no `<form>`, no remote image,
 *   no tracking pixel, no web font, no external stylesheet. Nothing in a Forge
 *   email executes or phones home.
 * - The plain-text rendering is produced by the templates themselves from the
 *   same content, not by stripping tags out of the HTML. A tag stripper is a
 *   lossy, unpredictable transformation; two renderings of one content model
 *   cannot drift apart.
 */

/**
 * Content model of the shared layout. Only `action.url` is caller-supplied
 * data; every other field is trusted copy written inside a template.
 */
export type EmailLayoutContent = {
  /** Subject line; also used as the HTML `<title>`. Trusted template copy. */
  readonly subject: string;
  /** Visible heading. Trusted template copy. */
  readonly heading: string;
  /** Body paragraphs in order. Entries may embed caller data, so each is escaped. */
  readonly paragraphs: readonly string[];
  /** Optional call to action. Omitted entirely when a template has no link. */
  readonly action?: { readonly label: string; readonly url: string };
  /** Closing guidance, rendered as the final paragraph. */
  readonly closing: string;
  /** Security notice, rendered in its own emphasised block. */
  readonly notice: string;
};

/**
 * Neutral, factual footer shared by every Forge email.
 *
 * It states only that the message is automated. It invents no support channel,
 * no address, no legal entity, and no unsubscribe link — none of that exists
 * in Forge V1, and an invented promise in an email footer is a support
 * liability, not a nicety.
 */
export const EMAIL_FOOTER_TEXT =
  'This is an automated message from Oxyide Forge. It was sent because of activity on your account.';

/**
 * Renders the HTML body for a template.
 *
 * Escaping contract: every caller-supplied value (the action URL, and any
 * caller data a template embedded in a paragraph) is escaped here. Template
 * copy is escaped too — it costs nothing and means a future copy edit can
 * never open an injection hole.
 */
export function renderEmailLayout(content: EmailLayoutContent): string {
  const paragraphs = content.paragraphs
    .map((paragraph) => `      <p style="margin:0 0 16px 0;line-height:1.5;">${escapeHtml(paragraph)}</p>`)
    .join('\n');

  // A link is rendered twice on purpose: as the visible action control and as
  // the plain URL underneath it. Some clients and some readers strip styling,
  // and a reset link a human cannot see or copy is a failed recovery.
  const action =
    content.action === undefined
      ? ''
      : [
          '      <p style="margin:0 0 16px 0;">',
          `        <a href="${escapeHtml(content.action.url)}" style="display:inline-block;padding:12px 20px;border:1px solid;text-decoration:none;">${escapeHtml(content.action.label)}</a>`,
          '      </p>',
          `      <p style="margin:0 0 16px 0;line-height:1.5;word-break:break-all;">${escapeHtml(content.action.url)}</p>`,
        ].join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    <title>${escapeHtml(content.subject)}</title>`,
    '  </head>',
    '  <body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;">',
    '    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">',
    '      <tr>',
    '        <td align="center">',
    '          <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;">',
    '            <tr>',
    `              <td style="padding:0 0 16px 0;"><h1 style="margin:0;font-size:20px;line-height:1.3;">${escapeHtml(content.heading)}</h1></td>`,
    '            </tr>',
    '            <tr>',
    '              <td style="padding:0;">',
    paragraphs,
    action,
    `      <p style="margin:0 0 16px 0;line-height:1.5;">${escapeHtml(content.closing)}</p>`,
    '      <p style="margin:0 0 16px 0;line-height:1.5;border-top:1px solid;padding-top:16px;">',
    `        ${escapeHtml(content.notice)}`,
    '      </p>',
    '            </td>',
    '            </tr>',
    '            <tr>',
    `              <td style="padding:16px 0 0 0;border-top:1px solid;font-size:12px;line-height:1.4;">${escapeHtml(EMAIL_FOOTER_TEXT)}</td>`,
    '            </tr>',
    '          </table>',
    '        </td>',
    '      </tr>',
    '    </table>',
    '  </body>',
    '</html>',
  ].join('\n');
}

/**
 * Renders the plain-text body for a template.
 *
 * Plain text is a first-class output, not a fallback derived from HTML: no
 * markup, no attributes, deterministic `\n\n` paragraph separation, and the
 * action URL reproduced byte-for-byte so it can be copied out of the message.
 */
export function renderEmailText(content: EmailLayoutContent): string {
  const blocks = [...content.paragraphs];
  if (content.action !== undefined) {
    blocks.push(`${content.action.label}:`, content.action.url);
  }
  blocks.push(content.closing, content.notice, EMAIL_FOOTER_TEXT);
  return blocks.join('\n\n');
}