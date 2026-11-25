import type { Prisma } from '@prisma/client';

import { prisma } from '../../platform/database/prisma.js';
import type { Note, CreateNoteInput, UpdateNoteInput } from './note.types.js';
import type { NormalizedPagination } from '../../shared/pagination/pagination.js';
import type { NormalizedSort } from '../../shared/sorting/sorting.js';
import { sortOrderEntries } from '../../shared/sorting/sorting.js';
import type { FilterCriterion, NormalizedFilter } from '../../shared/filtering/filtering.js';

/**
 * Note repository — the ONLY layer that touches Prisma for Note.
 *
 * Ownership is server-bound here: every query is constrained by the
 * authenticated owner's id, supplied as an explicit argument. Client
 * input can refine results (via pagination/sort/filter intents) but can
 * never widen past the owner predicate. Repositories never open
 * business transactions (M1/M2); the listing read is two flat queries
 * (data + count) that are consistent because both share one `where`.
 *
 * Selected columns are explicit (`noteSelect`), never a model spread,
 * so an accidental internal field can never widen the public contract.
 */
const noteSelect = {
  id: true,
  userId: true,
  title: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDomain(row: {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): Note {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Translates one validated filter criterion into a Prisma condition.
 * Semantic intent (`NormalizedFilter`) is mapped to persistence syntax
 * ONLY here — the shared primitive never emits Prisma, and the route/
 * service layers never see a raw `where`.
 */
function criterionToWhere(criterion: FilterCriterion): Prisma.NoteWhereInput {
  const { column, operator, value } = criterion;
  switch (operator) {
    case 'eq':
      return { [column]: value } as Prisma.NoteWhereInput;
    case 'ne':
      return { [column]: { not: value } } as Prisma.NoteWhereInput;
    case 'in':
      return { [column]: { in: value } } as Prisma.NoteWhereInput;
    case 'contains':
      return { [column]: { contains: String(value) } } as Prisma.NoteWhereInput;
    case 'gt':
      return { [column]: { gt: new Date(String(value)) } } as Prisma.NoteWhereInput;
    case 'gte':
      return { [column]: { gte: new Date(String(value)) } } as Prisma.NoteWhereInput;
    case 'lt':
      return { [column]: { lt: new Date(String(value)) } } as Prisma.NoteWhereInput;
    case 'lte':
      return { [column]: { lte: new Date(String(value)) } } as Prisma.NoteWhereInput;
  }
}

function buildWhere(
  ownerId: string,
  filter: NormalizedFilter,
): Prisma.NoteWhereInput {
  const conditions: Prisma.NoteWhereInput[] = [{ userId: ownerId }];
  for (const criterion of filter.criteria) {
    conditions.push(criterionToWhere(criterion));
  }
  return { AND: conditions };
}

/**
 * Deterministic order: the client's allowlisted entries, terminated by
 * the server-owned tie-breaker so identical primary keys never produce
 * unstable page boundaries. Columns come from the endpoint-owned sort
 * config's column mapping, never directly from the client.
 */
function buildOrderBy(sort: NormalizedSort): Prisma.NoteOrderByWithRelationInput[] {
  return sortOrderEntries(sort).map(
    (entry) => ({ [entry.column]: entry.direction }) as Prisma.NoteOrderByWithRelationInput,
  );
}

export async function findById(id: string): Promise<Note | null> {
  const row = await prisma.note.findUnique({ where: { id }, select: noteSelect });
  return row ? toDomain(row) : null;
}

export async function list(
  ownerId: string,
  pagination: NormalizedPagination,
  sort: NormalizedSort,
  filter: NormalizedFilter,
): Promise<{ items: Note[]; total: number }> {
  const where = buildWhere(ownerId, filter);
  const [items, total] = await Promise.all([
    prisma.note.findMany({
      where,
      orderBy: buildOrderBy(sort),
      skip: pagination.offset,
      take: pagination.limit,
      select: noteSelect,
    }),
    prisma.note.count({ where }),
  ]);
  return { items: items.map(toDomain), total };
}

export async function create(input: CreateNoteInput & { id: string; userId: string }): Promise<Note> {
  const row = await prisma.note.create({
    data: {
      id: input.id,
      userId: input.userId,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? 'active',
    },
    select: noteSelect,
  });
  return toDomain(row);
}

export async function update(
  ownerId: string,
  id: string,
  input: UpdateNoteInput,
): Promise<Note | null> {
  // Exist-and-owner check first: a foreign note must never be mutated and
  // must surface as "not found" rather than a spurious update.
  const existing = await prisma.note.findFirst({
    where: { id, userId: ownerId },
    select: noteSelect,
  });
  if (!existing) {
    return null;
  }
  const data: Prisma.NoteUpdateInput = {};
  if (input.title !== undefined) {
    data.title = input.title;
  }
  if (input.description !== undefined) {
    data.description = input.description;
  }
  if (input.status !== undefined) {
    data.status = input.status;
  }
  const row = await prisma.note.update({ where: { id }, data, select: noteSelect });
  return toDomain(row);
}

export async function remove(ownerId: string, id: string): Promise<boolean> {
  const existing = await prisma.note.findFirst({ where: { id, userId: ownerId }, select: { id: true } });
  if (!existing) {
    return false;
  }
  await prisma.note.delete({ where: { id } });
  return true;
}

export const notesRepository = {
  findById,
  list,
  create,
  update,
  remove,
};
