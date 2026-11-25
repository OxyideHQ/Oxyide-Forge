/**
 * Observable shutdown phase (M9.4).
 *
 * Lives in `src/types/` because it is part of the application's public shape —
 * it appears on the Fastify instance type — and `src/types/` must stay a leaf
 * that imports nothing from `app`, `shared`, or `modules`. An earlier draft
 * declared it in `src/app/lifecycle.ts` and imported it into the type
 * augmentation, which ARCH-ENF-005 correctly rejected as
 * `src/types -> src/app`; the edge is inverted here instead of the rule being
 * relaxed.
 */
export interface ShutdownPhase {
  /**
   * True once shutdown has begun.
   *
   * Set by the `preClose` hook — the earliest point at which shutdown is true
   * and a request can still be answered. Readiness consults it to withdraw
   * traffic before the listener disappears (M91-F12).
   */
  draining: boolean;
}
