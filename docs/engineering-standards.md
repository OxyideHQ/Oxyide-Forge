# Oxyide Forge — Engineering Standards

> **Status:** Mandatory
> **Version:** 2.0 (V1 Baseline)
> **Audience:** All contributors, maintainers, and AI coding agents
> **Scope:** All code in `src/` and `prisma/`
> **Relationship to architecture:** This document is subordinate to `docs/architecture.md`. If a rule conflicts with the frozen architecture, the architecture wins and this document must be updated.

These standards are mandatory. Deviations require a written justification in the PR description and, for architectural deviations, an ADR.

Each rule follows the same format: **RULE**, **WHY**, **GOOD**, **BAD**.

---

## V1 Baseline

This document defines the engineering standards for the Oxyide Forge V1 baseline. V1 is the completed and audited foundational platform. All future development must preserve the V1 contracts unless explicitly promoted through the change management process.

**V1 includes:**
- Fastify 5.x application foundation
- TypeScript 5.7+ with strict mode
- Prisma 6.x ORM with PostgreSQL
- Redis foundation (optional)
- JWT authentication (HS256, 15-minute TTL)
- RBAC authorization (user/admin roles, 11 permissions)
- Centralized configuration with Zod validation
- Automated testing with Vitest

**V1 does NOT include (deferred to V2):**
- Refresh tokens, CSRF protection, MFA
- Swagger/OpenAPI, distributed rate limiting
- Sentry, OpenTelemetry, advanced logging
- CI/CD pipelines, deployment automation

For the complete V1 scope, see [README.md](../README.md) and [docs/architecture.md](architecture.md).

---

## 1. TypeScript

### 1.1 Strict mode is mandatory

**RULE:** `strict: true` in `tsconfig.json`. Do not disable individual strict flags.

**WHY:** Non-strict TypeScript hides null/undefined bugs until runtime and defeats the purpose of using TypeScript.

**GOOD:**
```ts
function findUser(id: string): Promise<User | null> { /*... */ }
```

**BAD:**
```ts
// tsconfig: "strict": false
function findUser(id) { /*... */ }
```

### 1.2 No `any`

**RULE:** Never use `any` in committed code. Use `unknown` at boundaries and narrow explicitly.

**WHY:** `any` disables type checking and propagates silently across module boundaries.

**GOOD:**
```ts
function parsePayload(input: unknown): Payload {
 if (!isPayload(input)) throw new AppError(ErrorCodes.VALIDATION_FAILED);
 return input;
}
```

**BAD:**
```ts
function parsePayload(input: any): Payload { return input; }
```

### 1.3 No non-null assertion without justification

**RULE:** Do not use `!` to silence the compiler unless the invariant is documented and provable locally.

**WHY:** Non-null assertions convert type errors into runtime crashes.

**GOOD:**
```ts
const user = await usersRepo.findById(id);
if (!user) throw new AppError(ErrorCodes.USER_NOT_FOUND);
return user.email;
```

**BAD:**
```ts
const user = await usersRepo.findById(id);
return user!.email;
```

### 1.4 Prefer union types over enums

**RULE:** Use string literal unions or `as const` objects instead of TypeScript `enum`.

**WHY:** Enums compile to runtime objects, complicate tree-shaking, and interact poorly with JSON and Prisma.

**GOOD:**
```ts
export const UserStatus = { Active: 'active', Suspended: 'suspended' } as const;
export type UserStatus = typeof UserStatus[keyof typeof UserStatus];
```

**BAD:**
```ts
export enum UserStatus { Active, Suspended }
```

### 1.5 No implicit type casts at boundaries

**RULE:** `as` casts are allowed only when converting between structurally identical shapes (e.g., DTO → domain) and must be commented with the reason. Never cast `unknown` directly to a domain type.

**WHY:** Blind casts bypass validation and hide contract violations.

**GOOD:**
```ts
// Prisma row shape matches UserRow exactly; safe structural cast.
const row = record as UserRow;
```

**BAD:**
```ts
const user = response as User;
```

---

## 2. Naming Conventions

### 2.1 Identifiers use standard casing

**RULE:** `camelCase` for variables, functions, parameters, and object properties. `PascalCase` for types, interfaces, classes, and React-style components (if ever added). `SCREAMING_SNAKE_CASE` for module-level constants that are true constants.

**WHY:** Consistency reduces cognitive load and matches Node.js ecosystem conventions.

**GOOD:**
```ts
const DEFAULT_PAGE_SIZE = 20;
function findActiveUsers: Promise<User[]> { /*... */ }
type UserId = string;
```

**BAD:**
```ts
const defaultPageSize = 20;
function FindActiveUsers { /*... */ }
type user_id = string;
```

### 2.2 Booleans use predicate prefixes

**RULE:** Boolean names start with `is`, `has`, `can`, `should`, or `was`.

**WHY:** Booleans without prefixes read as nouns or verbs and cause confusion in conditions.

**GOOD:**
```ts
if (isExpired) { /*... */ }
const hasAccess = await authz.can(user, 'read', resource);
```

**BAD:**
```ts
if (expired) { /*... */ }
const access = await authz.can(user, 'read', resource);
```

### 2.3 No abbreviations in public names

**RULE:** Do not abbreviate names in exported functions, types, or module files. Short local names (`i`, `x`) are acceptable only in trivial loops.

**WHY:** Abbreviations are ambiguous and vary per developer (`usr`, `user`, `u`).

**GOOD:**
```ts
function getUserIdFromSession(sessionId: string): Promise<string> { /*... */ }
```

**BAD:**
```ts
function getUidFromSess(sid: string): Promise<string> { /*... */ }
```

### 2.4 Errors and error codes are specific

**RULE:** Error class names end in `Error`. Error codes are `SCREAMING_SNAKE_CASE` and namespaced by module (e.g., `AUTH_INVALID_CREDENTIALS`, `USERS_NOT_FOUND`).

**WHY:** Specific names enable programmatic handling and stable API contracts.

**GOOD:**
```ts
throw new AppError(ErrorCodes.AUTH_INVALID_CREDENTIALS);
```

**BAD:**
```ts
throw new AppError('bad login');
```

---

## 3. File Naming

### 3.1 Kebab-case for all files

**RULE:** File names are lowercase, hyphen-separated. No spaces, no PascalCase, no camelCase.

**WHY:** Avoids case-sensitivity issues across macOS, Linux, and Windows CI runners.

**GOOD:**
```text
auth.service.ts
rate-limit.plugin.ts
request-context.ts
```

**BAD:**
```text
AuthService.ts
rateLimitPlugin.ts
Request Context.ts
```

### 3.2 Role suffix is mandatory inside modules

**RULE:** Files inside a module use the suffixes: `.routes.ts`, `.service.ts`, `.schemas.ts`, `.types.ts`, `.repository.ts`, `.hooks.ts`, `.constants.ts`. Plugins use `.plugin.ts`.

**WHY:** File purpose is discoverable from the name alone. Tooling and generators rely on it.

**GOOD:**
```text
src/modules/auth/auth.service.ts
src/plugins/cors.plugin.ts
```

**BAD:**
```text
src/modules/auth/service.ts
src/plugins/cors.ts
```

### 3.3 One primary export per file

**RULE:** A file exports one primary symbol matching its filename. Additional named exports are allowed only for closely related helpers used by that primary symbol.

**WHY:** Keeps discovery and refactoring predictable and avoids god-files.

**GOOD:**
```ts
// auth.service.ts
export const authService = { login, logout, refresh };
```

**BAD:**
```ts
// auth.service.ts
export const authService = { /*... */ };
export const userService = { /*... */ };
export const roleService = { /*... */ };
```

---

## 4. Folder Organization

### 4.1 Domain code lives in `src/modules`

**RULE:** Anything domain-specific (auth, users, roles, health, future domains) lives under `src/modules/<name>/`.

**WHY:** Modules are the unit of ownership, testing, and review.

**GOOD:**
```text
src/modules/users/users.service.ts
```

**BAD:**
```text
src/services/user-service.ts
```

### 4.2 Cross-cutting code lives in `src/shared`, `src/plugins`, or `src/platform` infrastructure

**RULE:** `shared` holds primitives with no domain knowledge. `plugins` holds Fastify plugins. `src/platform/database` and `src/platform/cache` hold infrastructure clients and helpers.

**WHY:** Prevents domain logic from leaking into infrastructure and keeps the dependency graph acyclic.

**GOOD:**
```text
src/shared/http/response.ts
src/plugins/helmet.plugin.ts
src/platform/database/prisma.ts
```

**BAD:**
```text
src/shared/users/format-user.ts
src/plugins/auth-service.plugin.ts // domain logic in a plugin
```

### 4.3 No domain code in `shared`

**RULE:** `src/shared` must not import from `src/modules`. If a helper needs domain knowledge, it belongs in the module.

**WHY:** Reverses dependency direction and creates cycles.

**GOOD:**
```ts
// src/shared/http/response.ts
export function ok<T>(data: T): { data: T } { return { data }; }
```

**BAD:**
```ts
// src/shared/http/response.ts
import { authService } from '../../modules/auth/auth.service';
```

### 4.4 Health is infrastructure, not a domain module

**RULE:** Health endpoints must not depend on domain services. They report process and dependency status only.

**WHY:** Health checks must remain cheap and dependency-light so they do not become a bottleneck or a failure amplifier.

**GOOD:**
```text
src/modules/health/health.routes.ts // checks db + redis only
```

**BAD:**
```text
src/modules/health/health.service.ts // calls authService to "verify" things
```

---

## 5. Imports

### 5.1 No deep relative imports across modules

**RULE:** Cross-module imports must go through a path alias (e.g., `@/modules/...`) or a barrel contract, not `../../../`. Deep relative imports that traverse more than two levels upward are forbidden.

