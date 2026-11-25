import type { FastifyInstance, FastifySchema } from 'fastify';

import { notesService } from '../notes.service.js';
import {
  PUBLIC_NOTE_JSON_SCHEMA,
  noteListResponseSchema,
} from '../note-response.js';
import { paginationQueryProperties } from '../../../shared/pagination/pagination.js';
import { sortQueryProperties } from '../../../shared/sorting/sorting.js';
import { filterPatternProperties } from '../../../shared/filtering/filtering.js';
import { requireAuth } from '../../authorization/guards/require-auth.js';
import type { AuthContext } from '../../../types/auth-context.js';

const noteIdParamsSchema: FastifySchema = {
  params: {
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
    },
  },
};

/**
 * Query contract for the list endpoint (M7.8-attached paginated listing).
 * Pagination and sorting compose by property spread; filtering composes
 * by pattern spread — exactly one reusable fragment per primitive, and the
 * endpoint still validates any non-primitive key as unknown.
 */
const listQuerySchema: FastifySchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...paginationQueryProperties,
      ...sortQueryProperties,
    },
    patternProperties: filterPatternProperties,
  },
};

const createNoteSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: ['string', 'null'], maxLength: 2000 },
      status: { type: 'string', enum: ['active', 'archived'] },
    },
  },
  response: {
    201: { ...PUBLIC_NOTE_JSON_SCHEMA, description: 'Created note (public representation).' },
  },
};

const updateNoteSchema: FastifySchema = {
  ...noteIdParamsSchema,
  body: {
    type: 'object',
    required: [],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: ['string', 'null'], maxLength: 2000 },
      status: { type: 'string', enum: ['active', 'archived'] },
    },
  },
  response: {
    200: { ...PUBLIC_NOTE_JSON_SCHEMA, description: 'Public note representation.' },
  },
};

/**
 * Registers note routes under /api/v1/notes.
 *
 * Routes:
 *   GET    /api/v1/notes          — List the authenticated user's notes
 *   POST   /api/v1/notes          — Create a note
 *   GET    /api/v1/notes/:id      — Read a note by ID
 *   PUT    /api/v1/notes/:id      — Update a note by ID
 *   DELETE /api/v1/notes/:id      — Delete a note by ID
 *
 * Every route: requireAuth; no client-supplied owner; response schema
 * declared at the route. List is the sole pagination/sorting/filtering
 * consumer (M7.9). BOLA: ownership is enforced server-side via
 * notePolicy; cross-user access is a 403, a missing note a 404.
 */
export async function registerNoteRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/notes
  app.get(
    '/api/v1/notes',
    {
      schema: {
        ...listQuerySchema,
        response: {
          200: { ...noteListResponseSchema, description: "Paginated list of the caller's own notes." },
        },
        tags: ['Notes'],
        summary: 'List notes',
        description:
          'Returns the authenticated user’s notes with offset pagination, allowlisted sorting, and allowlisted filtering. Ownership is always applied server-side from the caller; a client can only refine their own results.',
        operationId: 'listNotes',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const authContext = request.auth as AuthContext;
      const result = await notesService.list(authContext, request.query);
      return reply.status(200).send(result);
    },
  );

  // POST /api/v1/notes
  app.post(
    '/api/v1/notes',
    {
      schema: {
        ...createNoteSchema,
        tags: ['Notes'],
        summary: 'Create a note',
        description:
          'Creates a note owned by the authenticated user. The owner is derived from the subject, never from the request. Returns 201 with the public note and a Location header.',
        operationId: 'createNote',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const authContext = request.auth as AuthContext;
      const body = request.body as { title: string; description?: string | null; status?: string };
      const created = await notesService.create(authContext, body);
      return reply.status(201).header('Location', `/api/v1/notes/${created.id}`).send(created);
    },
  );

  // GET /api/v1/notes/:id
  app.get(
    '/api/v1/notes/:id',
    {
      schema: {
        ...noteIdParamsSchema,
        response: { 200: { ...PUBLIC_NOTE_JSON_SCHEMA, description: 'Public note representation.' } },
        tags: ['Notes'],
        summary: 'Read a note by ID',
        description: 'Returns the note for the authenticated owner. Cross-user access is 403; missing is 404.',
        operationId: 'getNoteById',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const authContext = request.auth as AuthContext;
      const note = await notesService.getById(authContext, id);
      return reply.status(200).send(note);
    },
  );

  // PUT /api/v1/notes/:id
  app.put(
    '/api/v1/notes/:id',
    {
      schema: {
        ...updateNoteSchema,
        tags: ['Notes'],
        summary: 'Update a note by ID',
        description: 'Partially updates a note owned by the caller. Cross-user access is 403; missing is 404.',
        operationId: 'updateNote',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { title?: string; description?: string | null; status?: string };
      const authContext = request.auth as AuthContext;
      const updated = await notesService.update(authContext, id, body);
      return reply.status(200).send(updated);
    },
  );

  // DELETE /api/v1/notes/:id
  app.delete(
    '/api/v1/notes/:id',
    {
      schema: {
        ...noteIdParamsSchema,
        tags: ['Notes'],
        summary: 'Delete a note by ID',
        description: 'Deletes a note owned by the caller (204, empty body). Cross-user access is 403; missing is 404.',
        operationId: 'deleteNote',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const authContext = request.auth as AuthContext;
      await notesService.remove(authContext, id);
      return reply.status(204).send();
    },
  );
}
