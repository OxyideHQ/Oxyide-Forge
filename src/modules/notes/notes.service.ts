import { randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors/app-error.js';
import { ErrorCodes } from '../../shared/errors/error-codes.js';
import {
  parsePagination,
  buildPaginatedResponse,
  type PaginatedResponse,
} from '../../shared/pagination/pagination.js';
import { defineSortConfig, parseSort, type NormalizedSort } from '../../shared/sorting/sorting.js';
import { defineFilterConfig, parseFilter, type NormalizedFilter } from '../../shared/filtering/filtering.js';
import type { AuthContext } from '../../types/auth-context.js';
import { notePolicy } from '../authorization/policies/note.policy.js';
import { notesRepository } from './note.repository.js';
import type { CreateNoteInput, UpdateNoteInput } from './note.types.js';
import { toPublicNote, type PublicNote } from './note-response.js';

/** Endpoint-owned sort vocabulary. Client names map to column names
 * explicitly: no arbitrary field, relation path, or Prisma syntax can
 * reach the orderBy. `createdAt` is the stable default, `id` is the
 * mandatory deterministic tie-breaker (uuid strings; total order only).
 * `defineSortConfig` validates definition-time shape and fails loudly
 * rather than producing a nondeterministic list. */
export const noteSortConfig = defineSortConfig({
  fields: { title: 'title', status: 'status', createdAt: 'createdAt' },
  defaultField: 'createdAt',
  defaultDirection: 'desc',
  tieBreaker: { column: 'id', direction: 'asc' },
});

/** Endpoint-owned filter vocabulary. Sensitive/owner fields are simply
 * never listed: ownership (`userId`) is always server-applied, so it can
 * never be injected or widened by a client filter. */
export const noteFilterConfig = defineFilterConfig({
  fields: {
    status: { type: 'enum', column: 'status', values: ['active', 'archived'] },
    title: { type: 'string', column: 'title' },
    createdAt: { type: 'datetime', column: 'createdAt' },
  },
});

function noteNotFound(): AppError {
  return new AppError(ErrorCodes.NOTES_NOT_FOUND, 404, 'Note not found.');
}

function forbidden(): AppError {
  return new AppError(
    ErrorCodes.AUTH_FORBIDDEN,
    403,
    'You do not have permission to access this resource.',
    { title: 'Forbidden' },
  );
}

export async function list(
  actor: AuthContext,
  query: unknown,
): Promise<PaginatedResponse<PublicNote>> {
  const pagination = parsePagination(query);
  const sort: NormalizedSort = parseSort(query, noteSortConfig);
  const filter: NormalizedFilter = parseFilter(query, noteFilterConfig);

  // Ownership is enforced server-side: the repository always scopes by
  // the authenticated owner's id. Client filters refine the owner's own
  // records; they can never select another user's.
  const { items, total } = await notesRepository.list(actor.sub, pagination, sort, filter);
  return buildPaginatedResponse(items.map(toPublicNote), {
    page: pagination.page,
    limit: pagination.limit,
    total,
  });
}

export async function getById(actor: AuthContext, id: string): Promise<PublicNote> {
  const note = await notesRepository.findById(id);
  if (!note) {
    throw noteNotFound();
  }
  if (!(await notePolicy.canAccessNote(actor, note.userId))) {
    throw forbidden();
  }
  return toPublicNote(note);
}

export async function create(actor: AuthContext, input: CreateNoteInput): Promise<PublicNote> {
  const note = await notesRepository.create({
    ...input,
    id: randomUUID(),
    userId: actor.sub,
  });
  return toPublicNote(note);
}

export async function update(
  actor: AuthContext,
  id: string,
  input: UpdateNoteInput,
): Promise<PublicNote> {
  const note = await notesRepository.findById(id);
  if (!note) {
    throw noteNotFound();
  }
  if (!(await notePolicy.canAccessNote(actor, note.userId))) {
    throw forbidden();
  }
  const updated = await notesRepository.update(actor.sub, id, input);
  if (!updated) {
    throw noteNotFound();
  }
  return toPublicNote(updated);
}

export async function remove(actor: AuthContext, id: string): Promise<void> {
  const note = await notesRepository.findById(id);
  if (!note) {
    throw noteNotFound();
  }
  if (!(await notePolicy.canAccessNote(actor, note.userId))) {
    throw forbidden();
  }
  const deleted = await notesRepository.remove(actor.sub, id);
  if (!deleted) {
    throw noteNotFound();
  }
}

export const notesService = {
  list,
  getById,
  create,
  update,
  remove,
};