**WHY:** Deep relative paths are brittle, hard to read, and encourage coupling.

**GOOD:**
```ts
import { usersService } from '@/modules/users/users.service';
```

**BAD:**
```ts
import { usersService } from '../../../../modules/users/users.service';
```

### 5.2 Import order is deterministic

**RULE:** Group imports in this order, separated by blank lines: (1) Node built-ins, (2) external packages, (3) internal aliases (`@/...`), (4) relative imports. Within each group, alphabetical order.

**WHY:** Reduces diff noise and makes missing/extra imports visible during review.

**GOOD:**
```ts
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { AppError } from '@/shared/errors/app-error';
import { usersService } from '@/modules/users/users.service';

import { buildPayload } from './auth.helpers';
```

**BAD:**
```ts
import { usersService } from '@/modules/users/users.service';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildPayload } from './auth.helpers';
```

### 5.3 Type-only imports use `import type`

**RULE:** Use `import type` for symbols used only as types.

**WHY:** Avoids emitting unused runtime imports and clarifies intent.

**GOOD:**
```ts
import type { User } from '@/modules/users/users.types';
```

**BAD:**
```ts
import { User } from '@/modules/users/users.types';
```

### 5.4 No circular imports

**RULE:** Cycles are forbidden. If a cycle appears, extract shared primitives into `shared` or invert the dependency.

**WHY:** Circular imports cause undefined values at module evaluation time and are hard to debug.

**GOOD:**
```text
auth.service -> users.service (via contract) -> shared
```

**BAD:**
```text
auth.service -> users.service -> auth.service
```

---

## 6. Module Boundaries

### 6.1 A module owns its repository

**RULE:** Only the owning module may import its own `.repository.ts`. Other modules must call the owning module’s `.service.ts`.

**WHY:** Repositories are persistence details; services are the module’s public contract.

**GOOD:**
```ts
// roles.service.ts
import { usersService } from '@/modules/users/users.service';
```

**BAD:**
```ts
// roles.service.ts
import { usersRepository } from '@/modules/users/users.repository';
```

### 6.2 Services do not reach across into other modules’ Prisma models

**RULE:** A service must not use Prisma to query another module’s tables directly. It must go through that module’s service.

**WHY:** Table ownership is module ownership. Direct queries bypass validation, authorization, and audit.

**GOOD:**
```ts
const user = await usersService.getById(userId);
```

**BAD:**
```ts
const user = await prisma.user.findUnique({ where: { id: userId } });
```

### 6.3 Cross-module contracts are service objects

**RULE:** Modules expose a small service object with named methods. They do not expose repositories, Prisma types, or internal schemas.

**WHY:** Keeps APIs stable and prevents leaking implementation.

**GOOD:**
```ts
export const usersService = {
 getById,
 findByEmail,
 create,
};
```

**BAD:**
```ts
export { usersRepository, userSelect, userInclude };
```

### 6.4 Health and docs are not domain modules

**RULE:** `health` and `docs` must not import from domain modules.

**WHY:** Domain modules come and go; health and docs must remain stable.

**GOOD:**
```ts
// swagger.plugin.ts imports schemas from modules for registration only
```

**BAD:**
```ts
// health.service.ts calls authService to check "auth is up"
```

---

## 7. Dependency Direction

### 7.1 Layered dependency direction

**RULE:** Allowed direction is: `routes → hooks → services → repositories → db`. Plugins may depend on `common` and infrastructure. `common` must not depend on `modules`, `plugins`, or `db`.

**WHY:** Enforces testability and prevents cycles.

**GOOD:**
```text
routes -> hooks -> services -> repositories -> db -> prisma
```

**BAD:**
```text
repositories -> services (inverted)
common -> modules (inverted)
```

### 7.2 No module-to-module repository imports

**RULE:** Forbidden. Always use services.

**WHY:** Prevents cross-module persistence coupling.

**GOOD:**
```ts
const role = await rolesService.getById(roleId);
```

**BAD:**
```ts
const role = await rolesRepository.findById(roleId);
```

### 7.3 No imports from `modules` in `plugins`

**RULE:** Plugins are cross-cutting and must not depend on domain modules.

**WHY:** Plugins are loaded before modules and must not create a boot-time cycle.

**GOOD:**
```ts
// rate-limit.plugin.ts uses only config and common
```

**BAD:**
```ts
// rate-limit.plugin.ts imports authService to check user tier
```

---

## 8. Functions

### 8.1 Functions do one thing

**RULE:** A function should do one thing at one level of abstraction. If you need “and” to describe it, split it.

**WHY:** Small functions are easier to test, name, and reuse.

**GOOD:**
```ts
function normalizeEmail(email: string): string {
 return email.trim.toLowerCase;
}
```

**BAD:**
```ts
function processUser(input: any) {
 // validate, normalize, hash password, save, send email, log
}
```

### 8.2 No boolean flag parameters

**RULE:** Do not pass booleans to change function behavior. Use an options object or two functions.

**WHY:** Call sites become unreadable (`doThing(true, false)`).

**GOOD:**
```ts
function findUsers(opts: { includeSuspended: boolean }): Promise<User[]> { /*... */ }
```

**BAD:**
```ts
function findUsers(includeSuspended: boolean, sortDesc: boolean): Promise<User[]> { /*... */ }
```

### 8.3 Limit positional parameters

**RULE:** Maximum three positional parameters. Beyond that, use an options object.

**WHY:** Reduces call-site errors and makes intent explicit.

**GOOD:**
```ts
function createUser(input: { email: string; password: string; roleId: string }): Promise<User> { /*... */ }
```

**BAD:**
```ts
function createUser(email: string, password: string, roleId: string, active: boolean, tenantId: string): Promise<User> { /*... */ }
```

### 8.4 Explicit return types at module boundaries

**RULE:** Exported functions in services, repositories, and helpers must declare return types.

**WHY:** Prevents accidental type widening and documents the contract.

**GOOD:**
```ts
export async function login(input: LoginInput): Promise<LoginResult> { /*... */ }
```

**BAD:**
```ts
export async function login(input: LoginInput) { /*... */ }
```

---

## 9. Classes

### 9.1 Prefer functions and plain objects

**RULE:** Use plain functions or service objects. Classes are permitted only when there is genuine encapsulated state that must be created, closed, or pooled.

**WHY:** Classes add ceremony and inheritance temptation for stateless logic.

**GOOD:**
```ts
export const cacheService = { get, set, del };
```

**BAD:**
```ts
export class CacheServiceManagerFactory { /*... */ }
```

### 9.2 No class inheritance for reuse

**RULE:** Do not use `extends` for code reuse. Use composition.

**WHY:** Deep hierarchies are hard to change and test.

**GOOD:**
```ts
const logger = createLogger({ redact });
const audit = createAuditLog({ logger });
```

**BAD:**
```ts
class BaseService {}
class AuthService extends BaseService {}
class AdminAuthService extends AuthService {}
```

### 9.3 Classes must not be singletons via static state

**RULE:** No static mutable state on classes.

**WHY:** Static state breaks tests and horizontal reasoning.

**GOOD:**
```ts
export const prisma = new PrismaClient;
```

**BAD:**
```ts
export class Db {
 static client = new PrismaClient;
}
```

---

## 10. Interfaces and Types

### 10.1 `type` by default, `interface` for extendable contracts

**RULE:** Use `type` unless the symbol is an object shape that other modules are expected to extend or implement.

**WHY:** `type` supports unions, intersections, and mapped types with fewer surprises.

**GOOD:**
```ts
type UserId = string;
type LoginResult = { accessToken: string; refreshToken: string };
```

**BAD:**
```ts
interface UserId extends String {}
```

### 10.2 No `I` prefix on interfaces

**RULE:** Never prefix interfaces with `I`.

**WHY:** Redundant and discouraged by the TypeScript team.

**GOOD:**
```ts
type UserRepository = { findById(id: string): Promise<User | null> };
```

**BAD:**
```ts
interface IUserRepository { /*... */ }
```

### 10.3 Do not re-export Prisma types across module boundaries

**RULE:** Prisma-generated types stay inside repositories. Modules expose their own types.

**WHY:** Leaks ORM coupling and blocks ORM replacement or upgrade.

**GOOD:**
```ts
// users.types.ts
export type User = { id: string; email: string };
```

**BAD:**
```ts
// users.types.ts
export type { User } from '@prisma/client';
```

### 10.4 Prefer discriminated unions for state

**RULE:** When a value has multiple exclusive states, model it as a discriminated union, not optional fields.

**WHY:** Prevents impossible states and enables exhaustive checks.

**GOOD:**
```ts
type Result<T> =
 | { kind: 'ok'; value: T }
 | { kind: 'err'; code: string };
```

**BAD:**
```ts
type Result<T> = { value?: T; code?: string; ok: boolean };
```

---

## 11. Error Handling

### 11.1 Throw `AppError` from services

**RULE:** Services throw `AppError` subclasses with namespaced error codes. Do not throw raw strings, plain `Error`, or framework errors.

**WHY:** Centralized mapping and stable API codes.

**GOOD:**
```ts
throw new AppError(ErrorCodes.AUTH_INVALID_CREDENTIALS);
```

**BAD:**
```ts
throw new Error('invalid credentials');
```

### 11.2 Never swallow errors

**RULE:** If you catch, either recover meaningfully or rethrow with context. Empty `catch` blocks are forbidden.

**WHY:** Silent failures become production mysteries.

**GOOD:**
```ts
try {
 await mailer.send(msg);
} catch (err) {
 logger.error({ err }, 'failed to send verification email');
 throw new AppError(ErrorCodes.AUTH_EMAIL_SEND_FAILED);
}
```

**BAD:**
```ts
try { await mailer.send(msg); } catch {}
```

### 11.3 Map Prisma errors in the repository layer

