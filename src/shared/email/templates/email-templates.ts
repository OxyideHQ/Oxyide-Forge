import {
  renderEmailLayout,
  renderEmailText,
  type EmailLayoutContent,
} from './email-layout.js';

/**
 * Canonical Forge authentication email templates (M11.4).
 *
 * A template is a **pure function of typed data**: `data → { subject, text,
 * html }`. There is no I/O, no configuration, no environment, no database, no
 * clock, no randomness, no request context, and no transport knowledge. The
 * same data always renders byte-identically, which is what makes the templates
 * testable, diffable, and safe to run from a job, a CLI, or a test.
 *
 * Data contracts are per-template and deliberately tiny. Nothing that is not
 * literally printed in the message is accepted, so a future domain-model change
 * cannot silently widen what a template can see. Specifically excluded by
 * construction: passwords, password/reset/verification token hashes, session
 * or refresh tokens, JWTs, cookies, `User` rows, Prisma models, `AuthContext`,
 * SMTP configuration, and internal identifiers.
 *
 * One-time URLs are the single sensitive value a template accepts, and only
 * where the message must contain one. The template receives the finished URL
 * and never learns how it was built, which token it carries, or how long it
 * lives — URL construction belongs to the application layer that owns the base
 * URL configuration.
 *
 * Copy ownership moved here in M11.4. Before this milestone the security
 * notices' subject and body were assembled inside the authentication service
 * (M3.17), which split presentation ownership between two layers. Subjects and
 * wording are preserved verbatim from M11.3/M3.17; only the owner changed.
 */

/** The result of rendering one template: everything except addressing. */
export type RenderedEmailContent = {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
};

/** Data for the address-confirmation email. */
export type EmailVerificationTemplateData = {
  /** Finished verification URL, including its one-time token. */
  readonly verificationUrl: string;
};

/** Data for the password-recovery email. */
export type PasswordResetTemplateData = {
  /** Finished reset URL, including its one-time token. */
  readonly resetUrl: string;
};

/**
 * Data for a security notice.
 *
 * A closed discriminated union, not a bag of optional fields: an unsupported
 * event cannot render at all, and the account-lockout branch cannot be given
 * data it does not print.
 *
 * The literal `type` values deliberately mirror the authentication module's
 * `SecurityNotificationType`. `shared` must not import a business module, so
 * the vocabulary is restated here and pinned by a test asserting the two
 * unions stay identical.
 */
export type SecurityNotificationTemplateData =
  | { readonly type: 'ACCOUNT_LOCKED'; readonly lockoutDurationText: string }
  | { readonly type: 'PASSWORD_RESET_SUCCEEDED' };

/**
 * Address confirmation.
 *
 * Says exactly what verification does and nothing more: it proves control of
 * the address. It creates no session, changes no password, and grants no
 * access, and the notice states that explicitly so a reader never expects to
 * be signed in afterwards.
 */
export function renderEmailVerificationTemplate(
  data: EmailVerificationTemplateData,
): RenderedEmailContent {
  const content: EmailLayoutContent = {
    subject: 'Verify your Oxyide email address',
    heading: 'Confirm your email address',
    paragraphs: ['Confirm this address to finish setting up your Oxyide account.'],
    action: { label: 'Confirm my email address', url: data.verificationUrl },
    closing:
      'If you did not create an account, no action is needed and you can ignore this message.',
    notice:
      'This link confirms your address only. It does not sign you in, does not change your password, and does not grant access to your account.',
  };

  return {
    subject: content.subject,
    text: renderEmailText(content),
    html: renderEmailLayout(content),
  };
}

/**
 * Password recovery.
 *
 * Factual about consequences and about what the link is: single use, expiring,
 * and equivalent in sensitivity to the password it replaces. It never claims
 * the account was compromised, because requesting a reset proves nothing about
 * who requested it.
 */
export function renderPasswordResetTemplate(data: PasswordResetTemplateData): RenderedEmailContent {
  const content: EmailLayoutContent = {
    subject: 'Reset your Oxyide password',
    heading: 'Reset your password',
    paragraphs: ['Use the link below to choose a new Oxyide password.'],
    action: { label: 'Choose a new password', url: data.resetUrl },
    closing:
      'If you did not request a password reset, no account change was made and you can ignore this message.',
    notice:
      'The link can be used once and expires on its own. Anyone who has it can change your password, so do not forward this message.',
  };

  return {
    subject: content.subject,
    text: renderEmailText(content),
    html: renderEmailLayout(content),
  };
}

/**
 * Security notices.
 *
 * The existing M3.17/M11.3 semantics are the source contract and are preserved
 * word for word: a lockout proves repeated unsuccessful sign-in attempts, not
 * compromise, so neither notice claims the account was accessed or names an
 * attacker. Neither notice contains a link, a token, a credential, a counter,
 * or a timestamp — a security alert must not become a credential channel.
 */
export function renderSecurityNotificationTemplate(
  data: SecurityNotificationTemplateData,
): RenderedEmailContent {
  const content: EmailLayoutContent = buildSecurityNotice(data);
  return {
    subject: content.subject,
    text: renderEmailText(content),
    html: renderEmailLayout(content),
  };
}

/**
 * Exhaustive dispatch over the closed event vocabulary.
 *
 * An unrecognised kind throws rather than falling through to another branch:
 * silently rendering the password-change notice for an unknown event would tell
 * a customer the wrong thing about their account, which is worse than a loud
 * failure. This mirrors the registry's unknown-key guard.
 */
function buildSecurityNotice(data: SecurityNotificationTemplateData): EmailLayoutContent {
  // Widened once so the unreachable-branch guard can name the offending kind
  // without a cast: inside `default`, `data` is narrowed to `never`. The switch
  // itself still discriminates on `data.type`, which is what keeps each branch
  // narrowed to its own data shape.
  const kind: string = data.type;

  switch (data.type) {
    case 'ACCOUNT_LOCKED':
      return {
        subject: 'Security alert: account temporarily locked',
        heading: 'Your account is temporarily locked',
        paragraphs: [
          'Your Oxyide account was temporarily locked after repeated unsuccessful sign-in attempts.',
          `The lockout lasts ${data.lockoutDurationText}. You can try signing in again after it expires.`,
        ],
        closing:
          'If you did not make these attempts, reset your password using the existing password recovery flow once the account becomes available.',
        notice:
          'A lockout means repeated unsuccessful sign-in attempts. It does not mean your account was accessed.',
      };
    case 'PASSWORD_RESET_SUCCEEDED':
      return {
        subject: 'Security alert: password changed',
        heading: 'Your password was changed',
        paragraphs: [
          'Your Oxyide password was successfully changed.',
          'Existing sessions were revoked as part of password recovery. You will need to sign in again on your devices.',
        ],
        closing:
          'If you did not make this change, use the account recovery process (password reset) to regain control of your account.',
        notice: 'This message contains no password, no link, and no account identifier.',
      };
    default:
      throw new Error(`Unknown security notification: ${kind}`);
  }
}