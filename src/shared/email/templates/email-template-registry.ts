import {
  renderEmailVerificationTemplate,
  renderPasswordResetTemplate,
  renderSecurityNotificationTemplate,
  type EmailVerificationTemplateData,
  type PasswordResetTemplateData,
  type RenderedEmailContent,
  type SecurityNotificationTemplateData,
} from './email-templates.js';

/**
 * Canonical email template registry (M11.4).
 *
 * One closed vocabulary, one dispatch function, one place to add a template.
 *
 * - The key type is derived from a `const` tuple, so the key set and the
 *   renderer map are checked against each other at compile time: a key without
 *   a renderer, or a renderer without a key, does not build.
 * - The key is never caller input from a request. It comes from our own code
 *   (the authentication adapter), which is what makes a closed vocabulary
 *   enforceable at all.
 * - Dispatch is a property lookup guarded by an own-property check, not
 *   `eval`, not filesystem scanning, not reflection, and not a plugin
 *   registry. Adding a template is an explicit edit to two declarations in
 *   this directory.
 * - An unknown key throws a plain `Error` naming the key. A programming bug
 *   fails fast and loudly; it can never degrade into "no email sent".
 */

/** The complete, closed template vocabulary. */
export const EMAIL_TEMPLATE_KEYS = [
  'EMAIL_VERIFICATION',
  'PASSWORD_RESET',
  'SECURITY_NOTIFICATION',
] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

/** Template data contract per key — the dispatch signature is data-specific. */
export type EmailTemplateDataByKey = {
  EMAIL_VERIFICATION: EmailVerificationTemplateData;
  PASSWORD_RESET: PasswordResetTemplateData;
  SECURITY_NOTIFICATION: SecurityNotificationTemplateData;
};

/** Renderer signature shared by every template: pure data in, content out. */
export type EmailTemplateRenderer<K extends EmailTemplateKey> = (
  data: EmailTemplateDataByKey[K],
) => RenderedEmailContent;

/**
 * The registry. Typed as a total record over the key union so TypeScript
 * requires an entry for every key.
 */
export const EMAIL_TEMPLATES: {
  readonly [K in EmailTemplateKey]: EmailTemplateRenderer<K>;
} = {
  EMAIL_VERIFICATION: renderEmailVerificationTemplate,
  PASSWORD_RESET: renderPasswordResetTemplate,
  SECURITY_NOTIFICATION: renderSecurityNotificationTemplate,
};

/**
 * Renders one template.
 *
 * Generic over the key, so `renderEmailTemplate('PASSWORD_RESET', { verificationUrl })`
 * is a compile error: each key accepts only its own data contract.
 */
export function renderEmailTemplate<K extends EmailTemplateKey>(
  key: K,
  data: EmailTemplateDataByKey[K],
): RenderedEmailContent {
  const renderer: EmailTemplateRenderer<K> | undefined = Object.prototype.hasOwnProperty.call(
    EMAIL_TEMPLATES,
    key,
  )
    ? EMAIL_TEMPLATES[key]
    : undefined;

  if (renderer === undefined) {
    throw new Error(`Unknown email template: ${String(key)}`);
  }

  return renderer(data);
}