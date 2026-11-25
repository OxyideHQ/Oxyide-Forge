# Oxyide Forge — Production Transport Security Contract

> **Status:** Normative for production deployments.
> **Audience:** Engineers deploying an application built on Oxyide Forge.
> **Non-goals:** provider selection, certificate provisioning, edge product configuration. Those are operator choices; this document states what the edge must guarantee and what Forge guarantees in return, independent of provider.

## 1. Topology

```text
Internet
 ↓ (public HTTPS only)
Trusted TLS-terminating edge (reverse proxy / load balancer / ingress)
 ↓ (private or controlled connection; HTTP is acceptable here)
Oxyide Forge application (listens on configured HOST/PORT, plaintext)
 ↓
PostgreSQL (TLS per DATABASE_URL policy)
```

Forge never terminates public TLS itself and must not be configured to do so. The edge owns: TLS certificates and configuration, HTTP→HTTPS redirect, HSTS emission, forwarded-header hygiene, and preventing direct public access to the application port.

## 2. What Forge Assumes (and Verifies Itself)

| Assumption | Forge behavior if violated |
|---|---|
| Browser-facing traffic is HTTPS | Nothing in Forge can verify this (no proxy trust by design) — the DEPLOYMENT must guarantee it. Cookies are still marked Secure in production regardless. |
| `APP_BASE_URL` is the public origin | Validated at startup (`https://` required in production); all emailed links derive from it, never from request Host. Startup fails otherwise. |
| Database TLS per policy | `DATABASE_URL` must carry `sslmode=require` in production; startup fails otherwise. |
| Secrets provided out-of-band | `JWT_SECRET` required (≥32 chars); never read from requests, never logged. |

## 3. What Forge NEVER Trusts (Even Behind an Edge)

- `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `Origin` (for security decisions): **ignored unconditionally**. Forged values change nothing: throttle identity stays socket-derived, cookie flags stay config-derived, emailed links stay config-based, CORS allowlist stays config-based. Proven by adversarial suites (`login-throttle`, `recovery-throttle`, `transport-security` integration tests).
- `Host` header: never used for links, redirects, cookies, or CORS. There are no open redirects and no host-dependent security decisions in Forge.
- `trustProxy` is NOT configured and MUST NOT be enabled casually: doing so would convert every tested spoof-immunity guarantee into a bypass (attacker-chosen throttle identity, log identity). A deployment that needs true client IPs must implement edge-level identification OUTSIDE Forge (e.g. PROXY protocol to the edge + edge-enforced rate limiting) — never by trusting headers in-app.

### Operational consequence (documented honestly)

Behind a proxy, all clients share the edge's source address for Forge's IP-dimension throttling (30/15 min login, 30/hour recovery). The account dimension still isolates per-account attacks. Deployments expecting heavy proxied volume SHOULD enforce rate limiting at the edge; Forge's thresholds tolerate NAT sharing but not whole-internet-behind-one-IP scale. This is a capacity consideration, not a bypass: limits fail closed (429), never open.

## 4. HSTS Policy (Edge-Owned)

Forge emits **no** `Strict-Transport-Security` header in any environment (pinned by tests). Rationale: the application cannot verify browser-facing TLS (see §3 — no proxy trust by design), and static emission risks staging contamination while adding nothing where the edge is correctly configured.

The edge MUST emit HSTS for production browser-facing origins once the rollout checklist passes:

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

- `max-age`: 31536000 (one year). Shorter values (e.g. 86400) during initial rollout, then raise.
- `includeSubDomains`: include ONLY if every subdomain under the parent is HTTPS-capable. Forge cannot know a consumer's domain topology — the default recommendation INCLUDES it (full-domain assurance), but operators with HTTP-only subdomains must omit it deliberately.
- `preload`: NOT mandated. Preload is a deliberate, hard-to-reverse domain commitment (submission + months of baked-in max-age). Discuss it as opt-in with implications, never copy-paste it.

### Rollout checklist (all must hold before strong HSTS)

1. Production serves HTTPS exclusively with a valid publicly-trusted certificate.
2. HTTP→HTTPS redirect verified at the edge (no unintended public plain-HTTP app path).
3. All subdomains HTTPS-capable IF `includeSubDomains` is used.
4. No HTTP-only resources required by the served application.
5. Certificate renewal automated and monitored.
6. Staging uses a SEPARATE domain with its own policy (never inherits production HSTS).

### Environment boundary

Development (`localhost`, plain HTTP) and test: HSTS MUST NOT be emitted — browsers would pin `localhost` confusingly and edge HSTS for production domains must never leak onto staging/dev origins. Forge's app-level absence holds everywhere; the edge applies HSTS per-origin deliberately.

## 5. HTTP→HTTPS Redirect

Edge responsibility (see §1). Application-level redirects are NOT implemented in Forge, deliberately: behind proxies they cause redirect loops (app sees HTTP, redirects to HTTPS, proxy forwards HTTP again…), and transport policy belongs in one place. If the application is EVER directly exposed (against guidance), plain HTTP serves the API without redirect — which is exactly why direct exposure is forbidden (§7).

## 6. Secure Cookies Behind TLS Termination

Production cookie flags (`HttpOnly`, `SameSite=Strict`, `Secure`, host-only, scoped paths, TTL-derived Max-Age) derive SOLELY from `NODE_ENV=production` configuration — never from request protocol or headers. A TLS-terminating proxy therefore cannot weaken them (no downgrade path exists; proven by config-derivation tests + absence of any protocol read in cookie code). Requirement preserved end to end: **production cookies require browser-facing HTTPS**, which the edge guarantees (§1); `Secure` without edge HTTPS would merely make cookies unusable (fail-closed for usability, never insecure).

## 7. Direct-Access Requirement

> Production application ports MUST NOT be directly reachable from untrusted networks when the deployment assumes an upstream TLS/security edge (the only supported production topology).

Forge cannot enforce firewall rules; this is a deployment duty. Direct exposure breaks every assumption in §2 (plaintext credentials on the wire, no HSTS, no redirect) while the application keeps serving. Verify with an external port scan before and after each environment change.

## 8. Pre-Exposure Checklist

Transport: HTTPS-only public surface · valid certificate · edge HTTP→HTTPS redirect · no direct app-port exposure (scanned) · HSTS per §4 (post-checklist) · Secure cookies observed in production Set-Cookie (HttpOnly/Strict/host-only/paths). Proxy: no `trustProxy` in app (verify: grep) · forwarded headers ignored (X-Forwarded-Proto=https changes nothing — tested) · edge rate limiting considered for proxied scale. Config: `NODE_ENV=production` · `APP_BASE_URL=https://…` · DB `sslmode=require` · `JWT_SECRET` ≥32 from secret management · `CORS_ALLOWED_ORIGINS` explicit (never `*`) · startup gates pass (invalid config refuses to boot). Supply chain: dependency audit, secret scan, SAST, SBOM, release validation green. Secrets: none in repo/logs; production secrets via manager/env, never files in the artifact.

