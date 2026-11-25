import { describe, expect, it } from 'vitest';

import { notePolicy } from './note.policy.js';

/**
 * notePolicy: owner-only. Deterministic, identity-to-identity — no
 * persistence, no HTTP, no invented access. Every "not allowed" case
 * must fail closed (never accidentally true).
 */
const ctx = (sub: unknown) => ({ sub, iat: 0, exp: 0 }) as never;

describe('notePolicy.canAccessNote', () => {
  it('grants the owner', async () => {
    expect(await notePolicy.canAccessNote(ctx('u1'), 'u1')).toBe(true);
  });

  it('denies a different user', async () => {
    expect(await notePolicy.canAccessNote(ctx('u1'), 'u2')).toBe(false);
  });

  it('never treats an undefined sub as self (fail closed)', async () => {
    expect(await notePolicy.canAccessNote(ctx(undefined), 'u1')).toBe(false);
    expect(await notePolicy.canAccessNote(ctx(''), '')).toBe(false);
  });

  it('denies an unset owner', async () => {
    expect(await notePolicy.canAccessNote(ctx('u1'), '')).toBe(false);
    expect(await notePolicy.canAccessNote(ctx('u1'), undefined as unknown as string)).toBe(false);
  });

  it('denies non-string identities without throwing', async () => {
    expect(await notePolicy.canAccessNote(ctx(42), 'u1')).toBe(false);
    expect(await notePolicy.canAccessNote(ctx('u1'), null as unknown as string)).toBe(false);
  });
});
