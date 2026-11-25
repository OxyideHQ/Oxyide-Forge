/**
 * Canonical email message contract (M11.1).
 *
 * This is the single transport-neutral shape for "an email Forge wants sent".
 * It represents a complete sendable request — never SMTP configuration, never
 * credentials, never provider state. Provider implementations (M11.2+) consume
 * exactly this type; application code produces it.
 *
 * Deliberate boundaries:
 *
 * - `from` is required, not defaulted. A default sender is configuration, and
 *   configuration belongs to M11.2 (SMTP) or to the wiring that calls the
 *   provider (M11.3) — never to the message itself, where a silent default
 *   would hide which identity actually sent the mail.
 * - `to` is a non-empty readonly list. Single-recipient callers pass one
 *   element; the list is the honest transport shape and a degenerate case
 *   needs no second representation.
 * - `textBody` is required. Every Forge V1 email has a text form (the M3
 *   mailer ports are text-only by policy); `htmlBody` is optional for M11.4
 *   templates. Bodies are opaque content — never validated beyond presence,
 *   never logged.
 * - No `cc`/`bcc`/`replyTo`/`headers`. No Forge V1 flow needs them, and each
 *   field must earn its place. Adding an optional field later is a compatible
 *   change; adding one now without a consumer would be speculation.
 * - String fields are validated against control characters at this boundary
 *   (see `assertEmailMessage`). Header fields flow toward SMTP eventually, so
 *   CR/LF rejection here is a security requirement, not hardening theater.
 *   Bodies are exempt: content legitimately contains anything.
 *
 * `readonly` throughout: providers must not mutate the caller's message
 * (asserted in `email-provider.test.ts`).
 */
export interface EmailMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody?: string;
}

/** Control characters rejected in header fields (Unicode Cc: C0, DEL, C1). Property escape avoids literal control characters, which lint forbids. */
const CONTROL_CHARS = /\p{Cc}/u;

/**
 * Asserts that an unknown value is a well-formed `EmailMessage`.
 *
 * Throws a plain `Error` — never `EmailDeliveryError` — because a malformed
 * message is a caller programming bug, not a delivery failure. Callers catch
 * `EmailDeliveryError` for operational failure; anything else is fail-fast.
 *
 * Messages name the offending FIELD and the expected shape only. They never
 * echo values: values can carry PII (addresses) or content, and validation
 * failures surface in logs.
 */
export function assertEmailMessage(message: unknown): asserts message is EmailMessage {
  if (typeof message !== 'object' || message === null) {
    throw new Error('Invalid email message: expected an object.');
  }
  const candidate = message as Record<string, unknown>;

  assertHeaderField(candidate['from'], 'from', { allowEmpty: false });
  assertRecipients(candidate['to']);
  assertHeaderField(candidate['subject'], 'subject', { allowEmpty: false });

  if (typeof candidate['textBody'] !== 'string' || candidate['textBody'].length === 0) {
    throw new Error('Invalid email message: textBody must be a non-empty string.');
  }

  if (candidate['htmlBody'] !== undefined && typeof candidate['htmlBody'] !== 'string') {
    throw new Error('Invalid email message: htmlBody must be a string when present.');
  }
}

function assertHeaderField(
  value: unknown,
  field: 'from' | 'subject',
  options: { allowEmpty: boolean },
): void {
  if (typeof value !== 'string' || (value.length === 0 && !options.allowEmpty)) {
    throw new Error(`Invalid email message: ${field} must be a non-empty string.`);
  }
  if (value.trim().length === 0 && !options.allowEmpty) {
    throw new Error(`Invalid email message: ${field} must not be blank.`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw new Error(`Invalid email message: ${field} must not contain control characters.`);
  }
}

function assertRecipients(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Invalid email message: to must be a non-empty array.');
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error('Invalid email message: every recipient must be a non-blank string.');
    }
    if (CONTROL_CHARS.test(entry)) {
      throw new Error(
        'Invalid email message: recipients must not contain control characters.',
      );
    }
  }
}
