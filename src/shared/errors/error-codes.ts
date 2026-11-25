/**
 * Namespaced error codes for the application.
 * Codes are SCREAMING_SNAKE_CASE and namespaced by module.
 * Once published, an error code's meaning and HTTP status do not change.
 *
 * Only codes required by currently implemented behavior are declared here.
 * Future milestones add codes when the corresponding behavior is implemented.
 */
export const ErrorCodes = {
  USERS_EMAIL_TAKEN: 'USERS_EMAIL_TAKEN',
  USERS_NOT_FOUND: 'USERS_NOT_FOUND',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
  AUTH_TOO_MANY_ATTEMPTS: 'AUTH_TOO_MANY_ATTEMPTS',
  AUTH_INVALID_PASSWORD: 'AUTH_INVALID_PASSWORD',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_JSON: 'MALFORMED_JSON',
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  BAD_REQUEST: 'BAD_REQUEST',
  CONFLICT: 'CONFLICT',
  ROLES_NOT_FOUND: 'ROLES_NOT_FOUND',
  NOTES_NOT_FOUND: 'NOTES_NOT_FOUND',
} as const;
