# ADR 003: Redis Client

> **Status:** Accepted
> **Date:** 2026-09-20
> **Decision makers:** Engineering
> **Supersedes:** None

## Context

Oxyide Forge needs Redis infrastructure for future features including sessions,
refresh tokens, distributed rate limiting, and caching. Redis is optional infrastructure —
the application must function without it when `REDIS_URL` is not configured.

## Decision

Use **ioredis** as the Redis client library.

### Why ioredis

- Most widely adopted Redis client for Node.js (50M+ weekly npm downloads).
- Full TypeScript support with built-in type definitions.
- Supports Redis Cluster, Sentinel, and Lua scripting for future needs.
- Robust reconnection strategy with configurable retry.
- `lazyConnect: true` support for deferred connection.

### Alternatives considered

| Library | Reason rejected |
|---|---|
| `redis` (node-redis) | v4+ rewrite introduced breaking changes and instability; smaller community adoption than ioredis. |
| `@fastify/redis` | Wraps ioredis with Fastify integration but adds an indirection layer; the architecture requires `src/platform/cache/cache.service.ts` as the sole Redis consumer, making the Fastify wrapper unnecessary. |

## Implementation

### Architecture

```
Application modules
 ↓
platform/cache/cache.service.ts (cache operations)
 ↓
platform/cache/redis.ts (client factory, disconnect)
 ↓
ioredis
```

### Key design decisions

1. **Optional Redis:** `config.cache` is `undefined` when `REDIS_URL` is not set. The Redis plugin skips registration silently when unconfigured.

2. **Factory functions, not singletons:** `createRedisClient(url)` returns a new client instance. This avoids module-level side effects and enables clean testing.

3. **Fastify plugin lifecycle:** The `redisPlugin` creates the client, connects during startup, decorates `app.redis`, and disconnects during the `onClose` hook. ~~Connection failure during startup throws and fails the application.~~ **Amended by:** a connection failure to a *validly configured but unreachable* Redis is logged and tolerated; the client is still decorated so readiness can probe it and recovery needs no restart.

## Amendment — (2026-10-04): optional-dependency failure policy

**Supersedes** the fail-fast startup decision above and the corresponding trade-off bullet. The original rationale was that Redis would back sessions, refresh tokens, and distributed rate limiting. **Verification during found that no application code consumes Redis today** — no module imports `cache.service.ts` or reads `app.redis`; the only reference to `config.cache` outside the plugin is `config.cache.redis.url` as a redaction path. The rationale therefore rested on consumers that do not exist yet, while the cost of fail-fast was concrete and severe.

### Why fail-fast was wrong here

A process that refuses to start cannot report that it is not ready. With fail-fast, an unreachable Redis produced a **total application outage** in which `/health/ready` was unreachable — the precise failure the probe exists to make visible. That inverts the purpose of the readiness contract frozen in: an optional cache outage could take down auth, users, roles, and notes, none of which use Redis.

### Decision

Redis remains optional infrastructure. Its failure policy is now:

| State | Startup | `app.redis` | `/health/live` | `/health/ready` |
|---|---|---|---|---|
| Not configured (`REDIS_URL` unset) | normal | not decorated | `200` | unaffected by Redis |
| Configured, reachable | normal | decorated | `200` | `200` |
| Configured, unreachable | **continues** | **decorated** | `200` | `503` |

Four properties this preserves:

1. **Invalid configuration still aborts startup.** `REDIS_URL` is validated by `src/config/env.schema.ts` (`redis://` or `rediss://`, non-empty, valid URL). A malformed value fails configuration loading exactly as before. Only an unreachable *valid* server is tolerated — relaxes the connection policy, never the validation policy.
2. **A failed optional dependency never silently becomes "not configured."** The client stays decorated, so readiness distinguishes *configured but broken* from *never configured* (frozen requirement).
3. **Recovery needs no restart.** ioredis reconnects on its own and `PING` starts succeeding again; readiness observes it on the next probe.
4. **The client must carry an `error` listener.** ioredis emits `error` on every failed connect and retry, and an EventEmitter `error` with no listener is thrown as an uncaught exception. Before this amendment the plugin attached no listener, so tolerating a Redis outage would have converted a cache failure into a **process crash** — the same outcome fail-fast produced, by a different route. The listener is what actually keeps the process observable. It logs at `debug` to bound volume, since ioredis retries; the operator-facing signal is the single readiness `warn` line.

### Readiness participation

`checkRedisHealth` issues one `PING` — a constant command that observes the server, needs no key, reads and writes no application data, and is a genuine round-trip rather than a cached `client.status`. It is total: any rejection becomes `unhealthy` with the error discarded, because a Redis driver error can carry the connection URL, host, port, or credentials. It receives the existing client through a `ReadinessContext` rather than creating one, so the application still has exactly one Redis client and this module holds no state.

`DependencyStatus` gained `not_configured` so an absent optional dependency is reported honestly instead of being flattened into `healthy`. PostgreSQL remains the only **required** dependency in every configuration; a required dependency reporting anything other than `healthy` is never ready.

Full reasoning and test evidence: `docs/deployment.md` (Redis readiness) and `docs/adr/003-redis.md`.

4. **Cache service separation:** Only `cache.service.ts` interacts with the Redis client directly. Application modules consume `cache.service.ts`, never `redis.ts` directly.

### Files

| File | Responsibility |
|---|---|
| `src/platform/cache/redis.ts` | Client factory (`createRedisClient`), disconnect (`disconnectRedis`) |
| `src/platform/cache/cache.service.ts` | Cache operations (`get`, `set`, `del`, `exists`) |
| `src/plugins/redis.plugin.ts` | Fastify plugin: connect, decorate, disconnect on close |
| `src/config/types.ts` | `RedisConfig`, `CacheConfig` interfaces |
| `src/config/env.schema.ts` | Optional `REDIS_URL` validation (`redis://` or `rediss://`) |
| `src/config/index.ts` | `config.cache` built only when `REDIS_URL` is set |
| `src/types/fastify.d.ts` | `app.redis?: Redis` decoration type |

### Configuration

```
REDIS_URL=redis://localhost:6379 # optional
```

- Validated with Zod: must be a valid URL with `redis://` or `rediss://` protocol.
- Trimmed of whitespace.
- When absent, `config.cache` is `undefined` and the Redis plugin is skipped.

## Consequences

### Positive

- Redis infrastructure is available for future features without being a hard dependency.
- Clean separation between platform infrastructure and application modules.
- Testing is straightforward: mock `ioredis` at the module level.
- Application starts without Redis when `REDIS_URL` is not configured.

### Negative

- Additional runtime dependency (ioredis ~500KB).
- Redis connection failure during startup **no longer** prevents the application from starting. **Amended by.3** — see the amendment below. (Original decision: fail fast when explicitly configured.)

### Risks

- None identified for the foundation. Future milestones (sessions, rate limiting) will need to define per-feature failure behavior (fail-closed vs fail-open).