## 9. Edge Verification Procedure (External, Post-Deploy)

1. `curl -sI http://<prod-origin>/health/live` → 301/308 to `https://` (redirect at edge, never reaches app as HTTP success).
2. `curl -sI https://<prod-origin>/health/live` → 200 + `strict-transport-security: max-age=31536000…` (edge-owned; app responses carry the 4 app headers + no HSTS).
3. `curl -sI https://<prod-origin>/ -H 'X-Forwarded-Proto: http'` → identical security posture (app ignores it).
4. Login flow over HTTPS → `Set-Cookie` carries `Secure; HttpOnly; SameSite=Strict`, host-only, correct paths.
5. External port scan: application port unreachable except via edge.
6. Record outputs with the release evidence.

## 10. Environment Security Matrix

| Setting | Dev (`localhost` HTTP) | Test | Staging (edge+TLS) | Production (edge+TLS) | On violation |
|---|---|---|---|---|---|
| HTTPS required (browser-facing) | no | no | YES | YES | deployment fails review (§7 scan) |
| HSTS emitted | never (app) / no (edge) | never | per-domain edge policy | per §4 post-checklist | finding; browsers ignore HTTP HSTS anyway |
| Secure cookies | off (`Secure` false) | off | on (`NODE_ENV=production`) | on | config gate (no downgrade path exists) |
| CORS | off unless configured | off unless configured | explicit origins | explicit origins, never `*` | startup-validated allowlist |
| Proxy trust in app | none | none | none | none | tests pin spoof-immunity |
| `JWT_SECRET` | any ≥32 | test fixture | secret-managed ≥32 | secret-managed ≥32 | refuses to boot |
| DB TLS | optional | optional | `sslmode=require` | `sslmode=require` | refuses to boot |
| App security headers | always on | always on | always on | always on | suite-pinned |
| Direct app exposure | n/a (local) | n/a | FORBIDDEN | FORBIDDEN | §7 scan |

## 11. Limitations (Honest)

- Forge cannot verify edge TLS/HSTS/redirects itself — §9 is an external procedure, not automation.
- Behind a proxy, IP-dimension throttling sees the edge address (§3 tradeoff).
- Pre-pipeline router rejections (414/400-bad-URL) carry no security headers (framework emits pre-pipeline; JSON content-type, nothing logged — LOW residual, documented in audit).
- HSTS preload/subdomain mistakes can brick domains — hence edge-owned opt-in with checklist, never app-default.
