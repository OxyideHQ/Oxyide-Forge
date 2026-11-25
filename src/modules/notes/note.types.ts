/**
 * Note domain model (M7.9).
 *
 * Notes are the canonical application example for Oxyide Forge: a small,
 * user-owned resource with a status enum and `createdAt`. Its whole
 * purpose is to teach the reference architecture end to end —
 * routes → policy → service → repository → PostgreSQL — without any
 * special-casing.
 *
 * The domain carries the internal owner id (`userId`) because ownership
 * must be evaluated server-side from the authenticated principal; the
 * PUBLIC contract (`note-response.ts`) strips it. `userId` is never
 * accepted from a client.
 */
export type Note = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Fields a client is allowed to mutate through create/update. */
export type CreateNoteInput = {
  title: string;
  description?: string | null;
  status?: string;
};

export type UpdateNoteInput = {
  title?: string;
  description?: string | null;
  status?: string;
};
