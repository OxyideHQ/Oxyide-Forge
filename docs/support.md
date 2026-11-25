# Support Policy

**Applies to:** Oxyide Forge open-source project · **Product version:** 1.0.0
**Status:** ⚠️ **Partially published — support channels confirmed by owner; automated verification from this environment carries limitations (see §2.1).**

---

## 1. Read this first — what is and is not settled

This policy describes support available for Oxyide Forge. Support is best-effort and is not part of the MIT License.

| Topic | Status |
|---|---|
| What support covers | **Published** (§3) |
| What is excluded | **Published** (§4) |
| How to prepare a report | **Published** (§5) |
| How to handle secrets and personal data | **Published** (§6) |
| Triage and prioritisation | **Published** (§7) |
| Response-time expectations | **Published as an honest non-commitment** (§8) |
| **Where to send a report** | **✅ Owner-confirmed: `https://www.oxyide.com/support` portal and `support@oxyide.com` email** |
| Support duration / maintenance window | **❌ NOT DEFINED — see §9** |

> **Do not treat this document as an SLA.** There is no guaranteed response time, no guaranteed resolution time, and no guaranteed support duration. Anyone quoting one back to you is mistaken.

---

## 2. Support channels

Two channels are designated for customer support. **The owner confirms both channels are operational.** [Owner confirmation] Automated probes from this environment encounter a Cloudflare bot-management challenge that structurally blocks all paths identically — this is not a defect, but limits independent verification (see §2.1 and §2.2).

Project questions and issue reports may use the channels below. No purchase, download-entitlement, or refund process applies to this MIT-licensed software.

| Channel | Destination | Status |
|---|---|---|
| **Support portal** | `https://www.oxyide.com/support` | **Designated.** Not independently verified — see §2.1 |
| **Support email** | `support@oxyide.com` | **Designated.** Domain mail exists; mailbox not independently verified — see §2.2 |

**Which to use.** Prefer the **portal** for anything that needs a record, a thread, or attachments — it is the intended home for ticket history. Use **email** for short questions, or when the portal is unreachable. Both reach the same support function; you do not need to send the same report twice.

### 2.1 Portal — verification status

`https://www.oxyide.com/support` is the **canonical** support destination. Do **not** use `https://www.oxyide.com/dashboard/support` — that path is not the support route. Do not use `dev.oxyide.com` for support.

**What was verified during preparation of this policy:**

- The domain resolves and is served behind a CDN/WAF.
- An automated probe of `/`, `/support`, `/dashboard/support`, and a known-nonexistent path all returned the **same** HTTP 403 challenge page, byte-for-byte equivalent in structure. **This is a bot-management challenge, not a response from the application**, and it is identical for every path — so it is **no evidence** about whether `/support` exists in the deployed frontend.

**What was NOT verified:** that `/support` renders a real support page rather than a placeholder; that a visitor can reach a ticket form; that the route is present in the current production deployment. **A 200 OK alone would not have been sufficient** — a catch-all router returns 200 for any path, which is exactly the failure mode this check exists to catch.

**Owner confirmation (from the product owner):** `https://www.oxyide.com/support` is the intended production support portal and works when the relevant server is running. This is an owner-provided fact, distinct from the automated probe evidence above — the probe above still encounters a Cloudflare challenge that structurally blocks all paths identically.

**Consequence:** treat the portal as the **designated** route. If it does not load for you, use email (§2.2) and note that the portal could not be confirmed.

### 2.2 Email — verification status

`support@oxyide.com` is the designated support address.

| Aspect | Status |
|---|---|
| Domain mail infrastructure | **Verified** — `oxyide.com` publishes MX records pointing at a commercial mail provider |
| `support@oxyide.com` mailbox provisioned | **Unverified** — an MX record for the domain does not prove this specific address exists |
| External delivery to that address | **Unverified** — no authorized test message was sent |
| A human monitors the inbox | **Unverified** — this cannot be established without sending mail and receiving a reply |

