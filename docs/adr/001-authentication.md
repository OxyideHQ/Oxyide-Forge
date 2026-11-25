# ADR 001: Authentication Foundation

> **Status:** Accepted
> **Date:** 2026-09-19
> **Deciders:** Architecture team
> **Supersedes:** N/A

## Context

Oxyide Forge requires a secure authentication foundation to support user registration, login, and protected resource access. The authentication system must be production-oriented, testable, and extensible for future capabilities (refresh tokens, CSRF, MFA, email verification).

Key constraints:

- The starter is an open-source template — security defaults must be correct out of the box.
- Authentication and authorization are separate concerns (addressed in ADR-002).
- Redis is optional infrastructure — authentication must not depend on Redis.
- The architecture mandates a single JWT implementation and centralized configuration.

## Decision

Implement JWT-based stateless authentication with bcrypt password hashing, cookie-based browser authentication, and bearer-token API authentication.

## Authentication Mechanism

Access tokens are JSON Web Tokens (JWTs) signed with HS256. The server does not store sessions or refresh tokens in this milestone. Authentication state is derived entirely from the verified JWT claims on each request.

## JWT Implementation

`@fastify/jwt` is the single approved JWT implementation. The authentication plugin (`src/plugins/auth.plugin.ts`) owns its registration and configuration. Token service operations (`src/modules/auth/services/token.service.ts`) delegate to `app.jwt.sign()` and `app.jwt.verify()`. No independent JWT library (fast-jwt, jsonwebtoken, jose) is introduced.

### Algorithm

HS256 (HMAC-SHA256). The signing secret comes from the required, validated configuration variable `JWT_SECRET`.

### Token Lifetime

Access tokens expire after 900 seconds (15 minutes). This balances security (short-lived tokens) against usability (reasonable session duration for a starter).

## AuthContext

Successful authentication populates the request `auth` context with exactly three verified claims:

```typescript
{
 sub: string; // The authenticated user's ID
 iat: number; // Issued-at timestamp
 exp: number; // Expiration timestamp
}
```

The `AuthContext` type is declared in `src/types/auth-context.ts` as a neutral cross-layer contract: the auth plugin produces it, and infrastructure typing (`src/types/fastify.d.ts`) and consumers (authorization, routes) depend on that contract rather than on the auth module.

The context must not include roles, permissions, scopes, session IDs, or refresh-token information. Loading user entities (including roles) is a separate database operation performed by the authorization service when needed.

## Password Hashing

Passwords are hashed with bcrypt using cost/work factor 12. The `bcrypt` dependency is the sole approved password-hashing library. Passwords are never logged, and `passwordHash` never leaves the authentication module boundary.

## Registration Semantics

Registration creates a new User and Credential in a single database transaction. The service:

1. Normalizes the email (trim whitespace, lowercase).
2. Checks for an existing user with the normalized email.
3. Hashes the password.
4. Creates User and Credential records atomically.
5. Returns the public User representation.

Registration does **not** authenticate the user. No access token is issued on registration. The user must explicitly log in after registering. This is a deliberate contract choice: registration and authentication are separate operations, and conflating them would complicate future extensions (email verification, account approval workflows).

## Login Semantics

Login authenticates a user with email and password:

1. Normalizes the email.
2. Looks up the User by normalized email.
3. Looks up the Credential by User ID.
4. Verifies the password against the stored hash.
5. Signs a JWT access token.
6. Returns the access token and public User representation.

The error is identical for unknown email, missing credential, and wrong password — preventing user enumeration.

## Browser Cookie Authentication

Browser clients (detected via `Accept` header containing `text/html` or `application/xhtml+xml`) receive the access token as a server-set cookie named `accessToken`. The token is not returned in the response body for browser clients.

### Cookie Configuration

| Property | Value |
|----------|-------|
| Name | `accessToken` |
| HttpOnly | `true` |
| SameSite | `Lax` |
| Secure | `true` in production, `false` in development/test |
| Path | `/` |
| Max-Age | 900 seconds |

Cookie configuration is centralized in `config.auth.cookie` and derived from environment-aware configuration.

## API Bearer-Token Authentication

Non-browser clients (API consumers) receive the access token in the JSON login response body as `{ accessToken: string }`. The client sends it with `Authorization: Bearer <token>` on subsequent requests.

A request must not use both cookie and bearer authentication mechanisms.

## Email Normalization

Emails are normalized (trimmed of whitespace, lowercased) at the service layer before storage and lookup. This ensures consistent identity matching regardless of how the user enters their email.

## Production CSRF Startup Gate

Cookie-based authentication is available in development and test environments. In production, cookie registration is skipped if CSRF protection has not been implemented. Bearer authentication remains available so the application can start. This gate prevents accidentally enabling cookie authentication in production without CSRF protection — a critical security control.

The gate is enforced in `src/plugins/cookie.plugin.ts`. It checks `config.auth.cookie.enabled` (false when `NODE_ENV === 'production'`) and returns without registering `@fastify/cookie`. Login does not set cookies and logout does not clear cookies in that mode. This is **not** CSRF protection itself — it is a safety gate that ensures CSRF protection is implemented before cookie auth can be used in production. Full CSRF protection remains a FUTURE milestone.

## Refresh Tokens

Refresh tokens are not implemented in this milestone. The starter ships with stateless, short-lived access tokens only. Refresh token support (rotation, revocation, persistence) is an approved FUTURE extension point.

## Security Considerations

- JWT secret has no insecure default — it is a required environment variable validated at startup.
- Passwords are never logged or included in error messages.
- Invalid credentials produce a generic error message preventing user enumeration.
- Cookie flags (HttpOnly, Secure, SameSite) are set securely by default.
- Production cookie authentication is blocked until CSRF protection exists.
- The `WWW-Authenticate` header is included on all 401 responses.
- Token expiration is detected and reported with a distinct error code (`AUTH_TOKEN_EXPIRED`).

## Consequences

### Positive

- Stateless authentication scales horizontally without shared session storage.
- Single JWT implementation avoids confusion and security risks from multiple libraries.
- Cookie/bearer dual-mode supports both browser and API use cases.
- Production CSRF gate prevents accidental insecure deployment.
- Centralized configuration ensures consistent security settings.

### Negative

- No refresh-token mechanism means users must re-authenticate after 15 minutes.
- Stateless tokens cannot be revoked before expiry (acceptable for the starter; production systems may extend).
- Cookie-based auth requires CSRF protection for production use (deferred to FUTURE).

## Alternatives Considered

1. **Session-based authentication** — Rejected because it requires server-side storage (Redis or database) and adds infrastructure dependency for the starter baseline.
2. **Multiple JWT libraries** — Rejected because it creates confusion about which library to use and increases the attack surface.
3. **Implicitly authenticate on registration** — Rejected because it conflates two distinct operations and complicates future extensions (email verification, account approval).
4. **Longer token lifetime** — Rejected because 15 minutes is a widely accepted security baseline for access tokens.

## Deferred Authentication Capabilities

The following are approved extension points for future milestones:

- Refresh tokens with rotation and revocation
- CSRF protection for cookie-based authentication
- Email verification
- Password reset
- MFA / TOTP / WebAuthn
- Account lockout and brute-force protection
- Suspicious-login detection
- Breached-password checks
- Session persistence
