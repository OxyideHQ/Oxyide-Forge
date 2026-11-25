/**
 * AuthContext — the authenticated principal attached to a request after JWT
 * verification (`request.auth`).
 *
 * Ownership: a neutral cross-layer contract, not an auth-module implementation
 * detail. It is produced by the authentication plugin
 * (`src/plugins/auth.plugin.ts`), declared on Fastify requests through
 * `src/types/fastify.d.ts`, and consumed by authorization guards, policies,
 * and route handlers. It lives in `src/types` so infrastructure and domain
 * modules depend on the contract rather than on the auth module
 * (engineering standards §7.3; architecture §9).
 *
 * Content is fixed by ADR-001: exactly `sub`, `iat`, `exp`. It must not
 * include roles, permissions, scopes, session IDs, or token material.
 */
export interface AuthContext {
  sub: string;
  iat: number;
  exp: number;
}