**Owner confirmation (from the product owner):** `support@oxyide.com` is operational and monitored. This is an owner-provided fact, distinct from the MX/infrastructure evidence above — the MX record proves the domain can receive mail, but the owner's confirmation addresses mailbox provisioning, delivery, and monitoring.

**Do not assume the mailbox is monitored.** If you send something important, allow for the possibility of no response, and keep your own copy of anything you send.

### 2.3 What this means for you

- Use the **portal** as the primary route and **email** as the alternative.
- If neither produces a response, that is consistent with the current unverified status — it is not evidence you did something wrong.
- **This is a release-readiness gap, not a documentation omission.** Confirming both channels is an owner action; see §9.

---

## 3. What support covers

Included, to the extent the product is at fault:

| Area | Examples |
|---|---|
| **Installation** | `npm run setup` (or `bash setup.sh` on Unix) failing, `npm ci` errors, Prisma Client generation, applying migrations on first run |
| **Configuration** | Startup validation errors naming an environment variable; `DATABASE_URL` / `JWT_SECRET` / SMTP / CORS rules |
| **Documented behaviour** | A documented command or endpoint not behaving as the documentation states |
| **Defects in the platform layer** | Authentication, authorization, error envelope, health probes, OpenAPI generation, graceful shutdown |
| **Architecture rules** | `npm run architecture:check` reporting a false positive, or the documented layering being unclear |
| **Packaging** | The delivered ZIP missing files the documentation tells you to use |

---

## 4. What support does **not** cover

This is a foundation, not an application. The following are **your work**, and issues in these areas are not product defects:

| Excluded | Why |
|---|---|
| **Your business logic** | Forge ships no domain features. `notes` is a worked example, not a product module |
| **Generated module skeletons** | `scripts/gen-module.mjs` emits a repository *port* whose methods deliberately throw "not implemented yet". Finishing it is yours |
| **Your schema and migrations** | Adding models, designing data, and writing migrations is yours. Forge's 8 models are a starting point |
| **Third-party infrastructure** | Render, Fly.io, your cloud provider, managed PostgreSQL, Redis, your DNS, your email provider, your DNS and TLS termination |
| **Live deployment debugging** | No platform has ever been deployed from this repository (see §10) |
| **Production operations** | Incident response, capacity planning, backup schedules, monitoring staffing, on-call |
| **Performance tuning at scale** | Load testing, indexing strategy, connection-pool sizing for your workload |
| **Security assessment of your deployment** | No penetration test has been performed. See §10 |
| **Customisation of frozen architecture** | Breaking the documented layering is possible but means the documented architecture guarantees no longer apply |
| **Environments other than the one tested** | See [Compatibility](compatibility.md) |

---

## 5. How to prepare a good report

Most reports are answerable without a reply if you include the following.

### 5.1 Required

| Item | How to get it |
|---|---|
| **Forge version** | The `version` field in `package.json` |
| **What you did** | Exact commands, in order |
| **What you expected** | And what actually happened |
| **The error** | Verbatim, not paraphrased |
| **Environment** | `node --version`, `npm --version` |
| **OS / platform** | e.g. Linux 5.x, macOS 14, Windows 11 + WSL2 |
| **Deployment mode** | Local `npm run dev`, Docker, Compose, Render, Fly, other |

### 5.2 Reproduction

Smallest sequence that reproduces it. If it only fails with a populated database, say so — integration suites truncate tables, so an empty database may not reproduce your case.

### 5.3 Configuration shape — redact before sharing

Never paste your `.env`. Report the **shape**, not the values:

```
NODE_ENV=production
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB?sslmode=require
JWT_SECRET=<32+ chars, redacted>
HOST=0.0.0.0
PORT=3000
```

### 5.4 Logs

Startup and failure logs are structured JSON (Pino). Share the relevant lines, not the whole log.

```bash
npm run dev 2>&1 | grep -iE "error|fatal" | head -20
```

---

## 6. Handling credentials and personal data in reports

**Never include any of the following — in a report, a screenshot, a paste, or an attachment:**

