# Security Reporting Policy

**Applies to:** Oxyide Forge · **Current version:** 1.0.0
**Status:** ⚠️ **Partially unpublished — secure reporting channel confirmed by owner; details in §2.**

---

## 1. Security posture — state the facts first

Forge ships with real security controls. It also has real limits. Both matter.

**Implemented and covered by the test suite:**

- Password hashing with bcrypt (cost 12); passwords are never logged or returned
- JWT access tokens (HS256, 15-minute TTL); `JWT_SECRET` required, no insecure default
- Refresh tokens stored only as a SHA-256 hash; single-use rotation; replay invalidates the session family
- Cookie flags: HttpOnly, SameSite `strict`, Secure in production
- Authorization resolved server-side; deny-by-default; 401 vs 403 distinguished
- `additionalProperties: false` on request schemas
- Strict startup configuration validation with no silent insecure defaults
- Centralised error handling that sanitises unexpected failures
- Always-on security headers; strict opt-in CORS
- Login and recovery throttling; temporary account lockout
- Production cookie authentication **blocked** until CSRF protection exists

**Explicitly not implemented:**

- CSRF protection for cookie-based authentication
- MFA / TOTP / WebAuthn
- General or distributed rate limiting (login and recovery throttling only)
- Content-Security-Policy (a deliberate decision — this is a JSON API with no browser-rendered content)
- Durable email delivery

> **Cookie-based authentication is disabled in production.** It is blocked at startup until CSRF exists. Bearer-token authentication remains available. This is intentional and is documented rather than hidden.

---

## 2. Reporting channel

**Designated route: `support@oxyide.com`** — the same address as general support ([Support Policy](support.md) §2.2).

**Status: designated and owner-confirmed as operational and monitored.** [Owner confirmation] The domain publishes MX records for a commercial mail provider. The owner confirms `support@oxyide.com` is operational and monitored. [Owner confirmation — see Support Policy](support.md) §2.2 for the evidence and the exact distinction.

**Why this is not a "confidential security reporting" channel** (from [Support Policy](support.md) §2.1): Be clear about what you are getting. `support@oxyide.com` is a **normal customer-support address**. Unless and until the vendor publishes a dedicated, access-controlled vulnerability-reporting process with stated handling, **a support ticket is not confidential security reporting.**

In particular, do **not** assume:

- That your report is handled under a non-disclosure or embargo process
- That it is routed to a security specialist rather than general support
- That it is kept private from other customers
- That you will be credited or notified when a fix ships

If you need those guarantees, **this product does not currently provide them**, and you should not send sensitive detail on the assumption that they exist.

### 2.2 What to do

1. **Send to `support@oxyide.com`** with a clear subject indicating a security report.
2. **State explicitly** that you are reporting a potential vulnerability and that you have not published it.
3. **Ask for confirmation of receipt** — and treat silence as "not confirmed", not as "received".
4. **Do not include** exploit code that is ready to run against a live system, credentials, or customer data. A precise description of the weakness and how to trigger it is enough.
5. **Do not publish** anything until the vendor has had a reasonable opportunity to respond and remediate.

### 2.3 Required before this can be called a disclosure process

A genuine vulnerability-disclosure process needs, at minimum:

1. A **dedicated, access-controlled** channel (not a general support inbox).
2. A **stated handling process** — who sees it, how it is triaged, how reporters are updated.
3. A **named contact or team** accountable for it.

**None of these is verified today.** Until they exist, this section describes an *intended* route, not an operational process.

---

## 3. What to include in a report

| Item | Why |
|---|---|
| **Type** — injection, auth bypass, secret exposure, DoS, etc. | Prioritisation |
| **Affected version** | `node -p "require('./package.json').version"` |
| **Location** — file, route, or configuration | Reproducibility |
| **Reproduction steps** | The most important field |
| **Impact** — what an attacker gains | Prioritisation |
| **Environment** | Node/PostgreSQL versions, deployment mode |

A good report is one the maintainer can reproduce without asking follow-up questions.

---

## 4. Never include secrets or customer data

**Do not send, in any form:**

- `JWT_SECRET`, `SMTP_PASSWORD`, or any credential
- A `DATABASE_URL` containing a real username or password
- Session cookies, access tokens, or refresh tokens
- Cloud provider keys
- Real customer data, real email addresses, or production records
- A full `.env` file

**Redact before sending.** If a credential was exposed — in a report, a log, a screenshot, or a commit — **rotate it immediately**. Editing history does not un-expose a secret.

