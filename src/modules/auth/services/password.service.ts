import bcrypt from 'bcrypt';

import { config } from '../../../config/index.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';

/**
 * Canonical password policy enforcement (M5.5).
 *
 * The single choke point for every password-SETTING flow (registration,
 * password reset; login intentionally excluded — see below). Route
 * schemas remain the outer gate (fast character-level 400s); this
 * validator is authoritative for the security property schemas cannot
 * express: the UTF-8 BYTE length.
 *
 * Contract (exact UTF-8 input, no transformation):
 * - must be a string (non-strings rejected, never coerced);
 * - at least `minLength` CHARACTERS (guessing resistance with bcrypt-12);
 * - at most `maxBytes` UTF-8 BYTES — the bcrypt input boundary. bcrypt
 *   silently truncates past 72 bytes, so accepting longer input would let
 *   two distinct passwords verify identically (prefix collision). Rejected
 *   input never reaches bcrypt: no hash is computed, no timing signal
 *   beyond the fast reject;
 * - everything else is preserved exactly: leading/trailing/internal
 *   whitespace, control characters, null bytes, and the full Unicode
 *   range. No trimming, no normalization, no case folding — on ANY path.
 *   Normalizing on one path but not another would fork the password
 *   contract and lock users out (or in).
 *
 * Login is deliberately NOT validated here: authentication must verify
 * whatever was originally accepted (including pre-existing longer
 * passwords) through the identical bcrypt path, so wrong passwords —
 * long, short, or otherwise — always cost exactly one bcrypt and fail
 * identically. Any login-side policy difference would be an oracle.
 *
 * Rejection uses 400 AUTH_INVALID_PASSWORD with a value-free detail
 * (names the bound, never the password).
 */
export function validatePasswordForSetting(password: unknown): void {
  if (typeof password !== 'string') {
    throw new AppError(
      ErrorCodes.AUTH_INVALID_PASSWORD,
      400,
      'Password must be a string.',
    );
  }

  if (password.length < config.auth.passwordPolicy.minLength) {
    throw new AppError(
      ErrorCodes.AUTH_INVALID_PASSWORD,
      400,
      `Password must be at least ${config.auth.passwordPolicy.minLength} characters.`,
    );
  }

  if (Buffer.byteLength(password, 'utf8') > config.auth.passwordPolicy.maxBytes) {
    throw new AppError(
      ErrorCodes.AUTH_INVALID_PASSWORD,
      400,
      `Password must be at most ${config.auth.passwordPolicy.maxBytes} bytes.`,
    );
  }
}

/**
 * Hashes a plaintext password using bcrypt with the configured cost factor.
 * The plaintext password is not retained or returned after hashing.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, config.auth.bcryptCostFactor);
}

/**
 * Verifies a plaintext password against a stored bcrypt hash.
 * Returns true if the password matches; false otherwise.
 */
export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

export const passwordService = {
  validatePasswordForSetting,
  hashPassword,
  verifyPassword,
};