**RULE:** Prisma error codes (`P2002`, `P2025`, etc.) are translated into module error codes inside the repository or service, never in the HTTP boundary.

**WHY:** Keeps HTTP layer ORM-agnostic and prevents leaking Prisma internals.

**GOOD:**
```ts
if (isUniqueViolation(err, 'users_email_key')) {
 throw new AppError(ErrorCodes.USERS_EMAIL_TAKEN);
}
```

**BAD:**
```ts
// error-handler.plugin.ts
if (err.code === 'P2002') return reply.status(409).send(err);
```

### 11.4 Never expose internals to clients

**RULE:** HTTP error responses must never contain stack traces, SQL, Prisma messages, or file paths.

**WHY:** Information disclosure.

**GOOD:**
```ts
reply.status(500).send({ type: 'about:blank', title: 'Internal Server Error', status: 500 });
```

**BAD:**
```ts
reply.status(500).send({ error: err.message, stack: err.stack });
```

### 11.4b Public error bodies originate only in the centralized mapper

**RULE:** Routes, guards, plugins, and services throw errors — they never construct public error response bodies. All translation lives in `src/shared/errors/error-mapper.ts` (classification + single body builder) consumed by the global error handler. Enforced by ARCH-ENF-015.

**WHY:** Independent envelope implementations drift (titles, details, headers diverge silently); one builder keeps the public contract byte-identical everywhere.

**GOOD:**
```ts
throw new AppError(ErrorCodes.AUTH_FORBIDDEN, 403, 'You cannot delete your own account.', {
 title: 'Forbidden',
});
```

**BAD:**
```ts
return reply.status(403).send({
 type: 'https://docs.oxyide.com/errors/forbidden',
 title: 'Forbidden',
 //...
});
```

### 11.5 Error codes are namespaced by module

**RULE:** Codes use `MODULE_REASON` form.

**WHY:** Avoids collisions in a central registry and makes ownership obvious.

**GOOD:**
```ts
ErrorCodes.USERS_NOT_FOUND
ErrorCodes.AUTH_INVALID_CREDENTIALS
```

**BAD:**
```ts
ErrorCodes.NOT_FOUND
ErrorCodes.ERROR_1
```

### 11.6 Repositories propagate unexpected database errors

**RULE:** A repository may convert only its documented expected outcomes —
absence (`P2025` → the established `null`/`false` result) and explicitly
mapped constraint violations. Any other database error (connection, timeout,
pool, authentication, deadlock, unknown Prisma failure) must propagate to the
caller so enclosing transactions roll back. Blanket `catch { return
null/false/undefined }` is forbidden.

**WHY:** Converting an infrastructure failure into "not found" masquerades an
outage as a successful operation and lets partial transactions commit. See
§16.1 for the transaction half of this rule.

**GOOD:**
```ts
} catch (error: unknown) {
 if (error instanceof Error && 'code' in error && error.code === 'P2025') {
 return null;
 }
 throw error;
}
```

**BAD:**
```ts
} catch {
 return null;
}
```

---

## 12. Async/Await

### 12.1 Always `await` promises

**RULE:** Never leave a promise floating without explicit `void` and a reason.

**WHY:** Unhandled rejections crash Node processes and hide failures.

**GOOD:**
```ts
void auditLogger.record(event).catch((err) => logger.error({ err }, 'audit failed'));
```

**BAD:**
```ts
auditLogger.record(event); // floating
```

### 12.2 Parallel independent work

**RULE:** Use `Promise.all` for independent awaits. Sequential awaits only when there is a real dependency.

**WHY:** Reduces latency without changing semantics.

**GOOD:**
```ts
const [user, roles] = await Promise.all([
 usersService.getById(id),
 rolesService.listForUser(id),
]);
```

**BAD:**
```ts
const user = await usersService.getById(id);
const roles = await rolesService.listForUser(id);
```

### 12.3 No `async` without `await`

**RULE:** Do not mark a function `async` unless it awaits or returns a promise.

**WHY:** Adds an unnecessary microtask and obscures intent.

**GOOD:**
```ts
function toDto(user: User): UserDto { return { id: user.id, email: user.email }; }
```

**BAD:**
```ts
async function toDto(user: User): Promise<UserDto> { return { id: user.id, email: user.email }; }
```

### 12.4 Avoid `.then` chains

**RULE:** Use `async/await`. `.then` is allowed only in narrow interop cases.

**WHY:** Readability and stack traces.

**GOOD:**
```ts
const user = await usersRepo.findById(id);
```

**BAD:**
```ts
usersRepo.findById(id).then((user) => user?.email).then((email) => /*... */);
```

---

## 13. Logging

### 13.1 Use the logger, not `console`

