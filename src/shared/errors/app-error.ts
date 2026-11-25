/**
 * Application error class for domain-level errors.
 * Services throw AppError subclasses with namespaced error codes.
 * The HTTP layer maps these to RFC 7807 problem details.
 *
 * `message` is the safe public message. `title`/`detail` default to it;
 * HTTP-adjacent throwers (guards) may override either to preserve their
 * established public bodies exactly — services never do (their title and
 * detail are the message). No headers, causes, or metadata live here:
 * services stay HTTP-free; the mapper owns transport representation.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly title: string;
  readonly detail: string;

  constructor(code: string, statusCode: number, message: string, options?: { title?: string; detail?: string }) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.title = options?.title ?? message;
    this.detail = options?.detail ?? message;
  }
}
