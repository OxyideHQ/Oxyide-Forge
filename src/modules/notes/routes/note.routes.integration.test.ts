import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/oxyide_test';
process.env.JWT_SECRET ??= 'test-jwt-secret-key-min-32-chars-long';
process.env.NODE_ENV ??= 'test';

/**
 * M7.9 — Notes integration: routes → policy → service → repository → PG.
 *
 * The notes module is the canonical example of the reference architecture,
 * so the test proves every layer boundary: authentication, authorization
 * (owner-only), strict request schemas, M6 Problem Details on failures,
 * the public response contract, pagination/sorting/filtering (M7.3–M7.5),
 * and the BOLA matrix.
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const { buildApp } = await import('../../../app/app.js');

let app: FastifyInstance;

async function cleanDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Note" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EmailVerificationToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "PasswordResetToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "RefreshToken" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Session" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "LoginThrottle" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Credential" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
}

beforeAll(async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run with NODE_ENV=production');
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    throw new Error('PostgreSQL unavailable at DATABASE_URL');
  }
  app = await buildApp({ loggerStream: { write: () => true } });
  await app.ready();
});

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
  await prisma.$disconnect();
});

type UserCtx = { id: string; email: string; token: string; auth: { authorization: string } };

async function registerUser(email: string): Promise<UserCtx> {
  const password = 'correct-horse-battery-staple';
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password },
  });
  if (reg.statusCode !== 201) {
    throw new Error(`register failed: ${reg.statusCode} ${reg.body}`);
  }
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  return {
    id: reg.json().id as string,
    email,
    token: login.json().accessToken as string,
    auth: { authorization: `Bearer ${login.json().accessToken as string}` },
  };
}

async function createNote(
  ctx: UserCtx,
  body: { title?: string; description?: string | null; status?: string },
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/notes',
    headers: ctx.auth,
    payload: body as Record<string, unknown>,
  });
}

describe('M7.9 notes: authentication and request validation', () => {
  it('401s every protected route without a token', async () => {
    for (const path of ['/api/v1/notes']) {
      expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/api/v1/notes', payload: { title: 'a' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notes/some-id' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/notes/some-id', payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/notes/some-id' })).statusCode).toBe(401);
  });

  it('401s with a malformed bearer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notes',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a missing required title on create', async () => {
    const ctx = await registerUser(`n-miss-${Date.now()}@example.com`);
    const response = await createNote(ctx, { status: 'active' });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects an unknown field on create (additionalProperties false)', async () => {
    const ctx = await registerUser(`n-unknown-${Date.now()}@example.com`);
    const response = await createNote(ctx, { title: 'a', userId: 'someone-else' } as never);
    expect(response.statusCode).toBe(400);
  });

  it('rejects an invalid status enum on create', async () => {
    const ctx = await registerUser(`n-enum-${Date.now()}@example.com`);
    const response = await createNote(ctx, { title: 'a', status: 'bogus' } as never);
    expect(response.statusCode).toBe(400);
  });

  it('rejects an over-long title', async () => {
    const ctx = await registerUser(`n-long-${Date.now()}@example.com`);
    const response = await createNote(ctx, { title: 'x'.repeat(201) });
    expect(response.statusCode).toBe(400);
  });
});

describe('M7.9 notes: CRUD + public response', () => {
  it('creates, reads, updates, deletes, and enforces the public contract', async () => {
    const ctx = await registerUser(`n-crud-${Date.now()}@example.com`);

    const created = await createNote(ctx, { title: 'milk run', description: 'buy oats', status: 'active' });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe(`/api/v1/notes/${created.json().id}`);
    const note = created.json();
    expect(Object.keys(note).sort()).toEqual(['createdAt', 'description', 'id', 'status', 'title', 'updatedAt']);
    expect(note).not.toHaveProperty('userId');

    const id = note.id;
    const read = await app.inject({ method: 'GET', url: `/api/v1/notes/${id}`, headers: ctx.auth });
    expect(read.statusCode).toBe(200);
    expect(Object.keys(read.json()).sort()).toEqual(Object.keys(note).sort());

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/notes/${id}`,
      headers: ctx.auth,
      payload: { title: 'milk run v2', status: 'archived' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().title).toBe('milk run v2');
    expect(updated.json().status).toBe('archived');

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/notes/${id}`, headers: ctx.auth });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.payload).toBe('');

    const gone = await app.inject({ method: 'GET', url: `/api/v1/notes/${id}`, headers: ctx.auth });
    expect(gone.statusCode).toBe(404);
  });

  it('returns 404 for a missing note and 404 on repeated delete', async () => {
    const ctx = await registerUser(`n-404-${Date.now()}@example.com`);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/notes/00000000-0000-0000-0000-000000000000', headers: ctx.auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/problem+json');

    const create = await createNote(ctx, { title: 'temp' });
    const id = create.json().id;
    await app.inject({ method: 'DELETE', url: `/api/v1/notes/${id}`, headers: ctx.auth });
    const redelete = await app.inject({ method: 'DELETE', url: `/api/v1/notes/${id}`, headers: ctx.auth });
    expect(redelete.statusCode).toBe(404);
  });
});

describe('M7.9 notes: BOLA / ownership matrix', () => {
  it('isolates and denies cross-user access across every operation', async () => {
    const A = await registerUser(`n-bola-a-${Date.now()}@example.com`);
    const B = await registerUser(`n-bola-b-${Date.now()}@example.com`);

    const aNote = (await createNote(A, { title: 'A secret' })).json();
    const bNote = (await createNote(B, { title: 'B secret' })).json();

    // A reads/updates/deletes only A's
    expect((await app.inject({ method: 'GET', url: `/api/v1/notes/${aNote.id}`, headers: A.auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/notes/${bNote.id}`, headers: A.auth })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/notes/${bNote.id}`, headers: A.auth, payload: { title: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/notes/${bNote.id}`, headers: A.auth })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/notes/${bNote.id}`, headers: B.auth })).statusCode).toBe(200);

    // List isolation: A sees only A's notes; B only B's
    const aList = (await app.inject({ method: 'GET', url: '/api/v1/notes', headers: A.auth })).json();
    const bList = (await app.inject({ method: 'GET', url: '/api/v1/notes', headers: B.auth })).json();
    expect(aList.items).toHaveLength(1);
    expect(bList.items).toHaveLength(1);
    expect(aList.items[0].title).toBe('A secret');
    expect(bList.items[0].title).toBe('B secret');
    // The public item carries no owner internals.
    expect(aList.items[0]).not.toHaveProperty('userId');
  });

  it('never lets a client select another user via userId parameter or query', async () => {
    const A = await registerUser(`n-nohoist-a-${Date.now()}@example.com`);
    await registerUser(`n-nohoist-b-${Date.now()}@example.com`);
    const aNote = (await createNote(A, { title: 'A' })).json();
    void aNote;

    // A forged ownerId in the body is rejected at create
    const forged = await app.inject({ method: 'POST', url: '/api/v1/notes', headers: A.auth, payload: { title: 't', userId: 'someone' } });
    expect(forged.statusCode).toBe(400);

    // ?userId= and filter[userId]= must never widen access
    const withUserId = await app.inject({ method: 'GET', url: '/api/v1/notes?userId=someone', headers: A.auth });
    expect(withUserId.statusCode).toBe(400);
    const filterUserId = await app.inject({ method: 'GET', url: '/api/v1/notes?filter[userId]=someone', headers: A.auth });
    expect(filterUserId.statusCode).toBe(400);
    const filterOwner = await app.inject({ method: 'GET', url: '/api/v1/notes?filter[ownerId]=x', headers: A.auth });
    expect(filterOwner.statusCode).toBe(400);
  });

  it('hostile filter/sort keys cannot select credentials or relations', async () => {
    const A = await registerUser(`n-hostile-${Date.now()}@example.com`);
    for (const q of [
      'filter[passwordHash]=x',
      'filter[credential]=x',
      'filter[user.name]=x',
      'filter[__proto__]=x',
      'filter[title__gt]=1',
      'sort=user.name:asc',
      'sort=passwordHash:desc',
      'sort=user.id:asc',
      'sort=title:bogus',
    ]) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/notes?${q}`, headers: A.auth });
      expect(response.statusCode, q).toBe(400);
    }
    // A repeated sort column is rejected (M710 freeze: duplicates are never last-wins).
    const dup = await app.inject({ method: 'GET', url: '/api/v1/notes?sort=title,title:desc', headers: A.auth });
    expect(dup.statusCode).toBe(400);
  });
});

describe('M7.9 notes: pagination / sorting / filtering', () => {
  async function seed(ctx: UserCtx) {
    await createNote(ctx, { title: 'banana bread', status: 'active', description: 'fruit' });
    await createNote(ctx, { title: 'almond milk', status: 'archived', description: 'groceries' });
    await createNote(ctx, { title: 'cookbook', status: 'active', description: 'shelf' });
  }

  it('returns the paginated envelope with defaults and counts', async () => {
    const ctx = await registerUser(`n-page-${Date.now()}@example.com`);
    await seed(ctx);
    const response = await app.inject({ method: 'GET', url: '/api/v1/notes', headers: ctx.auth });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['items', 'pagination']);
    expect(body.pagination).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
    expect(body.items).toHaveLength(3);
  });

  it('honours explicit page/limit and rejects out-of-range values', async () => {
    const ctx = await registerUser(`n-pages-${Date.now()}@example.com`);
    await seed(ctx);
    const page1 = (await app.inject({ method: 'GET', url: '/api/v1/notes?limit=2&page=1', headers: ctx.auth })).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    const page2 = (await app.inject({ method: 'GET', url: '/api/v1/notes?limit=2&page=2', headers: ctx.auth })).json();
    expect(page2.items).toHaveLength(1);

    expect((await app.inject({ method: 'GET', url: '/api/v1/notes?limit=101', headers: ctx.auth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notes?limit=0', headers: ctx.auth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notes?page=0', headers: ctx.auth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notes?limit=abc', headers: ctx.auth })).statusCode).toBe(400);
  });

  it('sorts by allowlisted fields, validates direction, and rejects unknown/duplicates', async () => {
    const ctx = await registerUser(`n-sort-${Date.now()}@example.com`);
    await seed(ctx);

    const byTitle = (await app.inject({ method: 'GET', url: '/api/v1/notes?sort=title:asc', headers: ctx.auth })).json().items.map((i: { title: string }) => i.title);
    expect(byTitle).toEqual(['almond milk', 'banana bread', 'cookbook']);

    const byTitleDesc = (await app.inject({ method: 'GET', url: '/api/v1/notes?sort=title:desc', headers: ctx.auth })).json().items.map((i: { title: string }) => i.title);
    expect(byTitleDesc).toEqual(['cookbook', 'banana bread', 'almond milk']);

    expect((await app.inject({ method: 'GET', url: '/api/v1/notes?sort=title:bogus', headers: ctx.auth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notes?sort=unknownfield:asc', headers: ctx.auth })).statusCode).toBe(400);
    // Repeated columns are rejected (M710 freeze), never silently normalized.
    const dup = await app.inject({ method: 'GET', url: '/api/v1/notes?sort=title:asc,title:desc', headers: ctx.auth });
    expect(dup.statusCode).toBe(400);
  });

  it('filters by status, title-contains, and datetime; rejects unknown/bad operators', async () => {
    const ctx = await registerUser(`n-filter-${Date.now()}@example.com`);
    await seed(ctx);

    const actives = (await app.inject({ method: 'GET', url: '/api/v1/notes?filter[status]=active', headers: ctx.auth })).json();
    expect(actives.pagination.total).toBe(2);
    expect(actives.items.every((i: { status: string }) => i.status === 'active')).toBe(true);

    const contains = (await app.inject({ method: 'GET', url: '/api/v1/notes?filter[title_contains]=milk', headers: ctx.auth })).json();
    expect(contains.pagination.total).toBe(1);
    expect(contains.items[0].title).toBe('almond milk');

    const archivedIn = (await app.inject({ method: 'GET', url: '/api/v1/notes?filter[status_in]=archived', headers: ctx.auth })).json();
    expect(archivedIn.pagination.total).toBe(1);

    expect((await app.inject({ method: 'GET', url: '/api/v1/notes?filter[status_contains]=active', headers: ctx.auth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notes?filter[unknownfield]=x', headers: ctx.auth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notes?filter[status]=bogus', headers: ctx.auth })).statusCode).toBe(400);
  });

  it('applies a forged datetime comparison in UTC and returns the published schema', async () => {
    const ctx = await registerUser(`n-ts-${Date.now()}@example.com`);
    await createNote(ctx, { title: 'before now' });
    const future = encodeURIComponent('2100-01-01T00:00:00Z');
    const body = (await app.inject({ method: 'GET', url: `/api/v1/notes?filter[createdAt_gt]=${future}`, headers: ctx.auth })).json();
    expect(body.pagination.total).toBe(0);
    expect(body.items).toEqual([]);
  });
});
