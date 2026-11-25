/**
 * Authorization security logging (M4.7).
 *
 * Structured, privacy-preserving telemetry for authorization decisions. The
 * helper observes decisions — it never makes them: logging failures must
 * never grant or deny access, and the payload is an explicit allowlist so
 * secrets, tokens, bodies, and headers cannot reach log output by accident.
 *
 * Design constraints (load-bearing):
 *
 * - One canonical event for authorization decisions
 *   (`authorization.decision` with a `decision` field) plus one
 *   authentication-boundary event (`authentication.subject_invalid`).
 *   Event names, reasons, and resources come from frozen server-side
 *   constants — never from request input.
 * - Field allowlist: the helper builds the exact emitted object from named
 *   scalar inputs and drops everything else. Callers cannot smuggle extra
 *   fields (including secrets) through it.
 * - Levels: denials → `warn` (security-relevant, not application errors);
 *   privileged allows → `info`. Ordinary allowed self-access is never
 *   logged (noise). Expected 401/403s are never `error`.
 * - Correlation is free: callers pass `request.log`, whose Fastify child
 *   binding already carries the request ID. No request-ID plumbing here.
 * - No I/O besides the single logger call: no DB reads, no transactions,
 *   no network, no re-evaluation of authorization. The decision is made
 *   before this helper runs.
 * - Framework-neutral: the logger is a structural `{ warn, info }` pair
 *   (satisfied by `request.log` and by test fakes). No Fastify or Pino
 *   imports — policies stay untouched and ARCH-ENF-012-clean by construction.
 */

/** Canonical security event names. Closed union — request input can never select one. */
export const SecurityEventName = {
  AUTHORIZATION_DECISION: 'authorization.decision',
  AUTHENTICATION_SUBJECT_INVALID: 'authentication.subject_invalid',
} as const;

export type SecurityEvent = (typeof SecurityEventName)[keyof typeof SecurityEventName];

/**
 * Controlled reason vocabulary. Each reason exists in code:
 * permission/role-denied guards, ownership/self-delete policy denials,
 * missing-subject rejection, and permission-override allows.
 */
export const SecurityDecisionReason = {
  PERMISSION_DENIED: 'permission_denied',
  ROLE_DENIED: 'role_denied',
  OWNERSHIP_DENIED: 'ownership_denied',
  SELF_DELETE_FORBIDDEN: 'self_delete_forbidden',
  SUBJECT_INVALID: 'subject_invalid',
  PERMISSION_OVERRIDE: 'permission_override',
} as const;

export type SecurityReason =
  (typeof SecurityDecisionReason)[keyof typeof SecurityDecisionReason];

/** Minimal structural logger. Compatible with `request.log` and test fakes. */
export type SecurityLogger = {
  warn(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
};

/**
 * Narrow input contract. Every field is an explicit scalar owned by the
 * caller from server-side state; `targetId`/`permission`/`role` are optional
 * because not every decision point has all three. Anything outside these
 * keys cannot be expressed — and therefore cannot leak.
 */
export type SecurityDecisionInput = {
  event: SecurityEvent;
  decision: 'allow' | 'deny';
  reason: SecurityReason;
  subjectId: string;
  permission?: string;
  role?: string;
  resource?: string;
  targetId?: string;
};

/**
 * Emits one structured security event. Builds the exact payload from the
 * allowlisted input (unknown fields are impossible by construction) and
 * chooses the level from the decision. Returns nothing; throws nothing of
 * its own — a throwing transport propagates like any other logger failure
 * and must never be caught into an authorization decision.
 */
export function logSecurityDecision(log: SecurityLogger, input: SecurityDecisionInput): void {
  const fields: Record<string, unknown> = {
    event: input.event,
    decision: input.decision,
    reason: input.reason,
    subjectId: input.subjectId,
  };
  if (input.permission !== undefined) {
    fields.permission = input.permission;
  }
  if (input.role !== undefined) {
    fields.role = input.role;
  }
  if (input.resource !== undefined) {
    fields.resource = input.resource;
  }
  if (input.targetId !== undefined) {
    fields.targetId = input.targetId;
  }
  if (input.decision === 'allow') {
    log.info(fields, 'authorization decision');
  } else {
    log.warn(fields, 'authorization decision');
  }
}

export const authorizationLogger = {
  SecurityEventName,
  SecurityDecisionReason,
  logSecurityDecision,
};

Object.freeze(SecurityEventName);
Object.freeze(SecurityDecisionReason);
