# ADR 014: API Versioning, Compatibility, and Deprecation Policy

> **Status:** Accepted
> **Date:** 2026-10-03
> **Decision makers:** Engineering
> **Supersedes:** None (implements the placeholder contract in `docs/api-conventions.md` §2)
> **Milestone:**

## Context

The API is versioned by URL (`/api/v1`) and its surface is now fully published
through the OpenAPI document built in. Two things were missing:

1. **A stated promise.** Nothing told a consumer, or a contributor, what
 stability `/api/v1` carries, what counts as a breaking change, or what a
 deprecation looks like. `api-conventions.md` §2.4 existed only as a
 "Future" placeholder.
2. **A mechanism.** No route could express deprecation, so a future
 deprecation would have required inventing signalling at the moment it was
 first needed — under time pressure in a production context.

The milestone had to produce a durable contract without turning the codebase
into an API-management platform, and without touching frozen behaviour.

## Decision

### 1. URL-based major versioning, deliberately simple

`/api/v1` remains the only version surface. No version headers, no
negotiation, no resolver, no minor URL versions, no gateway.

The major version is a **compatibility contract, not a release number**.
Package semver and the API major version evolve independently: `2.0.0` does
not imply `/api/v2`, and `/api/v2` is created only by an explicit breaking
change decision. This is deliberately *not* enforced by centralising the
version into a constant — a constant invites indirection the strategy
rejects, and the URL prefix is already grep-able and reviewable.

### 2. Route-owned deprecation metadata as the single source of truth

One object on the route schema:

```ts
deprecation: { deprecated: true, reason, successor?, sunset? }
```

Two consumers read it, and nothing else does:

- the documentation plugin's existing `transform` hook derives
 `deprecated: true` and `x-deprecation-*` extensions;
- a per-route `onSend` hook emits `Deprecation`, `Sunset`, and `Link`.

No database table, no registry file, no configuration switch, no second
OpenAPI document, no post-generation JSON patching beyond the transform hook
that already existed.

### 3. Deprecation is signalling, never behaviour

A deprecated operation keeps serving traffic with **identical** status codes,
bodies, headers, authentication, and authorization. Deprecation adds
`Deprecation: true` (RFC 9745), `Sunset` when a date exists (RFC 8595), and
`Link: <successor>; rel="successor-version"` (RFC 8288). No new status code,
no error envelope, no interaction with the frozen error contract.

Active operations carry **no** `deprecated` key at all — absence, not
`false` — so the document can never imply a state that does not exist.

### 4. Per-route hook, not global middleware

The `onSend` hook is installed **only** on routes that declare deprecation.
The 17 current operations therefore execute no additional hook, there is no
global middleware to reason about, and the mechanism cannot affect an
unrelated response. This was chosen over a global hook precisely because no
route is currently deprecated and a global hook would be speculative cost
with speculative risk.

### 5. Metadata is validated as untrusted input

Route metadata is code, but it becomes a **published response header**, so it
is validated at registration and rejects: control characters (header
injection), absolute/protocol-relative URLs, userinfo, query strings and
fragments in `successor` (internal-host, credential, and token leakage), past
or unparseable `sunset` dates, unknown fields, and over-length values. Failure
is loud at startup — a partially-signalled deprecation is worse than none.

### 6. No fixed minimum notice period

Each deprecation states its own removal target. The contract fixes the
*rules* (a sunset date is mandatory, the operation survives until that date,
security emergencies are a recorded exception) but not a universal number,
because a minimum notice period is a project policy decision and this milestone
has no product input authorising one.

## Alternatives considered

- **Header-based versioning (`Accept-Version`).** Rejected: adds negotiation
 state, breaks naive caches and CDNs, and makes the contract invisible in a
 URL. URL versioning stays.
- **A version resolver abstraction.** Rejected: there is exactly one version.
 An abstraction with one implementation is indirection without capability.
- **A deprecation registry (JSON/YAML or database table).** Rejected: creates
 a second source of truth that can disagree with the route definition — the
 exact failure 's generation strategy was designed to eliminate.
- **Configuration-driven deprecation** (`DEPRECATED_ROUTES=...`). Rejected:
 makes a security- and contract-relevant state changeable at deploy time,
 outside code review, and allows environment-specific API contracts.
- **Global `onSend` middleware emitting deprecation headers.** Rejected:
 speculative with zero current consumers, and it would run on every response
 including errors and health probes.
- **Emitting headers unconditionally** ("Sunset: always far future"). Rejected:
 would be false signalling on 17 active operations.
- **Deprecating an endpoint to demonstrate the mechanism.** Rejected: it would
 publish a lie in the customer-facing document. The mechanism is proven with
 isolated fixtures instead.
- **Structured `Deprecation: @<timestamp>`.** Deferred: valid per RFC 9745 but
 requires a declaration timestamp, which would be a second source of truth
 able to silently disagree with git. The boolean form is used; revisit when
 release timestamps are formally recorded.
- **A versioning/deprecation library.** Rejected: three headers and one
 validator; a dependency would add supply-chain surface for no capability.

## Consequences

- Consumers get an explicit stability promise and standard, machine-readable
 deprecation signalling.
- Contributors have a classification rule (§2.3/§2.4) that must be applied in
 the change description before review.
- `operationId` is promoted to a contractual artefact; renaming one is now a
 breaking change.
- Adding the first real deprecation is a two-line route change, not a project.
- Zero new dependencies; 's generation strategy and the frozen error
 contract are untouched.
- The published document and runtime headers cannot disagree, because both are
 derived from the same object.