- `JWT_SECRET` or any real credential
- A `DATABASE_URL` containing a real username or password
- `SMTP_PASSWORD`
- Real customer data, real emails, or production records
- Session cookies, bearer tokens, or refresh tokens
- Cloud provider keys or connection strings

Redact before sharing. If a secret was exposed, **rotate it immediately** — a redacted report sent after rotation is still useful, and an exposed secret is not recoverable by editing history.

If your logs contain sensitive data, capture only the lines relevant to the failure.

---

## 7. How reports are handled

| Type | Typical handling |
|---|---|
| **Bug** | Reproduced → confirmed → fixed in a future release, or closed with an explanation. See [Versioning & Release Policy](versioning.md) for how fixes reach you |
| **Usage question** | Usually answered by documentation; the gap may be filled in the docs |
| **Documentation error** | Treated as a defect. If documentation and code disagree, the code is authoritative and the docs get corrected |
| **Feature request** | Recorded and considered. Not a commitment. Forge's scope is a *foundation*; most product features are deliberately out of scope |
| **Out of scope** | Explained, with a pointer to what would need to change. Not treated as a defect |

There is no public roadmap commitment for feature requests. A feature being recorded is not a promise that it will be built.

---

## 8. Response expectations — honest statement

**There is no guaranteed response time, no guaranteed resolution time, and no guaranteed availability.**

What can honestly be said:

- Oxyide Forge is maintained as an open-source project. It is not operated as a staffed support desk.
- Support is provided **as capacity allows**, prioritised by severity: a security issue and a total-installation failure outrank a question or a feature request.
- A report may be closed without a code change if it is a documentation gap, an unsupported environment, or out of scope (§4).
- **No response is owed within any particular interval.** Treat this as best-effort, not a service level.
- Operating reality, stated descriptively and not as a commitment: requests are read on Indian business days (IST, UTC+5:30), as capacity allows. Naming the working days promises neither a reply on any given day nor any response interval — the non-commitment above applies unchanged.
- Updates and fixes are not guaranteed; see [Updates & Maintenance](updates.md) and §9.

If your deployment depends on a guaranteed response window, this product is not a fit for that requirement — buy support from someone who sells it explicitly.

---

## 9. Support duration

The MIT License does not define or guarantee a support duration. Oxyide provides no guaranteed maintenance period, response time, or update schedule.

Copies and versions remain governed by the MIT License. Users may modify and redistribute copies under that license; future versions and fixes are not promised. See [Updates & Maintenance](updates.md).

---

## 10. Deployment and security verification status — stated plainly

| Area | Status |
|---|---|
| Local test suite | **Verified** — see the release documentation |
| Docker image build and runtime behaviour | **Verified locally** on Linux |
| Live Render deployment | **NOT TESTED** — no platform account was ever available |
| Live Fly.io deployment | **NOT TESTED** — same |
| Grafana / Prometheus integration | **NOT TESTED** against live services |
| Third-party penetration test | **NOT PERFORMED** |
| Security audit | Internal audit during development only — **not** an independent assessment |

If you require a deployment path that has been proven against a live platform, or an independent security assessment, this product does not currently provide either. Please establish that before relying on it commercially.

---

## 11. Services

The MIT License grants rights to use the software; it does not create a services contract.

Not included, and not offered by this document:

- Custom development or consulting
- Migration of your existing application onto Forge
- Paid support retainers or response-time commitments
- Architecture review of your deployment
- On-call or incident-response services
- Warranty, uptime commitment, or service credits

No paid service is offered or promised by this policy.

---

## 12. Related documents

- [Versioning & Release Policy](versioning.md) — how fixes and updates reach you
- [Compatibility Policy](compatibility.md) — what is actually tested
- [Security Reporting Policy](security.md) — reporting a vulnerability
- [Troubleshooting](troubleshooting.md) — self-service fixes
- [Deployment](deployment.md) — deploying the application
- `LICENSE.txt` — licence terms
