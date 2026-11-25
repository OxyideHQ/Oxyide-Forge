import type { User } from './user.types.js';

/**
 * Canonical public User response contract (M7.2).
 *
 * Single owner for the public User representation: the users module owns
 * the User resource, so its wire shape lives here — not duplicated per
 * consumer. `auth.service` and `user.routes` both map through this
 * module (auth→users imports are the established direction).
 *
 * Pipeline position:
 *
 *   Prisma model → repository (`userSelect` allowlist, `toDomain`)
 *     → service/domain `User` (may carry internal-only fields)
 *     → `toPublicUser` (explicit allowlist — the DTO boundary)
 *     → `PUBLIC_USER_JSON_SCHEMA` (Fastify `response:` serialization)
 *     → HTTP response
 *
 * Two boundaries, not one: the mapper selects fields in TypeScript; the
 * JSON Schema constrains what the serializer emits (Fastify strips
 * undeclared properties). Either alone would be developer discipline;
 * together they are an explicit contract. Public API schemas never
 * reference Prisma-generated types.
 */

/**
 * Public User representation sent over HTTP.
 * Timestamps are ISO 8601 UTC strings.
 * Never carries password hashes, credentials, tokens, `emailVerifiedAt`,
 * `lockedUntil`, or any other internal/database-only field.
 */
export type PublicUser = {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  role: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Normalizes a domain User to the public API representation.
 * Converts Date objects to ISO 8601 UTC strings; drops every
 * non-public field by explicit allowlist (never a spread).
 */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/**
 * JSON Schema for a public User response body (M7.2).
 *
 * Referenced by Fastify `response:` configs. `additionalProperties:
 * false` at the resource level makes the serializer drop anything the
 * mapper did not select — including internal fields a future service
 * change might accidentally attach. Plain `type: 'string'` for `status`
 * and `role` (open server-side vocabularies — no false-precision enums).
 * `format: 'date-time'` documents the ISO contract for M7.6 OpenAPI;
 * runtime always satisfies it via `toISOString`.
 */
export const PUBLIC_USER_JSON_SCHEMA = {
  type: 'object',
  required: ['id', 'email', 'displayName', 'status', 'role', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    displayName: { type: ['string', 'null'] },
    status: { type: 'string' },
    role: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;
