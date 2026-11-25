import { describe, expect, it } from 'vitest';

import { AppError } from '../../../shared/errors/app-error.js';
import { ErrorCodes } from '../../../shared/errors/error-codes.js';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';

const { config } = await import('../../../config/index.js');
const { hashPassword, validatePasswordForSetting, verifyPassword } = await import(
  './password.service.js'
);

function invalidPasswordError(error: unknown): AppError {
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(ErrorCodes.AUTH_INVALID_PASSWORD);
  expect((error as AppError).statusCode).toBe(400);
  return error as AppError;
}

describe('passwordService', () => {
  describe('hashPassword', () => {
    it('produces a hash from a plaintext password', async () => {
      const hash = await hashPassword('correct-horse-battery-staple');

      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
    });

    it('produces a hash that is not equal to the plaintext password', async () => {
      const plaintext = 'correct-horse-battery-staple';
      const hash = await hashPassword(plaintext);

      expect(hash).not.toBe(plaintext);
    });

    it('produces a different hash each time due to bcrypt salting', async () => {
      const plaintext = 'correct-horse-battery-staple';
      const hashOne = await hashPassword(plaintext);
      const hashTwo = await hashPassword(plaintext);

      expect(hashOne).not.toBe(hashTwo);
    });
  });

  describe('verifyPassword', () => {
    it('returns true when verifying the correct plaintext against its hash', async () => {
      const plaintext = 'correct-horse-battery-staple';
      const hash = await hashPassword(plaintext);

      const isMatch = await verifyPassword(plaintext, hash);

      expect(isMatch).toBe(true);
    });

    it('returns false when verifying an incorrect plaintext against a hash', async () => {
      const plaintext = 'correct-horse-battery-staple';
      const hash = await hashPassword(plaintext);

      const isMatch = await verifyPassword('wrong-password', hash);

      expect(isMatch).toBe(false);
    });

    it('uses the configured bcrypt cost factor', async () => {
      const hash = await hashPassword('correct-horse-battery-staple');

      expect(config.auth.bcryptCostFactor).toBe(12);
      expect(hash.startsWith('$2b$12$')).toBe(true);
    });
  });

  describe('validatePasswordForSetting (M5.5 canonical policy)', () => {
    it('P01 accepts a valid minimum password (12 characters)', () => {
      expect(() => validatePasswordForSetting('a'.repeat(12))).not.toThrow();
    });

    it('P02 rejects below-minimum passwords', () => {
      try {
        validatePasswordForSetting('a'.repeat(11));
        expect.unreachable();
      } catch (error: unknown) {
        const appError = invalidPasswordError(error);
        expect(appError.message).toContain('12');
        expect(appError.message).not.toContain('a'.repeat(11));
      }
    });

    it('P03 accepts the valid maximum (72 ASCII characters = 72 bytes)', () => {
      expect(() => validatePasswordForSetting('b'.repeat(72))).not.toThrow();
    });

    it('P04 rejects one byte over the maximum (73 ASCII characters)', () => {
      try {
        validatePasswordForSetting('b'.repeat(73));
        expect.unreachable();
      } catch (error: unknown) {
        const appError = invalidPasswordError(error);
        expect(appError.message).toContain('72');
      }
    });

    it('P05 accepts multibyte input exactly at the byte boundary (36×é = 72 bytes)', () => {
      const password = 'é'.repeat(36);
      expect(Buffer.byteLength(password, 'utf8')).toBe(72);
      expect(() => validatePasswordForSetting(password)).not.toThrow();
    });

    it('P06 rejects multibyte input one byte over (37×é = 74 bytes) despite fitting maxLength:72 chars', () => {
      // The route-schema maxLength counts CHARACTERS (37 ≤ 72 passes), but
      // bcrypt counts BYTES — this is the truncation-collision class M5.5 closes.
      const password = 'é'.repeat(37);
      expect(password.length).toBe(37);
      expect(Buffer.byteLength(password, 'utf8')).toBe(74);
      try {
        validatePasswordForSetting(password);
        expect.unreachable();
      } catch (error: unknown) {
        invalidPasswordError(error);
      }
    });

    it('P07 accepts mixed ASCII/Unicode within bounds', () => {
      expect(() => validatePasswordForSetting('correct-horse-batterié-staple')).not.toThrow();
    });

    it('P08 accepts emoji (4-byte characters) within bounds', () => {
      const password = '🔐'.repeat(12);
      expect(Buffer.byteLength(password, 'utf8')).toBe(48);
      expect(() => validatePasswordForSetting(password)).not.toThrow();
    });

    it('P09/P10/P11 preserves leading, trailing, and internal whitespace (accepted, byte-counted)', () => {
      expect(() => validatePasswordForSetting('  spaced out  ')).not.toThrow();
      expect(() => validatePasswordForSetting('\ttab\tseparated\t')).not.toThrow();
    });

    it('P12 rejects empty passwords', () => {
      try {
        validatePasswordForSetting('');
        expect.unreachable();
      } catch (error: unknown) {
        invalidPasswordError(error);
      }
    });

    it('P13 rejects extremely large input without hashing it', () => {
      try {
        validatePasswordForSetting('z'.repeat(1024 * 1024));
        expect.unreachable();
      } catch (error: unknown) {
        invalidPasswordError(error);
      }
    });

    it('P14 accepts control characters and null bytes (preserved exactly, never stripped)', () => {
      expect(() => validatePasswordForSetting('pass\x00word-extra')).not.toThrow();
      expect(() => validatePasswordForSetting('line1\nline2\tend!')).not.toThrow();
    });

    it('P15 validation is deterministic across repetitions', () => {
      for (let i = 0; i < 5; i += 1) {
        expect(() => validatePasswordForSetting('deterministic-pass')).not.toThrow();
      }
      for (let i = 0; i < 5; i += 1) {
        expect(() => validatePasswordForSetting('short')).toThrow(AppError);
      }
    });

    it('rejects non-string inputs without coercion', () => {
      for (const bad of [undefined, null, 12345, {}, ['array-password']]) {
        try {
          validatePasswordForSetting(bad);
          expect.unreachable();
        } catch (error: unknown) {
          invalidPasswordError(error);
        }
      }
    });
  });
});
