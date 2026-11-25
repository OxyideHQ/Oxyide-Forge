import type { Redis } from 'ioredis';

import {
  checkPostgresHealth,
  checkRedisHealth,
  type DependencyHealth,
} from './dependency-health.js';

/**
 * Readiness aggregation (M9.2, extended M9.3).
 *
 * Sits between the route and the dependency checks so the route stays thin and
 * HTTP-free, and so the answer to "can this instance serve traffic?" is decided
 * in exactly one place. The route maps `ready` to a status code and discards
 * the rest — the dependency detail exists for logging and never for the
 * response body.
 */

/** A readiness decision plus the evidence behind it. Never serialized. */
export interface ReadinessReport {
  readonly ready: boolean;
  readonly dependencies: readonly DependencyHealth[];
  /**
   * Whether the reported decision was forced by an in-progress shutdown
   * (M9.4). Bounded and derived, so a log line can distinguish "not ready
   * because a dependency is down" from "not ready because we are going away"
   * without inspecting dependency state.
   */
  readonly draining: boolean;
}

/**
 * The application-owned clients the checks need. Passed in rather than reached
 * for, so this module creates no client of its own, holds no module-level
 * state, and stays free of any framework type. `redis` is absent exactly when
 * Redis was never configured — which is what makes "not configured" and
 * "configured but broken" distinguishable without inspecting the environment.
 */
export interface ReadinessContext {
  readonly redis?: Redis;
  /**
   * Whether shutdown has begun (M9.4). A draining instance cannot take on new
   * traffic, so it is never ready — independently of dependency health, and it
   * short-circuits the dependency checks entirely.
   *
   * It is passed in rather than read from module state so this stays the only
   * place readiness is decided, and so the value is explicit at the single call
   * site instead of being ambient.
   */
  readonly draining?: boolean;
}

/**
 * Required dependencies. Every one must report `healthy`. PostgreSQL is the
 * only member: every serving path (auth, users, roles, notes) reads or writes
 * it, so it is mandatory in every configuration (M9-F08). A required dependency
 * that reports anything other than `healthy` is never ready, which also makes
 * an unexpected `not_configured` fail closed instead of silently passing.
 */
const REQUIRED_DEPENDENCY_CHECKS: ReadonlyArray<() => Promise<DependencyHealth>> = [
  checkPostgresHealth,
];

/**
 * Optional dependencies. An optional dependency may be `not_configured` without
 * blocking readiness; only `unhealthy` blocks. This is the frozen M9.1 rule that
 * an absent optional dependency must never make an instance un-ready.
 */
const OPTIONAL_DEPENDENCY_CHECKS: ReadonlyArray<
  (context: ReadinessContext) => Promise<DependencyHealth>
> = [checkRedisHealth];

/**
 * Evaluates whether this instance can serve traffic.
 *
 * Deterministic by construction — the full truth table:
 *
 * | PostgreSQL | Redis            | Result  |
 * |------------|------------------|---------|
 * | healthy    | not configured   | READY   |
 * | healthy    | healthy          | READY   |
 * | healthy    | unhealthy        | NOT READY |
 * | unhealthy  | healthy          | NOT READY |
 * | unhealthy  | not configured   | NOT READY |
 * | unhealthy  | unhealthy        | NOT READY |
 *
 * Checks run concurrently, and each is total — it resolves to a
 * `DependencyHealth` and never rejects. That is the contract
 * `checkPostgresHealth` and `checkRedisHealth` both satisfy, and any dependency
 * added later must satisfy it too: otherwise one rejection would turn a
 * readiness failure into an unhandled error instead of the frozen `503`.
 *
 * There is no cached result and no cross-request state, so concurrent probes
 * cannot contaminate each other and a recovering dependency is observed
 * immediately (frozen M8-F03).
 *
 * **Shutdown (M9.4).** A draining instance is never ready. The dependency
 * checks are skipped entirely in that case: an instance that is going away must
 * not spend a database round-trip to learn what it already knows, and a probe
 * must not be able to report ready on the strength of healthy dependencies
 * while shutdown is in progress. The `dependencies` array is then empty, which
 * is honest — no dependency was consulted — and `draining` records why.
 *
 * | Draining | PostgreSQL | Redis            | Result    |
 * |----------|------------|------------------|-----------|
 * | no       | healthy    | not configured   | READY     |
 * | no       | healthy    | healthy          | READY     |
 * | no       | healthy    | unhealthy        | NOT READY |
 * | no       | unhealthy  | any              | NOT READY |
 * | yes      | (not checked) | (not checked) | NOT READY |
 */
export async function evaluateReadiness(context: ReadinessContext = {}): Promise<ReadinessReport> {
  if (context.draining === true) {
    return { ready: false, dependencies: [], draining: true };
  }

  const [required, optional] = await Promise.all([
    Promise.all(REQUIRED_DEPENDENCY_CHECKS.map((check) => check())),
    Promise.all(OPTIONAL_DEPENDENCY_CHECKS.map((check) => check(context))),
  ]);

  return {
    ready:
      required.every((dependency) => dependency.status === 'healthy') &&
      optional.every((dependency) => dependency.status !== 'unhealthy'),
    dependencies: [...required, ...optional],
    draining: false,
  };
}
