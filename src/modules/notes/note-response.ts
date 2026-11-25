import { PAGINATION_METADATA_JSON_SCHEMA } from '../../shared/pagination/pagination.js';
import type { Note } from './note.types.js';

/**
 * Canonical public Note response contract (M7.2 principles, M7.9).
 *
 * Single owner for the public Note representation: the notes module owns
 * the Note resource, so its wire shape lives here — not duplicated per
 * consumer. Timestamps are ISO 8601 UTC strings.
 *
 * The public contract NEVER carries internal fields: no `userId` (owner
 * linkage is the caller's own subject by policy and must not be
 * re-exposed), no credentials, no tokens. Two boundaries guard it:
 * the mapper allowlists fields in TypeScript, and the JSON Schema
 * constrains what the serializer emits.
 */
export type PublicNote = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

/** Normalizes a domain Note to the public API representation. */
export function toPublicNote(note: Note): PublicNote {
  return {
    id: note.id,
    title: note.title,
    description: note.description,
    status: note.status,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

/** JSON Schema for a public Note body (served via Fastify response:). */
export const PUBLIC_NOTE_JSON_SCHEMA = {
  type: 'object',
  required: ['id', 'title', 'description', 'status', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['active', 'archived'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

/** JSON Schema for a paginated list of public notes (M7.3 §10 envelope). */
export const noteListResponseSchema = {
  type: 'object',
  required: ['items', 'pagination'],
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: PUBLIC_NOTE_JSON_SCHEMA },
    pagination: PAGINATION_METADATA_JSON_SCHEMA,
  },
} as const;
