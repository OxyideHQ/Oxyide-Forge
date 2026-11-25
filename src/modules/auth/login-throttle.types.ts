/**
 * Login-throttle domain types (M3.14).
 *
 * Throttle state is one fixed-window counter row per throttle key. Keys are
 * namespaced, versioned, deterministic SHA-256 representations of a login
 * security dimension (account email or source IP) — raw emails and IPs never
 * reach the persistence layer. Rows expire naturally via `expiresAt`; no
 * permanent or lockout state exists here (M3.16 owns lockout).
 */
export type LoginThrottle = {
  key: string;
  failureCount: number;
  windowStartedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateLoginThrottleInput = {
  key: string;
  failureCount: number;
  windowStartedAt: Date;
  expiresAt: Date;
};
