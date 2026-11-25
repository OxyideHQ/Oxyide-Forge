# Production Logging & Observability

> **Audience:** operators deploying Forge and developers building on it.
> **Authority map:** architecture → `docs/architecture.md` §15; error logging policy → `docs/error-handling.md`; API behavior → `docs/api-conventions.md`; deployment → `docs/deployment.md`. This document is operational guidance that cites those contracts — it does not restate or compete with them. Where this guide and implementation disagree, the implementation plus its contract tests govern; file a defect.

Forge emits structured JSON logs and exposes optional, NoOp-by-default
telemetry boundaries. It is **not** a log platform, SIEM, tracing
backend, or metrics server: Forge emits, the deployment environment
collects, and the customer owns storage, access, retention, and routing.

## 1. Configuration

| Variable | Values | Default | Effect |
|---|---|---|---|
| `LOG_LEVEL` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` | `info` | Minimum severity emitted. Validated at startup; anything else fails fast with exit code 1. |

No other logging knobs exist. There is no file path, rotation, remote-endpoint,
or sampling flag: the log destination is the process output stream (stdout
by default; overridable only in code via the `buildApp({ loggerStream })`
option, which changes WHERE lines go, never WHAT they contain). Redaction
cannot be disabled by configuration.

## 2. Log levels

Pino numeric severities apply (`trace` 10, `debug` 20, `info` 30, `warn` 40,
`error` 50, `fatal` 60); only messages at or above `LOG_LEVEL` are emitted.

- `trace` / `debug` — framework and dependency diagnostics. Troubleshooting
 only; never in steady-state production (verbose, and `debug` enables
 Fastify internals).
- `info` (default, recommended) — request lifecycle lines, successful
 security events, startup/shutdown notices.
- `warn` — denied/failed security outcomes, degraded-but-operational
 conditions (shutdown signals, infra warnings). Note the trade-off:
 `warn` also suppresses the `info`-level request-completion lines, so
 per-request visibility is lost.
- `error` — unexpected internal failures (exactly one line each, with the
 request ID) and fatal startup/shutdown failures. Expected client errors
 (4xx) never log at `error`.
- `fatal` — reserved for process-terminal failures during bootstrap.

Level semantics are frozen: 4xx stays below `error`; 5xx logs exactly once.

## 3. Request logging

Every in-pipeline request produces two structured lines sharing one `reqId`:

- `incoming request`: `req` = `{ method, url, remoteAddress }` where `url`
 is the path **with the query string stripped**.
- `request completed`: `res` = `{ statusCode }` plus numeric
 `responseTime` (milliseconds).

**Deliberately excluded:** request/response bodies, headers (including
`Authorization`, `Cookie`, `User-Agent`), cookies, and query values.
Query values are stripped because list endpoints read query parameters
and values may carry secrets or attacker-controlled bulk; the safe route
path is retained for diagnostics. See `docs/architecture.md` §15.

## 4. Request ID

The request ID is Forge's canonical HTTP correlation identifier
(frozen contract):

- Server-generated, opaque (`req-<base36>` per process); never a UUID,
 timestamp, user input, trace ID, database ID, or authentication ID.
- Emitted as the `X-Request-ID` response header on every in-pipeline
 response (pre-pipeline router rejections carry none, by framework
 construction).
- Referenced by Problem Details `instance` as `/requests/<id>`.
- Bound as log `reqId` on every line for the request, including error
 and security-event lines.
- Client-supplied `X-Request-ID` / `request-id` headers are never read,
 adopted, or reflected — hostile values change nothing.

It is a request ID, not a trace ID (see §5).

## 5. Trace ID

`REQUEST ID` is Forge's correlation identifier. `TRACE ID` is optional
distributed-tracing metadata. They are different values with different
jobs, and one never replaces the other.

- Inbound W3C `traceparent` is accepted **only** in exact version-`00`
 form with non-zero IDs; everything else (unknown versions, `ff`,
 all-zero IDs, uppercase, truncation, oversized, hostile, `tracestate`)
 yields no trace context — absent context, never an error.
- The context is request-scoped (`request.traceContext`), opaque,
 identity-free, and influences no decision — never authentication,
 authorization, or error mapping.
- It appears in **no** default output: not in completion lines, error
 bodies (asserted absent), or security events (frozen shapes).
- Tracing is never required: the default is silent NoOp and the
 application behaves identically with no tracing backend installed.

## 6. OpenTelemetry boundary

Forge bundles **no** OpenTelemetry Collector, SDK, exporter, Jaeger,
Datadog, Prometheus, Grafana, or any tracing backend — and requires
none. The boundary is two Forge-owned interfaces (`Tracer`/`Span` in
`src/shared/tracing/`) with a `noopTracer` default. Customers implement
the interface against their own SDK and pass it via
`buildApp({ tracer })`; business code must never import OTEL internals.
Adapter implementations must follow the privacy rules (no secrets,
PII, tokens, headers, cookies, bodies, or query in attributes) and must
never let a throwing tracer break a request.

## 7. Metrics

Three fixed instruments, backend-neutral, NoOp by default
(`src/shared/metrics/`; in-memory reference included for tests):

| Instrument | Type | Labels |
|---|---|---|
| `http.requests.total` | counter | `method`, `route`, `status` |
| `http.request.duration.seconds` | histogram (sum + count) | `method`, `route` |
| `http.errors.total` | counter (5xx only) | `method`, `route`, `status` |

- `route` is Fastify's route template (one of the frozen API paths) or
 the literal `'unknown'` for unmatched URLs — **never the raw URL**.
- `method` and `status` are server-observed values from small bounded sets.
- Forbidden as labels, without exception: user IDs, emails, request IDs,
 IPs, tokens, raw URLs, query strings. There is no parameter through
 which such values could be passed, and no custom instruments or label
 names exist.
- No per-auth-flow counters: authentication/authorization already emit
 countable security events (§8); dual instrumentation would double the
 surface for no new signal. No gauge exists (nothing justifies one).
- Recording is guarded: a throwing backend cannot fail, delay, or alter
 any request. No Prometheus compatibility is claimed; customers map the
 facade to their backend.

## 8. Security and audit events

Three categories:

- **Operational logs** — request lifecycle, startup/shutdown, unexpected
 errors. ("What happened to this HTTP request / runtime?")
- **Security events** — auth flows: `auth.login.success`,
 `auth.login.failure`, `auth.account.locked`, `auth.refresh.replay`,
 `auth.session.revoked`, `auth.sessions.revoked_all`,
 `auth.password_reset.requested`, `auth.password_reset.completed`,
 `auth.email_verification.requested`,
 `auth.email_verification.completed`. ("What
 security-relevant activity occurred?")
- **Audit/decision events** — `authorization.decision` plus the auth
 outcomes above with actor/target context: who, what, which decision,
 why, and in which request. ("Who did what to what, with what outcome?")

Event shape is allowlisted: `{ event, outcome, subjectId?, reason?,
revokedCount? }` plus ambient `reqId`/timestamp/level. Outcomes:
`success|failure|locked|replay_detected|revoked|no_session|requested`.
Reasons: `invalid_credentials|account_locked|throttled|invalid_token`.
Success is `info`; all other outcomes are `warn`; expected outcomes are
never `error`. Actors are subject UUIDs only when the account is known
without creating an oracle — unknown-account failures and
enumeration-sensitive requests carry no identifier, and logout carries
outcome only. Events are observational: emitting never alters outcomes,
status codes, bodies, or decisions, and sinks default to silent outside
HTTP requests. Security events record results; policies still decide.

## 9. Storage and retention boundary

Forge **does not persist** logs or security events. It provides no audit
database or table, no queue, no Kafka/RabbitMQ, no SIEM, and no log
storage platform. The customer owns: collection, storage, access control,
encryption in transit and at rest, retention, archival, and SIEM
integration.

No mandatory retention period is prescribed — that is an operational
policy decision, not an application contract. When setting one, weigh:
regulatory requirements, incident-response and investigation needs,
privacy and data-minimization duties, storage cost, and organizational
policy. State the chosen policy in deployment runbooks, not in Forge.

## 10. Collection model

```
Forge → stdout (structured JSON) → container/cloud/runtime logging → customer log platform
```

No vendor is required and no agent is mandated; any collector that
ingests stdout JSON works. Forge does not manage log rotation — the
deployment environment owns it. The `loggerStream` build option exists
for embedding scenarios (tests, custom transports) and changes
destination only, never content.

## 11. Access and privacy

Logs remain sensitive operational metadata even with secrets protected:
request lines carry source IPs and route paths; security events carry
account UUIDs. Customers must restrict log access to least privilege,
encrypt in transit and at rest where stored, control SIEM/platform
access, and retain only per policy. These are deployment
responsibilities — Forge provides no access-control or encryption
layer for stored logs.

## 12. Redaction and PII policy

Authoritative detail: `docs/architecture.md` §15. In brief: passwords and
hashes, all token forms, authorization/cookie credentials, secret
configuration values, and the `authorization`/`cookie`/`bearer`/`apiKey`
families are censored (`[Redacted]`) at every nesting depth if they ever
reach a logged object — while serializers omit headers, cookies, bodies,
and query so they normally have no path to logs at all. Email, display
names, and user-agents are omitted everywhere; socket IP is retained in
request lines for abuse investigation; user UUIDs appear only as request
paths or inside allowlisted security-decision fields. No speculative
variant fields are covered because they do not exist in the tree and
schemas reject unknown fields pre-handler.

## 13. Developer rules

DO: use the approved logger (`request.log` in handlers, `app.log` for
infrastructure); preserve correlation; use structured fields; use stable
event names; log meaningful operational/security events; use safe
identifiers (UUIDs, enums); follow the redaction policy; keep new event
vocabulary closed and tested.
DO NOT: use `console.*` (architecture-checked); log passwords, tokens,
cookies, headers, or bodies; log arbitrary request/user objects; spread
`...user` / `...request` / `...authContext` into events; use
user-controlled values as metric labels; bypass event allowlists; invent
ad-hoc logging systems or second redaction utilities.

## 14. Failure behavior

Observability is observational. Telemetry failure cannot change API
behavior: NoOp tracing/metrics are safe defaults, recording is guarded,
security logging never determines authorization, and logging never
replaces error handling. Startup fails fast only on invalid
configuration (including `LOG_LEVEL`); a logging-transport failure is
process-level fate, unchanged from prior milestones.

## 15. Production example

```env
NODE_ENV=production
LOG_LEVEL=info
```

Structured JSON on stdout, collected by the container runtime. No
telemetry backend required; to attach one, pass a `Tracer`/`ForgeMetrics`
implementation to `buildApp` (embedding use) — no environment variable
enables remote telemetry, by design. No secrets appear in this file or
in any example.
