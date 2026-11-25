import { assertEmailMessage, type EmailMessage } from './email-message.js';

/**
 * Canonical email provider boundary (M11.1).
 *
 * Forge core depends on this abstraction — never on SMTP, Nodemailer, a
 * vendor SDK, or an HTTP email API. A later milestone implements this
 * interface for SMTP (M11.2); customers may replace that implementation
 * without touching authentication or business logic.
 *
 * Contract rules for implementations (load-bearing, asserted in tests):
 *
 * - One call performs ONE provider operation. Retry orchestration does NOT
 *   belong here: retry policy, if ever needed, lives with the caller above
 *   this boundary. No loops, no queues, no outbox, no workers.
 * - All failures translate to `EmailDeliveryError` with a static, safe
 *   message. Raw provider errors (SMTP responses, SDK objects, driver
 *   errors) MUST NOT escape: they can carry recipients, bodies, hosts, or
 *   credentials. Translate at the boundary; discard the original.
 * - Never retain credentials, never log message content, never mutate the
 *   caller's message.
 * - `send` resolves `undefined` on acceptance. There is deliberately no
 *   result object: current callers ignore results, and a message-id or
 *   status envelope can be added compatibly if M11.3 operational logging
 *   ever requires one.
 */
export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

/**
 * The single neutral error for email-delivery failure (M11.1).
 *
 * This is the ONLY new error class in the email boundary — not a taxonomy.
 * It lets application code distinguish "delivery failed" (catch this, log
 * safely, continue best-effort) from "programming bug" (anything else,
 * fail-fast). It deliberately does NOT extend `AppError`: `AppError` carries
 * an HTTP status code, and HTTP semantics belong exclusively to the frozen
 * M6 error architecture. Provider failures are a service concern; the M6
 * mapper is never involved at this stage.
 *
 * - `message` must be static and safe. Implementations pass only fixed text —
 *   never recipient addresses, bodies, hosts, credentials, or provider
 *   verbatim errors.
 * - No `cause`, no `code`, no metadata fields. A cause chain would smuggle
 *   the raw provider error (and whatever it echoes) into logs the moment
 *   anyone serializes this error. Translate, then discard.
 */
export class EmailDeliveryError extends Error {
  constructor(message: string = 'Email delivery failed.') {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

/**
 * No-operation provider: validates the message contract, delivers nothing.
 *
 * This is the production default until M11.2 provides a real transport, and
 * it preserves the exact M3 posture (default transport delivers nothing).
 * Validation is intentional: a miswired caller fails fast in development and
 * test instead of silently dropping malformed messages into a void.
 */
export const noopEmailProvider: EmailProvider = {
  async send(message: EmailMessage): Promise<void> {
    assertEmailMessage(message);
  },
};
