# ADR 002: Authorization Foundation

> **Status:** Accepted
> **Date:** 2026-09-19
> **Deciders:** Architecture team
> **Supersedes:** N/A

## Context

Oxyide Forge has completed authentication (milestone 5.6) and Redis infrastructure (milestone 5.7). Authentication provides an `AuthContext` with `sub`, `iat`, and `exp` claims, but no authorization mechanism exists. The engineering standards (§19) describe authorization patterns (`requireAuth`, `requirePermission(...)`, deny-by-default) but no implementation exists.

The architecture (§13) previously marked authorization as FUTURE. This ADR promotes the authorization foundation to the current milestone.

## Decision

Implement an authorization foundation with:

1. **Permission constants** — domain-scoped strings following `<domain>:<action>` format.
2. **Role definitions** — two built-in roles (`user`, `admin`) with a static role→permission mapping.
3. **Authorization service** — evaluates whether an authenticated user has a required permission or role by looking up the user's role from the database.
4. **Guards** — Fastify preHandler functions (`requireAuth`, `requirePermission(...)`, `requireRole(...)`) that enforce authorization at the route level.
5. **Policies** — deterministic, independently testable functions that evaluate authorization decisions per domain.
6. **Database change** — add `role` field (String, default `'user'`) to the User model.

### What we chose NOT to do

- **Multiple roles per user** (UserRoles join table) — deferred. A single role per user is sufficient for the starter. Applications needing multi-role can extend.
- **Role administration CRUD API** — deferred. The roles module directory exists but remains unimplemented.
- **Permission caching in Redis** — deferred. Authorization decisions are cheap DB lookups; caching adds complexity without evidence of need.
- **Audit logging of authorization decisions** — deferred. Will be added when the logging architecture matures.
- **Dynamic role configuration** — the role→permission mapping is static. Applications can extend `ROLE_PERMISSIONS` or replace it with a database-backed service.

## Consequences

### Positive

- Routes can declare authorization requirements via composable preHandler guards.
- The permission model is explicit, testable, and extensible.
- Self-scoping (users can access their own resources) is built into the policy layer.
- The foundation integrates cleanly with the existing `AuthContext` and authentication flow.

### Negative

- A database migration is required (adding `role` column to User table).
- The static role→permission mapping requires code changes to add new roles.
- Every authorization check requires a database lookup for the user's role.

## Alternatives considered

1. **JWT-embedded roles** — embed roles/permissions in the JWT claim. Rejected because roles can change between token issuance and expiry, and server-side re-check is required for sensitive actions (§19.3).
2. **No authorization foundation** — keep authorization as FUTURE indefinitely. Rejected because the engineering standards already describe the pattern, and the starter should provide a working baseline.
3. **Full RBAC with UserRoles table** — more flexible but more complex. Rejected for the foundation milestone; can be added as an extension.
