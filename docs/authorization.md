# Authorization

> **Status:** Approved
> **Version:** 1.0
> **Audience:** Application developers, maintainers
> **Source of truth:** This document is the single source of truth for the OXYIDE authorization model.

Authorization determines what an authenticated user is allowed to do. It is a separate concern from authentication and sits between authentication and the application handler.

## Flow

```
HTTP Request
 ↓
Authentication (JWT verification → AuthContext)
 ↓
Authorization (role lookup → permission check)
 ↓
Application Handler
```

## Authorization Model

The Oxyide Forge uses a role-based access control (RBAC) model with two built-in roles:

| Role | Description |
|------|-------------|
| `user` | Default role assigned at registration. Self-scoped permissions only. |
| `admin` | Elevated role with full permission set across all domains. |

### Single-Role Decision

Each user holds exactly one server-assigned role (`User.role`, scalar string). Multiple roles per user were evaluated and deliberately not implemented: no product requirement (organizational, composite, scoped, or delegated roles) exists in the repository; the two-role matrix covers every protected route; and composition would add privilege-aggregation, revocation, migration, and audit complexity with no current consumer. Composite-looking values (`user,admin`, arrays, case/whitespace variants) fail closed as unknown roles. Revisit only if a concrete requirement arrives (e.g., organization-scoped or independently revocable memberships) — see the recorded decision below for the full rationale and trigger conditions.

### Permissions

Permissions follow the format `<domain>:<action>`. They are defined as constants in `src/modules/authorization/permissions/`.

| Domain | Permission | Description |
|--------|-----------|-------------|
| auth | `auth:login` | Log in |
| auth | `auth:logout` | Log out |
| users | `users:read` | Read any user's profile |
| users | `users:read:self` | Read own profile |
| users | `users:update` | Update any user's profile |
| users | `users:update:self` | Update own profile |
| users | `users:delete` | Delete any user |
| roles | `roles:read` | Read roles |
| roles | `roles:create` | Create roles |
| roles | `roles:update` | Update roles |
| roles | `roles:delete` | Delete roles |

### Role → Permission Mapping

The mapping from roles to permissions is defined in `src/modules/authorization/roles.ts` via `ROLE_PERMISSIONS`.

**`user` role:**
- `auth:login`, `auth:logout`
- `users:read:self`, `users:update:self`

**`admin` role (11 permissions):**
- `auth:login`, `auth:logout`
- `users:read`, `users:read:self`, `users:update`, `users:update:self`, `users:delete`
- `roles:read`, `roles:create`, `roles:update`, `roles:delete`

The mapping is frozen at runtime (`Object.freeze` on the map, the role constants, and every role array): ordinary application code cannot expand it without a code change, and any such attempt throws instead of silently widening access. Registration is public by design and gated by no permission; no `auth:register` permission exists.

## Guards

Guards are Fastify preHandler functions that enforce authorization at the route level.

### `requireAuth`

Verifies JWT authentication and attaches `AuthContext` to the request. Delegates to `app.authenticate`.

```ts
fastify.get('/me', { preHandler: [requireAuth] }, handler);
```

### `requirePermission(permission)`

Checks whether the authenticated user has a specific permission. Must be used after `requireAuth` or `app.authenticate`.

Returns 401 if unauthenticated. Returns 403 if the user lacks the permission.

```ts
fastify.delete('/users/:id', {
 preHandler: [requireAuth, requirePermission(UserPermissions.DELETE)],
}, handler);
```

### `requireRole(role)`

Checks whether the authenticated user has a specific role. Must be used after `requireAuth` or `app.authenticate`.

Returns 401 if unauthenticated. Returns 403 if the user lacks the role.

```ts
fastify.get('/admin/dashboard', {
 preHandler: [requireAuth, requireRole(Roles.ADMIN)],
}, handler);
```

## Policies

Policies are deterministic, independently testable functions that evaluate authorization decisions. They consume `AuthContext` and delegate to the authorization service.

Policies live in `src/modules/authorization/policies/`:

- `userPolicy` — user action policies (includes self-scope logic; the only policy group with production callers)

Policy input contract: `(AuthContext, targetUserId)` with `Promise<boolean>` output. Invalid (non-string, empty) actor or target identities deny without consulting the mapping, so malformed input can never read as self-access. Policies hold no HTTP, persistence, transaction, or JWT knowledge (machine-checked by ARCH-ENF-012).

## HTTP Behavior

| Scenario | Status Code | Code |
|----------|------------|------|
| Not authenticated | 401 | `AUTH_INVALID_TOKEN` |
| Authenticated but not authorized | 403 | `AUTH_FORBIDDEN` |
| Valid token but subject no longer exists | 401 | `AUTH_INVALID_TOKEN` |

Authentication means a valid token **for a currently existing subject** (`requireAuth` verifies existence per request): a deleted subject fails as authentication (401), coherently with `/me`. An existing subject lacking permission fails as authorization (403). Account status is not consulted by guards (suspension blocks login/refresh/recovery, not guard evaluation — owned by a later milestone).

## Security Rules

1. Authorization decisions derive from the server-side role lookup, never from client-supplied data.
2. The client cannot elevate privileges by sending `role`, `permissions`, or similar fields.
3. Self-scoped permissions (e.g., `users:read:self`) are checked by comparing `request.auth.sub` to the target resource owner.
4. Deny-by-default: routes are protected unless explicitly marked public.
5. Authorization failures are logged at `warn` level with actor, action, and resource.

## Security Logging

Authorization decisions emit structured Pino events through `request.log` (which carries the request ID):

| Event | Level | When |
|---|---|---|
| `authorization.decision` (`decision: deny`) | `warn` | Permission/role/ownership denial, self-delete refusal |
| `authorization.decision` (`decision: allow`) | `info` | Privileged cross-user read/update/delete via permission override |
| `authentication.subject_invalid` | `warn` | Valid token whose subject no longer exists |

Event fields are an explicit allowlist (`event`, `decision`, `reason`, `subjectId`, plus `permission`/`role`/`resource`/`targetId` where applicable) with server-controlled names and reasons. Ordinary allowed self-access, roles-descriptor reads, and expired/invalid-token rejections emit nothing. Never logged: tokens, passwords/hashes, cookies, headers, bodies, queries, URLs, emails, secrets, or database internals. Logging observes decisions and never alters them; policies hold no logger.