**RULE:** All application logging goes through the application logger (Fastify's Pino logger via `app.log`; `src/main.ts` uses a Pino fallback for startup failures). `console.log` is forbidden in `src/`.

**WHY:** Structured logs, redaction, and level control.

**GOOD:**
```ts
logger.info({ userId }, 'user authenticated');
```

**BAD:**
```ts
console.log('user', userId, 'logged in');
```

### 13.2 Structured fields, not string concatenation

**RULE:** Pass structured objects as the first argument. Message is a short human-readable string.

**WHY:** Enables querying and filtering.

**GOOD:**
```ts
logger.warn({ userId, ip }, 'login failed');
```

**BAD:**
```ts
logger.warn(`login failed for ${userId} from ${ip}`);
```

### 13.3 Never log secrets or PII

**RULE:** Tokens, passwords, cookies, refresh tokens, and raw PII are forbidden in logs. Logger redaction is not yet implemented (architecture §15 Future); until then the rule is enforced by construction and review.

**WHY:** Compliance and breach impact.

**GOOD:**
```ts
logger.info({ userId, tokenId }, 'refresh token rotated');
```

**BAD:**
```ts
logger.info({ refreshToken }, 'rotated token');
```

### 13.4 Correct levels

**RULE:** `debug` for dev-only detail, `info` for normal lifecycle events, `warn` for recoverable anomalies, `error` for failures requiring attention.

**WHY:** Keeps signal-to-noise ratio usable.

**GOOD:**
```ts
logger.warn({ userId }, 'account temporarily locked');
logger.error({ err }, 'failed to send verification email');
```

**BAD:**
```ts
logger.error({ userId }, 'user logged in');
```

### 13.5 Use request-scoped logging

**RULE:** Prefer `request.log` inside route handlers so logs carry correlation IDs.

**WHY:** Correlates logs across a single request.

**GOOD:**
```ts
request.log.info({ userId }, 'user fetched');
```

**BAD:**
```ts
logger.info('user fetched'); // no request context
```

---

## 14. Validation

### 14.1 Validate at the boundary

**RULE:** All input is validated by Fastify route schemas before reaching the handler. Handlers receive typed, validated input.

**WHY:** Single validation point, reused for OpenAPI.

**GOOD:**
```ts
fastify.post('/users', { schema: createUserSchema }, createUserHandler);
```

**BAD:**
```ts
fastify.post('/users', async (req) => {
 const body = req.body as any;
 if (!body.email) throw new Error('email required');
});
```

### 14.2 Never trust request input

**RULE:** Assume all client input is hostile. Validate type, shape, length, and allowed values.

**WHY:** Injection, DoS, and logic bypass.

**GOOD:**
```ts
schema: { body: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email', maxLength: 254 } } } }
```

**BAD:**
```ts
schema: { body: { type: 'object' } }
```

### 14.3 Validate environment at startup

**RULE:** `env.schema.ts` validates `process.env` at boot. Missing or invalid values must crash the process.

The required PostgreSQL connection variable is `DATABASE_URL`, and it is validated through the central configuration layer.

**WHY:** Fail fast beats runtime surprises.

**GOOD:**
```ts
const env = envSchema.parse(process.env);
```

**BAD:**
```ts
const dbUrl = process.env.DATABASE_URL || '';
```

### 14.4 Repositories do not validate

**RULE:** Repositories trust their typed inputs. Validation belongs at the boundary.

**WHY:** Avoids duplicated validation and false confidence.

**GOOD:**
```ts
async function findById(id: UserId): Promise<User | null> { /*... */ }
```

**BAD:**
```ts
async function findById(id: string) {
 if (!id || id.length !== 36) throw new Error('bad id');
}
```

### 14.5 Database connection parameters live in DATABASE_URL

**RULE:** `connection_limit`, `pool_timeout`, `connect_timeout`, and `sslmode`
are configured as `DATABASE_URL` query parameters — never as separate
environment variables. `env.schema.ts` validates them at startup:
pool/timeout values must be positive integers (≥ 1) and appear at most once;
`sslmode` must be `require` or `disable`.

**WHY:** Query parameters are Prisma's native mechanism; a parallel variable
set would duplicate the contract and drift from it. Prisma 6.12.0 silently
ignores unknown parameters, so startup validation is the only guard against
misspelled or meaningless options.

**GOOD:**
```text
DATABASE_URL=postgresql://app:secret@db:5432/forge?connection_limit=10&pool_timeout=10&connect_timeout=5&sslmode=require
```

**BAD:**
```text
DB_POOL_SIZE=10
DATABASE_URL=postgresql://app:secret@db:5432/forge?sslmode=verify-full
```

### 14.6 Production requires encrypted database connections

**RULE:** When `NODE_ENV=production`, `DATABASE_URL` must include
`sslmode=require`. Startup validation rejects production configuration without
it. `verify-ca` and `verify-full` are rejected everywhere because Prisma
6.12.0 silently ignores them — accepting them would promise verification that
never happens.

**WHY:** Unencrypted production database traffic exposes credentials and data
to the network. A silently-ignored mode is worse than an explicit refusal.

**GOOD:**
```text
NODE_ENV=production
DATABASE_URL=postgresql://app:secret@db:5432/forge?sslmode=require
```

**BAD:**
```text
NODE_ENV=production
DATABASE_URL=postgresql://app:secret@db:5432/forge
```

### 14.7 Never log connection credentials

**RULE:** Error messages, logs, and validation output must never contain the
`DATABASE_URL` password or full connection string. Redact userinfo; report
host, port, and database name only where a target must be identified.

**WHY:** Connection strings routinely end up in log aggregators, CI output,
and error trackers. A single leak compromises the database.

**GOOD:**
```ts
throw new Error(`could not connect to PostgreSQL at ${host}:${port}`);
```

**BAD:**
```ts
throw new Error(`could not connect with ${databaseUrl}`);
```

---

## 15. Database Access

### 15.1 Repositories own queries

**RULE:** Only repositories execute Prisma queries and mutations. Services call repositories. Services never call query or mutation methods such as `prisma.user.findUnique(...)` directly. Opening a business transaction with `prisma.$transaction` is not a query — it is a service responsibility governed by §16.1.

**WHY:** Encapsulation and testability. Transaction-boundary ownership (§16.1) and persistence implementation (this rule) are distinct responsibilities: the service decides which operations must be atomic together, and the repository executes the statements inside that boundary. "Repositories own queries" does not mean "repositories own transactions."

**GOOD:**
```ts
// users.repository.ts
export async function findById(id: string) { return prisma.user.findUnique({ where: { id } }); }
```

**BAD:**
```ts
// users.service.ts
const user = await prisma.user.findUnique({ where: { id } });
```

### 15.2 Select only needed fields

**RULE:** Use `select` unless the whole model is truly required. Never return `passwordHash` outside the auth module.

**WHY:** Performance and least privilege.

**GOOD:**
```ts
prisma.user.findUnique({ where: { id }, select: { id: true, email: true, status: true } });
```

**BAD:**
```ts
prisma.user.findUnique({ where: { id } });
```

### 15.3 Avoid N+1 queries

**RULE:** Use `include` or batched queries deliberately. If you loop and query per item, restructure.

**WHY:** N+1 kills performance under load.

**GOOD:**
```ts
prisma.user.findMany({ include: { roles: true } });
```

**BAD:**
```ts
for (const user of users) { await prisma.role.findMany({ where: { userId: user.id } }); }
```

### 15.4 Return domain types, not Prisma models

**RULE:** Repositories map Prisma rows to module types before returning.

**WHY:** Keeps ORM out of services and API responses.

**GOOD:**
```ts
return { id: row.id, email: row.email, status: row.status };
```

**BAD:**
```ts
return row; // Prisma model with all fields
```

---

## 16. Transactions

### 16.1 Services own transaction boundaries

**RULE:** Services (use cases) own business transaction boundaries: only services open transactions. Repositories never open their own transactions; they accept an optional transaction client (`tx?: Prisma.TransactionClient`) and use it for their operation when one is provided.

All persistence operations that must be atomic for one business operation receive the same transaction client, threaded explicitly through cross-module service boundaries when required. Unexpected database errors inside a transaction must propagate to the owning service so that the transaction rolls back; a repository may convert only its documented not-found outcome (Prisma `P2025`) into its `false`/`null` result.

Transaction context and unit-of-work abstractions remain future infrastructure (see `docs/architecture.md` §10); until then, services open transactions directly with `prisma.$transaction`.

**WHY:** Repositories are too granular; services know the unit of work.

**GOOD:**
```ts
await prisma.$transaction(async (tx) => {
 const user = await usersRepo.create(input, tx);
 await rolesRepo.assign(user.id, roleId, tx);
});
```

**BAD:**
```ts
// repository opens its own transaction
await prisma.$transaction((tx) => tx.user.create({ data }));
```

### 16.2 Transactions are short

**RULE:** No network calls, email sending, or external I/O inside a transaction.

**WHY:** Long transactions hold locks and cause contention.

**GOOD:**
```ts
const user = await prisma.$transaction(/* db-only work */);
await mailer.sendVerification(user); // outside
```

**BAD:**
```ts
await prisma.$transaction(async (tx) => {
 const user = await tx.user.create({ data });
 await mailer.sendVerification(user); // network inside tx
});
```

### 16.3 No nested transactions

**RULE:** Do not open a transaction inside another. Thread the transaction client instead.

**WHY:** Nested transactions are not supported by Prisma and cause subtle bugs.

**GOOD:**
```ts
async function createUser(tx: Prisma.TransactionClient, input: CreateUserInput) { /*... */ }
```

**BAD:**
```ts
async function createUser(input: CreateUserInput) { return prisma.$transaction(/*... */); }
```

---

## 17. Redis Access

> **V1 Status:** Redis is optional infrastructure in V1. The application starts and functions normally without Redis when `REDIS_URL` is not configured.

### 17.1 Redis is optional in V1

**RULE:** Redis is not a hard dependency. The application must function without Redis. When `REDIS_URL` is not set, `config.cache` is `undefined` and the Redis plugin is skipped.

**WHY:** Redis is infrastructure for future features (sessions, rate limiting, caching). V1 does not require it.

**GOOD:**
```ts
if (!config.cache) {
 app.log.warn('Redis not configured — skipping Redis plugin');
 return;
}
```

**BAD:**
```ts
// Assumes Redis is always available
const client = createRedisClient(config.cache.redis.url);
```

### 17.2 Access Redis through the cache service

**RULE:** Only `src/platform/cache/cache.service.ts` talks to `redis.ts` directly. Modules use the cache service.

**WHY:** Single point for key namespacing, TTLs, and fallback behavior.

**GOOD:**
```ts
await cacheService.set(cacheKeys.userProfile(userId), profile, { ttlSeconds: 60 });
```

**BAD:**
```ts
await redis.set(`user:${userId}`, JSON.stringify(profile));
```

### 17.3 Keys are namespaced and versioned

**RULE:** Cache keys follow `<app>:<version>:<module>:<entity>:<id>` and are centralized in a `cacheKeys` module.

**WHY:** Prevents collisions and enables safe invalidation on schema changes.

**GOOD:**
```ts
cacheKeys.userProfile(userId); // oxyide:v1:users:profile:<id>
```

**BAD:**
```ts
`profile-${userId}`;
```

### 17.4 Explicit TTL on every write

**RULE:** Every `set` includes a TTL. No unbounded keys.

**WHY:** Prevents memory growth and stale data.

**GOOD:**
```ts
await cacheService.set(key, value, { ttlSeconds: 300 });
```

**BAD:**
```ts
await cacheService.set(key, value);
```

### 17.5 Define failure behavior per feature

**RULE:** Sessions: fail closed. Cache: fail open. Auth rate limiting: fail closed. Documented per feature.

**WHY:** Ambiguity causes production outages.

**GOOD:**
```ts
try { return await cacheService.get(key); } catch { return null; } // cache fail-open
```

**BAD:**
```ts
return await cacheService.get(key); // throws on Redis down, kills request
```

### 17.6 Never store PII without policy

**RULE:** Do not cache emails, tokens, or personal data without an approved retention and access policy.

**WHY:** Compliance and breach impact.

**GOOD:**
```ts
cacheKeys.userProfile(userId); // stores non-sensitive projection only
```

**BAD:**
```ts
cacheService.set(`user:${id}`, user); // full user with email and password hash
```

---

## 18. Authentication

> **V1 Status:** JWT authentication with bcrypt password hashing, cookie + bearer auth. Refresh tokens, CSRF protection, and session persistence are deferred to V2.

### 18.1 Auth context is attached by hooks

**RULE:** Authentication happens in hooks. Handlers read `request.auth` or equivalent context. Handlers never parse tokens themselves.

**WHY:** Single verification point, consistent behavior.

**GOOD:**
```ts
fastify.get('/me', { preHandler: [requireAuth] }, (req) => req.auth.sub);
```

**BAD:**
```ts
fastify.get('/me', (req) => { const token = req.headers.authorization?.split(' ')[1]; /*... */ });
```

### 18.2 Never trust client-supplied identity

**RULE:** User IDs, roles, and permissions from the client are untrusted. Derive identity from the verified session.

**WHY:** Privilege escalation.

**GOOD:**
```ts
const userId = request.auth.sub;
```

**BAD:**
```ts
const userId = request.body.userId;
```

### 18.3 Never store raw tokens

**RULE:** Refresh tokens and session identifiers are stored hashed.

**WHY:** Database compromise must not grant session takeover.

**GOOD:**
```ts
await sessions.create({ tokenHash: sha256(token), userId });
```

**BAD:**
```ts
await sessions.create({ token, userId });
```

### 18.4 Security constants live in config

**RULE:** Token TTLs, cookie flags, cookie names, and secret names are read from validated config, not hardcoded.

**WHY:** Environment-specific security tuning and auditability.

**GOOD:**
```ts
config.auth.accessTokenTtlSeconds
```

**BAD:**
```ts
const ACCESS_TTL = 900;
```

### 18.5 V1 authentication rules

**RULE:** V1 implements:
- JWT access tokens (HS256, 15-minute TTL) via `@fastify/jwt`
- Bcrypt password hashing (cost factor 12)
- Browser cookie authentication (`accessToken` cookie, HttpOnly, SameSite Lax)
- Bearer token authentication for API clients
- Registration does NOT issue access tokens
- Logout clears the cookie
- Production cookie auth blocked until CSRF protection is implemented

**WHY:** V1 baseline must be preserved.

**GOOD:**
```ts
// V1: JWT + bcrypt + cookie + bearer
const accessToken = createAccessToken(app, { sub: user.id });
```

**BAD:**
```ts
// V2 feature: refresh tokens (not implemented in V1)
const refreshToken = await createRefreshToken(user.id);
```

### 18.6 Cookie auth requires CSRF protection (V2)

**RULE:** Any cookie-based auth path must be paired with CSRF protection. In V1, production cookie auth is blocked until CSRF is implemented.

**WHY:** CSRF is not optional for cookie auth in production.

**GOOD:**
```ts
// V1: Production cookie auth blocked; Bearer-only production remains available
if (!config.auth.cookie.enabled) {
 app.log.warn(
 'Cookie-based authentication is disabled in production until CSRF protection is implemented. Bearer authentication remains available.');
 return;
}
```

**BAD:**
```ts
// V1: Cookie auth enabled in production without CSRF
```

---

## 19. Authorization

> **V1 Status:** RBAC with user/admin roles, 11 permissions, server-side role lookup. Multiple roles, role administration, and permission caching are deferred to V2.

### 19.1 Authorize after authentication

**RULE:** Every protected route declares an authorization requirement. Authentication alone is not sufficient.

**WHY:** Authenticated does not mean authorized.

**GOOD:**
```ts
fastify.delete('/users/:id', { preHandler: [requireAuth, requirePermission('users:delete')] }, handler);
```

**BAD:**
```ts
fastify.delete('/users/:id', { preHandler: [requireAuth] }, handler);
```

### 19.2 Deny by default

**RULE:** Routes are protected unless explicitly marked public. Public routes are listed and reviewed.

**WHY:** Prevents accidental exposure.

**GOOD:**
```ts
// public route explicitly annotated
fastify.get('/health/live', async => ({}));
```

**BAD:**
```ts
// route omitted protection by accident
fastify.get('/admin/users', handler);
```

### 19.3 Never rely on the client for authorization

**RULE:** Frontend checks are UX only. Server enforces.

**WHY:** Clients are untrusted.

**GOOD:**
```ts
if (!(await authz.can(user, 'delete', resource))) throw new AppError(ErrorCodes.AUTH_FORBIDDEN);
```

**BAD:**
```ts
// trusting a role claim in the JWT alone without server-side re-check for sensitive actions
```

### 19.4 Log authorization failures

**RULE:** Denied access is logged at `warn` with actor, action, and resource.

**WHY:** Detects probing and privilege escalation attempts.

**GOOD:**
```ts
logger.warn({ userId, action, resourceId }, 'authorization denied');
```

**BAD:**
```ts
throw new AppError(ErrorCodes.AUTH_FORBIDDEN); // no log
```

### 19.5 V1 authorization rules

**RULE:** V1 implements:
- Two built-in roles: `user` (default) and `admin`
- 11 permissions across auth, users, and roles domains
- Server-side role lookup via `usersService.findRoleById`
- Authorization guards: `requireAuth`, `requirePermission`, `requireRole`
- Authorization policy: `userPolicy`
- Self-scope authorization (users can access their own resources)
- Deny-by-default model

**WHY:** V1 baseline must be preserved.

**GOOD:**
```ts
// V1: Server-side role lookup
const role = await usersService.findRoleById(authContext.sub);
```

**BAD:**
```ts
// V2: Multiple roles per user (not implemented in V1)
const roles = await userRolesService.findRolesByUserId(userId);
```

### 19.6 Role administration is admin-only (V2)

**RULE:** Role and permission changes require elevated authorization, audit logging, and self-escalation prevention.

**WHY:** Role mutation is a privilege-escalation surface.

**GOOD:**
```ts
fastify.post('/roles', { preHandler: [requirePermission('roles:create'), forbidSelfEscalation] }, handler);
```

**BAD:**
```ts
fastify.post('/roles', { preHandler: [requireAuth] }, handler);
```

---

## 20. API Responses

### 20.1 Resource-oriented success bodies

**RULE:** Success responses return the resource or a collection. Avoid wrapping in multiple layers.

**WHY:** Interoperability with clients, OpenAPI, and caches.

**GOOD:**
```json
{ "id": "u_1", "email": "a@b.com" }
```

**BAD:**
```json
{ "status": "success", "data": { "result": { "id": "u_1" } } }
```

### 20.2 Status codes are meaningful

**RULE:** 200/201/204 for success, 400/401/403/404/409/422/429 for client errors, 500/503 for server errors. Do not return 200 with an error body.

**WHY:** Correct semantics enable retries, caching, and observability.

**GOOD:**
```ts
reply.status(201).send(user);
```

**BAD:**
```ts
reply.status(200).send({ error: 'user exists' });
```

### 20.3 Never return internal fields

**RULE:** Responses must not include `passwordHash`, `deletedAt`, internal flags, or Prisma metadata unless explicitly part of the public contract.

**WHY:** Information disclosure.

**GOOD:**
```ts
return { id: user.id, email: user.email };
```

**BAD:**
```ts
return user; // includes passwordHash
```

### 20.4 Collection responses include pagination metadata

**RULE:** When returning collections, include a consistent pagination block.

**WHY:** Clients need to know how to fetch the next page.

**GOOD:**
```json
{ "items": [], "pageInfo": { "nextCursor": null, "hasMore": false } }
```

**BAD:**
```json
[ ]
```

---

## 21. API Errors

### 21.1 RFC 7807 problem details

**RULE:** Error responses use the approved problem-details shape with `type`, `title`, `status`, `detail`, and a stable `code`.

**WHY:** Standardized error contract.

**GOOD:**
```json
{ "type": "about:blank", "title": "Invalid credentials", "status": 401, "code": "AUTH_INVALID_CREDENTIALS" }
```

**BAD:**
```json
{ "error": "invalid credentials", "success": false }
```

### 21.2 Error codes are stable

**RULE:** Once published, an error code’s meaning and HTTP status do not change. New behavior means a new code.

**WHY:** Clients depend on codes for branching.

**GOOD:**
```ts
ErrorCodes.AUTH_INVALID_CREDENTIALS
```

**BAD:**
```ts
ErrorCodes.AUTH_ERROR // reused for multiple meanings
```

### 21.3 No stack traces, no ORM messages

**RULE:** Never send stack traces, Prisma messages, or SQL to clients.

**WHY:** Information disclosure.

**GOOD:**
```ts
reply.status(500).send(problem(500, 'internal_error'));
```

**BAD:**
```ts
reply.status(500).send({ message: err.message });
```

### 21.4 Logged with correlation ID

**RULE:** Every server error is logged with the request ID and, when available, the actor.

**WHY:** Enables incident triage.

**GOOD:**
```ts
request.log.error({ err, requestId: request.id }, 'unhandled error');
```

**BAD:**
```ts
logger.error('something went wrong');
```

### 21.5 Validation errors are 422 or 400, consistently

**RULE:** Schema validation failures return a consistent status and code. Choose one and never mix.

**WHY:** Predictable client handling.

**GOOD:**
```ts
reply.status(400).send(problem(400, 'validation_failed'));
```

**BAD:**
```ts
reply.status(422).send(...); // sometimes 400, sometimes 422
```

---

## 22. Pagination

> **V1 Status:** Pagination is not implemented in V1. This section defines the rules for when pagination is added.

### 22.1 Cap page size

**RULE:** Every paginated endpoint enforces a maximum page size (e.g., 100). Defaults are documented.

**WHY:** Prevents DoS and memory blowups.

**GOOD:**
```ts
const limit = Math.min(input.limit ?? 20, 100);
```

**BAD:**
```ts
const limit = input.limit ?? 20; // unbounded
```

### 22.2 Cursor-based for large sets

**RULE:** Prefer cursor pagination for large or frequently-changing collections. Offset is allowed only for small, stable sets.

**WHY:** Offset degrades and skips/duplicates rows under churn.

**GOOD:**
```ts
prisma.user.findMany({ take: limit + 1, cursor: { id: cursor }, skip: cursor ? 1: 0 });
```

**BAD:**
```ts
prisma.user.findMany({ skip: page * limit, take: limit });
```

### 22.3 Consistent metadata

**RULE:** All paginated endpoints return the same metadata shape.

**WHY:** Uniform client handling.

**GOOD:**
```json
{ "items": [], "pageInfo": { "nextCursor": null, "hasMore": false } }
```

**BAD:**
```json
{ "data": [], "total": 0 } // different shape per endpoint
```

### 22.4 Sorting is allowlisted

**RULE:** Only allowlisted columns may be used for sorting. Never pass user input to `orderBy` directly.

**WHY:** Injection and performance abuse.

**GOOD:**
```ts
const orderBy = sortAllowlist[input.sort] ?? { id: 'asc' };
```

**BAD:**
```ts
prisma.user.findMany({ orderBy: { [input.sort]: input.dir } });
```

---

## 23. Environment Variables

### 23.1 Read env only through config

**RULE:** `process.env` is used only in `src/config/env.schema.ts`. Everywhere else imports the validated config.

**WHY:** Single source of truth; testability.

**GOOD:**
```ts
import { config } from '@/config';
config.db.url;
```

**BAD:**
```ts
const url = process.env.DATABASE_URL;
```

### 23.2 No secrets in defaults

**RULE:** `.env.example` uses placeholder values, never real secrets.

**WHY:** Prevents accidental leakage.

**GOOD:**
```text
JWT_SECRET=replace-me
```

**BAD:**
```text
JWT_SECRET=dev-secret-123
```

### 23.3 Fail fast on missing env

**RULE:** Boot fails if required env is missing or invalid.

**WHY:** Avoids partial startup.

**GOOD:**
```ts
envSchema.parse(process.env); // throws on missing
```

**BAD:**
```ts
const secret = process.env.JWT_SECRET ?? 'default';
```

### 23.4 Environment-specific files are not committed

**RULE:** `.env` is gitignored. Only `.env.example` is committed.

**WHY:** Secrets never belong in source control.

**GOOD:**
```text
.env.example ✅
.env ❌
```

**BAD:**
```text
.env.production committed
```

---

## 24. Configuration

### 24.1 Config is typed and immutable

**RULE:** Config is a typed object derived from validated env. Do not mutate at runtime.

**WHY:** Prevents hidden state changes.

**GOOD:**
```ts
export const config = Object.freeze(parsed);
```

**BAD:**
```ts
config.db.url = 'other';
```

### 24.2 Config is domain-split

**RULE:** Group config by domain: `auth`, `db`, `cache`, `http`, `logging`. Do not create one flat object.

**WHY:** Discoverability and ownership.

**GOOD:**
```ts
config.auth.accessTokenTtlSeconds
config.cache.url
```

**BAD:**
```ts
config.ACCESS_TOKEN_TTL
config.REDIS_URL
```

### 24.3 No feature toggles hidden in code

**RULE:** Behavior differences across environments come from config, not conditionals on `NODE_ENV` scattered in code.

**WHY:** Predictable behavior and testability.

**GOOD:**
```ts
if (config.http.swaggerEnabled) fastify.register(swaggerPlugin);
```

**BAD:**
```ts
if (process.env.NODE_ENV !== 'production') fastify.register(swaggerPlugin);
```

### 24.4 Config is injectable for tests

**RULE:** Tests build config from a typed factory; modules read config via injection or import of the validated object.

**WHY:** Avoids test-order coupling.

**GOOD:**
```ts
const cfg = buildConfig({ db: { url: 'postgres://...' } });
```

**BAD:**
```ts
process.env.DATABASE_URL = '...'; // mutated in tests
```

---

## 25. Security

> **V1 Status:** Core security implemented. CORS, rate limiting, Helmet, CSRF, and production hardening are deferred to V2.

### 25.1 V1 security controls (implemented)

**RULE:** V1 implements:
- Password hashing with bcrypt (cost factor 12)
- JWT validation (HS256, 15-minute TTL)
- Cookie security (HttpOnly, SameSite Lax, Secure in production)
- Authorization checks (deny-by-default)
- Input validation (additionalProperties: false)
- No secrets in logs or responses
- Generic credential errors (prevents user enumeration)
- WWW-Authenticate header on 401 responses
- Production cookie auth blocked until CSRF protection exists

**WHY:** V1 baseline must be preserved.

**GOOD:**
```ts
// V1: Production cookie auth blocked; Bearer-only production remains available
if (!config.auth.cookie.enabled) {
 return;
}
```

**BAD:**
```ts
// V1: Cookie auth enabled in production without CSRF
```

### 25.2 Strict CORS allowlist (V2)

**RULE:** CORS origins come from config and are never `*` when credentials are enabled.

**WHY:** Wildcard plus credentials exposes authenticated APIs to any origin.

**GOOD:**
```ts
cors: { origin: config.http.corsOrigins, credentials: true }
```

**BAD:**
```ts
cors: { origin: '*', credentials: true }
```

### 25.3 CSRF for cookie auth (V2)

**RULE:** Cookie-auth requests must pass CSRF verification.

**WHY:** Prevents cross-site state changes.

**GOOD:**
```ts
fastify.addHook('onRequest', csrfGuard);
```

**BAD:**
```ts
// no CSRF guard
```

### 25.4 Body size limits (V2)

**RULE:** Global and per-route body limits are set.

**WHY:** DoS via large payloads.

**GOOD:**
```ts
fastify.register(fastify, { bodyLimit: 1_048_576 });
```

**BAD:**
```ts
// no body limit configured
```

### 25.5 Rate limits are per-route for sensitive endpoints (V2)

**RULE:** Auth, password reset, and token endpoints have stricter limits than global defaults.

**WHY:** Brute-force and credential stuffing.

**GOOD:**
```ts
fastify.post('/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, handler);
```

**BAD:**
```ts
// only global rate limit
```

### 25.6 No secrets in logs or responses

**RULE:** Secrets are forbidden in logs and responses. 5xx responses are sanitized by the global error handler (architecture §14); logger redaction is not yet implemented (architecture §15 Future), so enforcement today is by construction and review.

**WHY:** Leak prevention.

**GOOD:**
```ts
logger.info({ userId }, 'token refreshed');
```

**BAD:**
```ts
logger.info({ token }, 'token refreshed');
```

### 25.7 Swagger gated in production (V2)

**RULE:** Swagger is enabled only when config allows. Default off in production.

**WHY:** Reduces attack surface and schema leakage.

**GOOD:**
```ts
if (config.http.swaggerEnabled) fastify.register(swaggerPlugin);
```

**BAD:**
```ts
fastify.register(swaggerPlugin); // always on
```

### 25.8 HTTPS and HSTS at the edge (V2)

**RULE:** Production serves only HTTPS; cookies use `Secure`, `HttpOnly`, `SameSite` per config.

**WHY:** Prevents interception and cookie theft.

**GOOD:**
```ts
cookies: { secure: true, httpOnly: true, sameSite: 'lax' }
```

**BAD:**
```ts
cookies: { secure: false, httpOnly: false }
```

---

## 26. Testing

### 26.1 Unit tests for pure logic and policies

**RULE:** Services, policies, and utilities have unit tests with no I/O.

**WHY:** Fast, deterministic, and catch logic errors early.

**GOOD:**
```ts
it('rejects expired tokens', => { /* pure check */ });
```

**BAD:**
```ts
it('login works', async => { /* hits real DB */ });
```

### 26.2 Integration tests use real dependencies via Testcontainers

**RULE:** When database integration tests are introduced, they run against real PostgreSQL and Redis containers. No mocks for the database.

Testcontainers are future testing infrastructure and are not introduced in the current database foundation milestone.

**WHY:** Mocked DBs hide migration and query bugs.

**GOOD:**
```ts
const pg = await new PostgreSqlContainer.start;
```

**BAD:**
```ts
jest.mock('@/platform/database/prisma', => ({ user: { findUnique: jest.fn } }));
```

### 26.3 Factories, not seeds, for test data

**RULE:** Tests build fixtures via factories. Production seeds are for reference data only.

**WHY:** Seeds cause cross-test coupling and flakiness.

**GOOD:**
```ts
const user = await userFactory.create({ email: 'a@b.com' });
```

**BAD:**
```ts
await execSync('npm run db:seed');
```

### 26.4 One behavior per test

**RULE:** Each test asserts one behavior. Test names describe behavior, not implementation.

**WHY:** Failures point to a cause.

**GOOD:**
```ts
it('returns 401 when the password is wrong', async => { /*... */ });
```

**BAD:**
```ts
it('tests login', async => { /* many assertions */ });
```

### 26.5 Authz and security regressions are covered

**RULE:** Every authorization rule has allow and deny tests. Every auth flow has negative tests.

**WHY:** Security bugs are invisible without them.

**GOOD:**
```ts
it('denies non-admin role creation', async => { /*... */ });
```

**BAD:**
```ts
// only happy path tested
```

### 26.6 No production dependencies in tests

**RULE:** Tests must not call real email, real payment, or third-party APIs.

**WHY:** Determinism and side-effect safety.

**GOOD:**
```ts
const mailer = new FakeMailer;
```

**BAD:**
```ts
await realMailer.send(msg);
```

---

## 27. Comments

### 27.1 Comments explain why, not what

**RULE:** Code says what; comments say why.

**WHY:** “What” comments rot; “why” comments preserve intent.

**GOOD:**
```ts
// Refresh rotation invalidates the previous token to detect replay.
```

**BAD:**
```ts
// increment i
i++;
```

### 27.2 No commented-out code

**RULE:** Delete it. Git remembers.

**WHY:** Commented code confuses readers and rots.

**GOOD:**
```ts
// deleted; see git history
```

**BAD:**
```ts
// const user = await findUser(id);
```

### 27.3 TODOs require a ticket

**RULE:** `TODO` must include an owner or ticket reference.

**WHY:** Orphan TODOs live forever.

**GOOD:**
```ts
// TODO(OXY-142): replace with refresh-token rotation
```

**BAD:**
```ts
// TODO: fix this
```

### 27.4 JSDoc only on public contracts

**RULE:** Document public service methods and shared types. Do not JSDoc every internal helper.

**WHY:** Reduces noise and keeps docs meaningful.

**GOOD:**
```ts
/** Returns null when the user is soft-deleted. */
export async function findActiveById(id: string): Promise<User | null> { /*... */ }
```

**BAD:**
```ts
/** Adds two numbers. */
function add(a: number, b: number) { return a + b; }
```

---

## 28. Documentation

### 28.1 Architecture changes update `docs/architecture.md`

**RULE:** Any change to module boundaries, dependency direction, or infrastructure updates the architecture document in the same PR.

**WHY:** Prevents drift between code and documented architecture.

**GOOD:**
```text
PR includes: src changes + docs/architecture.md update
```

**BAD:**
```text
PR changes module boundaries, no docs update
```

### 28.2 Significant decisions get an ADR

**RULE:** Decisions affecting security, data model, or module boundaries are recorded as ADRs under `docs/adr/`.

**WHY:** Preserves reasoning for future maintainers.

**GOOD:**
```text
docs/adr/0007-csrf-strategy.md
```

**BAD:**
```text
Decision only in Slack
```

### 28.3 README stays accurate

**RULE:** Setup, scripts, and required env changes update `README.md`.

**WHY:** Broken onboarding wastes time.

**GOOD:**
```text
README lists `pnpm prisma migrate dev` after migration changes
```

**BAD:**
```text
README still mentions removed command
```

### 28.4 No stale docs

**RULE:** If a doc is no longer true, fix or delete it.

**WHY:** Stale docs are worse than none.

**GOOD:**
```text
Old Redis section replaced with adapter design
```

**BAD:**
```text
Two conflicting sections
```

---

## 29. Dependencies

### 29.1 Justify every new dependency

**RULE:** New runtime dependencies require a written justification in the PR: what it does, why not in-house, maintenance status, license.

**WHY:** Dependencies are liabilities.

**GOOD:**
```text
PR adds `@fastify/helmet`; justification: standard security headers, maintained by Fastify org.
```

**BAD:**
```text
PR adds `left-pad`, no justification.
```

### 29.2 No duplicate functionality

**RULE:** Do not add a second library for something already covered (e.g., two HTTP clients, two validation libraries).

**WHY:** Divergent behavior and bundle bloat.

**GOOD:**
```text
One validation approach: Fastify JSON schema.
```

**BAD:**
```text
Both zod and ajv for route validation.
```

### 29.3 Lockfile committed

**RULE:** Commit the lockfile and do not hand-edit it.

**WHY:** Reproducible installs.

**GOOD:**
```text
pnpm-lock.yaml committed
```

**BAD:**
```text
lockfile gitignored
```

### 29.4 Audit is part of CI

**RULE:** Dependency audit must run in CI before merge. High/critical issues block merge or require a documented waiver.

**WHY:** Supply-chain hygiene.

**GOOD:**
```yaml
- run: pnpm audit --audit-level=high
```

**BAD:**
```text
No audit step
```

### 29.5 Pin Node and package manager

**RULE:** `package.json` declares `engines.node` and `packageManager`.

**WHY:** Avoids “works on my machine.”

**GOOD:**
```json
{ "engines": { "node": ">=20" }, "packageManager": "pnpm@9" }
```

**BAD:**
```json
{ }
```

---

## 30. Performance

### 30.1 Do not block the event loop

**RULE:** No CPU-heavy synchronous work in request handlers. Move it to a worker or cache the result.

**WHY:** A blocked event loop stalls all requests.

**GOOD:**
```ts
const hash = await bcrypt.hash(password, 12);
```

**BAD:**
```ts
const hash = bcrypt.hashSync(password, 12);
```

### 30.2 Index before you optimize

**RULE:** Add a database index when a query pattern justifies it. Do not add indexes speculatively.

**WHY:** Indexes cost write time and storage.

**GOOD:**
```prisma
@@index([email])
```

**BAD:**
```prisma
@@index([email]) @@index([status]) @@index([createdAt]) // speculative
```

### 30.3 Cache with a purpose and an invalidation plan

**RULE:** Only cache data with a clear invalidation path and TTL. Never cache to “make it fast.”

**WHY:** Stale cache is a production incident.

**GOOD:**
```ts
cacheKeys.userProfile(id); // invalidated on user update
```

**BAD:**
```ts
cacheService.set('everything', bigObject, { ttlSeconds: 86400 });
```

### 30.4 Measure before optimizing

**RULE:** Performance changes require a benchmark or trace demonstrating the problem and the improvement.

**WHY:** Premature optimization adds complexity.

**GOOD:**
```text
Trace shows 800ms in N+1 query; batched fix reduces to 60ms.
```

**BAD:**
```text
“Rewrote in a microservice because it felt slow.”
```

### 30.5 Stream large payloads

**RULE:** Do not buffer large responses or uploads in memory. Stream them.

**WHY:** Memory exhaustion under load.

**GOOD:**
```ts
reply.send(createReadStream(path));
```

**BAD:**
```ts
reply.send(await fs.readFile(path)); // whole file in memory
```

---

## 31. AI Coding Agent Standards

### 31.1 Required reading before any change

**RULE:** Before making any change, read the relevant documents:
- Architecture changes: `docs/architecture.md`
- Code changes: `docs/engineering-standards.md`
- API changes: `docs/api-conventions.md`
- AI agent rules: `AGENTS.md`

**WHY:** Prevents architectural violations and ensures consistency.

**GOOD:**
```text
Agent reads docs/engineering-standards.md before modifying auth service.
```

**BAD:**
```text
Agent modifies code without reading any documentation.
```

### 31.2 State the plan before coding

**RULE:** Before writing code, state in plain language:
1. What you are going to change.
2. Why.
3. Which architectural document governs the change.
4. Any tradeoffs or risks.
5. Files that will change.

**WHY:** Prevents scope creep and ensures alignment with architecture.

**GOOD:**
```text
Plan: Add rate limiting to login endpoint.
Why: Prevent brute-force attacks.
Governed by: docs/architecture.md §21, docs/engineering-standards.md §25.4.
Files: src/plugins/rate-limit.plugin.ts, src/modules/auth/routes/auth.routes.ts.
```

**BAD:**
```text
Agent starts coding without stating a plan.
```

### 31.3 Stay inside scope

**RULE:** Touch only what the task requires. Do not reformat, rename, or refactor files outside the scope. Do not run repository-wide formatters across unrelated files.

**WHY:** Prevents unintended changes and review burden.

**GOOD:**
```text
Task: Fix login validation. Agent modifies only auth.routes.ts and auth.service.ts.
```

**BAD:**
```text
Agent reformats 20 unrelated files while fixing login validation.
```

### 31.4 Never bypass existing abstractions

**RULE:** If a repository, service, cache service, logger, config, or error mapper exists, use it. Do not call Prisma, Redis, `process.env`, `console`, or raw `fetch` directly.

**WHY:** Maintains architectural integrity and testability.

**GOOD:**
```ts
import { config } from '../config/index.js';
const dbUrl = config.databaseUrl;
```

**BAD:**
```ts
const dbUrl = process.env.DATABASE_URL;
```

### 31.5 Never implement deferred features

**RULE:** Never implement architecture items marked FUTURE or DEFERRED unless the task explicitly promotes that item to the current milestone.

**WHY:** Prevents scope creep and maintains V1 baseline.

**GOOD:**
```text
Task: Implement refresh tokens. Agent notes this is FUTURE and asks for promotion.
```

**BAD:**
```text
Agent implements refresh tokens without explicit promotion.
```

### 31.6 Never create placeholder architecture

**RULE:** Never create empty placeholder files or directories merely because they appear in the documented architecture. Implement a component when its current implementation milestone requires it.

**WHY:** Prevents dead code and misleading structure.

**GOOD:**
```text
Agent creates src/plugins/csrf.plugin.ts only when CSRF protection is implemented.
```

**BAD:**
```text
Agent creates empty src/plugins/csrf.plugin.ts because architecture mentions it.
```

### 31.7 Run relevant tests before completing

**RULE:** Run the unit, integration, and contract tests that cover the changed area. If a test infrastructure is missing, state that explicitly rather than claiming coverage.

**WHY:** Prevents regressions and ensures quality.

**GOOD:**
```text
Agent runs: npm test, npm run typecheck, npm run lint
Agent reports: 238 tests passing, 0 failures.
```

**BAD:**
```text
Agent claims tests passed without running them.
```

### 31.8 Report failures honestly

**RULE:** If tests fail, lint fails, or typecheck fails, say so plainly. Include the command, the failure, and what you tried. Do not hide failures. Do not claim success you did not verify.

**WHY:** Transparency and trust.

**GOOD:**
```text
npm run typecheck failed with 2 errors in auth.service.ts.
Attempted fix: Added missing return type. Tests now pass.
```

**BAD:**
```text
Agent claims all tests pass when typecheck failed.
```

### 31.9 Never weaken security controls

**RULE:** Do not disable CSRF, CORS allowlists, rate limits, auth hooks, authorization checks, validation, or redaction to satisfy a test. Fix the test or the code, not the control.

**WHY:** Security controls must not be compromised for convenience.

**GOOD:**
```text
Test fails because rate limit blocks it. Agent increases test rate limit config.
```

**BAD:**
```text
Agent disables rate limiting in production code to make test pass.
```

### 31.10 Preserve backward compatibility

**RULE:** Do not remove fields, change types, rename endpoints, change status codes, or alter error codes without an explicit instruction and a new major version.

**WHY:** Prevents breaking changes for API consumers.

**GOOD:**
```text
Agent adds new optional field to response. Backward compatible.
```

**BAD:**
```text
Agent removes existing field from response without explicit instruction.
```

---

## 32. Code Review Standards

### 32.1 Architecture review

**RULE:** Changes to module boundaries, dependency direction, data model, infrastructure, or security posture require architecture review.

**WHY:** Prevents architectural drift.

**GOOD:**
```text
PR changes module boundaries. Reviewer verifies docs/architecture.md updated.
```

**BAD:**
```text
PR changes module boundaries without docs update.
```

### 32.2 Security review

**RULE:** Changes to authentication, authorization, cookie handling, JWT, password hashing, or secrets handling require security review.

**WHY:** Security bugs are invisible without careful review.

**GOOD:**
```text
PR modifies auth.service.ts. Reviewer verifies no user enumeration, no secret leakage.
```

**BAD:**
```text
PR modifies auth.service.ts without security review.
```

### 32.3 Database review

**RULE:** Changes to Prisma schema, migrations, repository queries, or transaction boundaries require database review.

**WHY:** Database changes affect data integrity and performance.

**GOOD:**
```text
PR adds new index. Reviewer verifies query pattern justifies the index.
```

**BAD:**
```text
PR adds speculative indexes without query justification.
```

### 32.4 API review

**RULE:** Changes to HTTP endpoints, request/response shapes, status codes, or error codes require API review.

**WHY:** API changes affect consumers and must follow conventions.

**GOOD:**
```text
PR adds new endpoint. Reviewer verifies it follows /api/v1 convention.
```

**BAD:**
```text
PR adds endpoint at /api/users (missing version prefix).
```

### 32.5 Test review

**RULE:** Every code change must include tests. Reviewers verify test coverage for new logic, negative cases, and security regressions.

**WHY:** Untested code is untrusted code.

**GOOD:**
```text
PR adds new service method with unit tests covering success and error paths.
```

**BAD:**
```text
PR adds new service method without tests.
```

### 32.6 Dependency review

**RULE:** New dependencies require justification. Reviewers verify no duplicates, appropriate license, and maintenance status.

**WHY:** Dependencies are liabilities.

**GOOD:**
```text
PR adds @fastify/helmet. Justification: standard security headers, maintained by Fastify org.
```

**BAD:**
```text
PR adds new dependency without justification.
```

### 32.7 Documentation review

**RULE:** Architecture changes require docs/architecture.md update. API changes require docs/api-conventions.md update.

**WHY:** Prevents drift between code and documentation.

**GOOD:**
```text
PR changes error handling. Reviewer verifies docs updated.
```

**BAD:**
```text
PR changes error handling without docs update.
```

---

## 33. Change Management Standards

### 33.1 Small changes

**RULE:** Changes that affect a single module and do not alter architecture, API contract, or database schema are small changes.

**WHY:** Small changes are easier to review and revert.

**GOOD:**
```text
Fix login validation bug in auth.routes.ts. Add test.
```

**BAD:**
```text
Refactor auth module, add new endpoint, and change database schema in one PR.
```

### 33.2 Feature changes

**RULE:** Changes that add new functionality require:
1. Architecture review (if affecting module boundaries)
2. API documentation (if adding endpoints)
3. Test coverage
4. Engineering standards compliance

**WHY:** New features must integrate cleanly.

**GOOD:**
```text
Add rate limiting to login endpoint. PR includes: code, tests, docs update.
```

**BAD:**
```text
Add rate limiting without tests or docs update.
```

### 33.3 Architecture changes

**RULE:** Changes to module boundaries, dependency direction, data model, infrastructure, or security posture require:
1. ADR (Architecture Decision Record)
2. docs/architecture.md update
3. Engineering standards review
4. Full regression testing

**WHY:** Architecture changes affect the entire system.

**GOOD:**
```text
ADR-005: Add session store. docs/architecture.md updated. Full regression tests pass.
```

**BAD:**
```text
Agent adds session store without ADR or architecture update.
```

### 33.4 Breaking changes

**RULE:** Breaking changes (removing fields, changing types, renaming endpoints, changing status codes, altering error codes) require:
1. Explicit instruction from project owner
2. New major version
3. Migration guide
4. Backward compatibility analysis

**WHY:** Breaking changes affect API consumers.

**GOOD:**
```text
V2 removes deprecated field. Migration guide documents transition.
```

**BAD:**
```text
Agent removes field without explicit instruction or version bump.
```

### 33.5 Security changes

**RULE:** Changes to authentication, authorization, cookie handling, JWT, password hashing, or secrets handling require:
1. Security review
2. Regression testing
3. Documentation update

**WHY:** Security changes affect the entire system's security posture.

**GOOD:**
```text
Change bcrypt cost factor from 12 to 14. Security review confirms no regression.
```

**BAD:**
```text
Agent changes security configuration without review.
```

### 33.6 Database changes

**RULE:** Changes to Prisma schema, migrations, or repository queries require:
1. Migration review
2. Rollback plan
3. Performance analysis
4. Test database validation

**WHY:** Database changes affect data integrity and performance.

**GOOD:**
```text
Add index on users.email. Migration reviewed, rollback documented, tests pass.
```

**BAD:**
```text
Agent adds index without migration review or rollback plan.
```

---

## 34. Production Readiness Standards

### 34.1 Test coverage

**RULE:** Production-ready code must have:
1. Unit tests for pure logic
2. Integration tests for endpoints
3. Security regression tests
4. All tests passing

**WHY:** Untested code is untrusted in production.

**GOOD:**
```text
Auth module: 92 tests covering registration, login, logout, error cases.
```

**BAD:**
```text
Auth module: 5 tests covering only happy path.
```

### 34.2 Type safety

**RULE:** Production-ready code must pass:
1. TypeScript strict mode
2. No `any` usage
3. No non-null assertions without justification
4. Explicit return types at boundaries

**WHY:** Type safety prevents runtime errors.

**GOOD:**
```text
npm run typecheck passes with 0 errors.
```

**BAD:**
```text
TypeScript errors ignored or suppressed.
```

### 34.3 Code quality

**RULE:** Production-ready code must pass:
1. ESLint with no errors
2. Prettier formatting
3. No commented-out code
4. No orphan TODOs

**WHY:** Code quality affects maintainability.

**GOOD:**
```text
npm run lint passes with 0 errors.
```

**BAD:**
```text
ESLint errors suppressed with eslint-disable comments.
```

### 34.4 Security

**RULE:** Production-ready code must have:
1. Password hashing (bcrypt cost 12)
2. JWT validation (HS256, 15-minute TTL)
3. Cookie security (HttpOnly, SameSite, Secure in production)
4. Authorization checks (deny-by-default)
5. Input validation (additionalProperties: false)
6. No secrets in logs or responses

**WHY:** Security is non-negotiable.

**GOOD:**
```text
Auth module: passwords hashed, JWT validated, cookies secured, authorization enforced.
```

**BAD:**
```text
Auth module: passwords stored in plain text.
```

### 34.5 Database

**RULE:** Production-ready code must have:
1. Prisma schema with proper constraints
2. Migrations tested
3. Repository abstraction
4. Transaction handling where needed

**WHY:** Database integrity is critical.

**GOOD:**
```text
User model: unique email, foreign key to Credential, timestamps.
```

**BAD:**
```text
User model: no constraints, no migrations.
```

### 34.6 Configuration

**RULE:** Production-ready code must have:
1. Centralized configuration
2. Zod validation at startup
3. No hardcoded secrets
4. Environment-specific defaults

**WHY:** Configuration errors cause production outages.

**GOOD:**
```text
Config validated at startup. Missing DATABASE_URL causes immediate failure.
```

**BAD:**
```text
Config validated at runtime. Missing DATABASE_URL causes mysterious error.
```

### 34.7 Documentation

**RULE:** Production-ready code must have:
1. Architecture documentation
2. API documentation
3. Engineering standards
4. README with setup instructions

**WHY:** Documentation enables onboarding and maintenance.

**GOOD:**
```text
docs/architecture.md, docs/api-conventions.md, README.md all up to date.
```

**BAD:**
```text
Outdated documentation that contradicts implementation.
```

### 34.8 Observability

**RULE:** Production-ready code must have:
1. Structured logging (Pino)
2. Error logging with context
3. Startup/shutdown logging
4. Request correlation IDs (future)

**WHY:** Observability enables debugging and monitoring.

**GOOD:**
```text
logger.error({ err, userId }, 'Login failed');
```

**BAD:**
```text
console.log('error');
```

### 34.9 Failure handling

**RULE:** Production-ready code must have:
1. Graceful shutdown (SIGINT/SIGTERM)
2. Error boundaries
3. Recovery procedures
4. Health endpoints

**WHY:** Production systems must handle failures gracefully.

**GOOD:**
```text
SIGTERM triggers app.close, Redis disconnect, Prisma disconnect.
```

**BAD:**
```text
Process killed without cleanup.
```

### 34.10 Regression validation

**RULE:** Production-ready code must have:
1. All tests passing
2. Typecheck passing
3. Lint passing
4. Build passing

**WHY:** Regressions must be caught before deployment.

**GOOD:**
```text
npm test: 238 passing, 0 failing
npm run typecheck: 0 errors
npm run lint: 0 errors
npm run build: success
```

**BAD:**
```text
Tests failing but marked as known issues.
```

---

## 35. Deferred / Future Scope

This section documents capabilities that are NOT part of V1 and must not be implemented unless explicitly promoted.

### 35.1 Authentication (Future)

- Refresh tokens with rotation and revocation
- CSRF protection for cookie-based authentication
- Email verification
- Password reset
- MFA / TOTP / WebAuthn
- Account lockout and brute-force protection
- Session persistence
- Suspicious-login detection
- Breached-password checks

### 35.2 Authorization (Future)

- Multiple roles per user (UserRoles join table)
- Role administration CRUD API
- Permission caching in Redis
- Audit logging of authorization decisions

### 35.3 Platform (Future)

- Full Redis integration (sessions, rate limiting, caching)
- Distributed rate limiting
- Request ID infrastructure
- Request context
- Centralized error mapper
- Problem-details formatter

### 35.4 API (Future)

- Swagger/OpenAPI documentation
- CORS hardening
- Helmet security headers
- API versioning (v2, v3)

### 35.5 Observability (Future)

- Sentry integration
- Metrics
- Tracing
- Advanced logging
- Audit logger

### 35.6 Infrastructure (Future)

- CI/CD pipelines
- Deployment automation
- Docker production profiles
- Production environment management

### 35.7 Business Modules (Future)

- Future business modules will be built on the V1 foundation
- Each module must follow these engineering standards
- Each module must have its own ADR if it introduces architectural changes

---

## Enforcement

- ESLint and Prettier enforce formatting, import order, and basic type rules.
- TypeScript strict mode enforces type safety.
- Module dependency direction is machine-checked by `npm run architecture:check` (ARCH-ENF-001, ARCH-ENF-005, ARCH-ENF-007; see architecture §28). Conventions that cannot be checked mechanically remain reviewer-enforced.
- No CI workflow exists yet; CI will run lint, typecheck, tests, and dependency audit when implemented (architecture §20 Future).
- PR review enforces rules not fully automatable: naming, comments, ADRs, dependency justification.
- Run `npm run architecture:check` for the automated subset; architecture §28 lists exactly what is automated versus human-review.
- AI coding agents must follow §31 (AI Coding Agent Standards).
- Deviations require a documented reason in the PR and, when architectural, an ADR.

## Precedence

1. `docs/architecture.md` (frozen architecture)
2. `docs/engineering-standards.md` (this document)
3. `AGENTS.md` (AI coding agent rules)
4. Tooling configuration (`eslint.config.js`, `tsconfig.json`, `prettier.config.js`)
5. Local team conventions

---