Reports may be handled over plain email; treat anything you send as potentially retained. Never include material you would not want stored.

---

## 5. What happens after a report

**Stated as a process, with no invented timing:**

| Stage | What happens |
|---|---|
| **Acknowledgement** | Receipt is not guaranteed within any particular interval — see §6 |
| **Investigation** | Reproduced, assessed for severity and impact, and confirmed or rejected |
| **Remediation** | A fix is developed and released. **No remediation deadline is promised** |
| **Disclosure** | At your request, details may be disclosed after a fix ships. Timing is agreed case by case |

> **No fixed remediation window is promised, and no response time is guaranteed.** Do not plan around one.

**Severity influences priority, not a guaranteed clock.** An issue that allows authentication bypass, secret exposure, or unauthenticated data access is treated as materially more urgent than a hardening suggestion. That is a statement about ordering, **not** a service level.

---

## 6. Honest statement of expectations

- Oxyide Forge is maintained as an open-source project, **not** as a staffed security response team.
- **No response time is guaranteed.** No acknowledgement interval, no remediation deadline, no turnaround.
- Support is best-effort and prioritised by severity — see [Support Policy](support.md) §8.
- **There is no bug-bounty programme and no financial reward for reports.**
- Reports are handled in good faith and are not published without your agreement.

If your organisation requires a contractual vulnerability-disclosure process or a guaranteed remediation window, **this product does not currently provide one** and you should not assume otherwise.

---

## 7. Responsible disclosure

If you discover a vulnerability:

1. **Report it** through a confirmed channel (§2 — none exists yet).
2. **Give a reasonable opportunity to fix** before public disclosure.
3. **Do not access data you do not own**, test against production systems you are not authorised to test, or degrade service for others.

Please avoid deliberately disrupting live deployments, exfiltrating data, or using social engineering against users. These actions are outside what is needed to demonstrate a vulnerability and can have legal consequences for you.

---

## 8. What customers must do

Forge's security controls protect the code as shipped. **Most real-world compromises are deployment or operational mistakes**, not library vulnerabilities. Before going to production:

- [ ] Generate a unique `JWT_SECRET` (≥ 32 chars) — never reuse the example value
- [ ] Use `sslmode=require` in production (the app enforces this)
- [ ] Set `APP_BASE_URL` to an `https://` URL
- [ ] Terminate TLS properly and follow [Transport Security](transport-security.md)
- [ ] Keep `.env` out of version control
- [ ] Restrict `CORS_ALLOWED_ORIGINS` to the bare origins you actually need
- [ ] Never run `prisma migrate dev` / `migrate reset` against a database you care about
- [ ] Apply migrations as a single pre-deploy step, with a backup taken first
- [ ] Gate traffic on `/health/ready`, not on container state
- [ ] Rotate any secret that has ever appeared in a log, a report, or a commit

See [Troubleshooting](troubleshooting.md) and [Deployment](deployment.md) for the operational detail.

---

## 9. Supply chain

| Control | Status |
|---|---|
| Dependency audit (production scope) | **Implemented** — `npm run security:dependencies` |
| Secret scanning | **Implemented** — `npm run security:secrets` (gitleaks) |
| Static analysis | **Implemented** — `npm run security:sast` |
| SBOM generation | **Implemented** — CycloneDX, `npm run security:sbom` |
| Signed releases / attestations | **Not implemented** |
| Reproducible builds | **Not implemented and not claimed** |

Full policy: [Release Contract](release-contract.md).

---

## 10. Known unverified areas

| Area | Status |
|---|---|
| Third-party penetration test | **NOT PERFORMED** |
| Independent security audit | **NOT PERFORMED** — only an internal development audit |
| Live deployment on a hosting platform | **NOT TESTED** — no platform account was ever available |
| Native module on non-Linux/x86_64 platforms | **UNVERIFIED** — see [Compatibility](compatibility.md) §7 |

**This product has not been independently security assessed.** Do not represent it as penetration-tested or certified. If your compliance regime requires such evidence, this product does not currently provide it.

---

## 11. Related documents

- [Support Policy](support.md) — scope and response expectations
- [Versioning & Release Policy](versioning.md) — how fixes reach you
- [Compatibility Policy](compatibility.md) — verified vs declared
- [Transport Security](transport-security.md) — TLS boundary and cookie contract
- [Production Logging](production-logging.md) — redaction and security events
- [Release Contract](release-contract.md) — supply-chain gates
- `LICENSE.txt` — licence terms
