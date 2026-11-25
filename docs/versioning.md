# Versioning & Release Policy

**Applies to:** Oxyide Forge · **Current version:** 1.0.0 (`package.json` `version`)
**Status:** ⚠️ Partially unpublished — release process and support duration are not yet defined (§7).

---

## 1. Two separate version numbers — do not conflate them

| Number | Where it lives | What it means | Changes when |
|---|---|---|---|
| **Package version** | `package.json` → `version`, `CHANGELOG.md` | The distributable you downloaded | Forge code or docs are released |
| **API version** | The URL path `/api/v1` | The HTTP contract your client code calls | Only a **breaking** API change occurs |

They evolve **independently**. A patch release does not change `/api/v1`. A breaking API change requires a new path major and *may* ship in any package version — see §4.

---

## 2. Version identifiers

[Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`, e.g. `1.0.0`.

| Part | Meaning | Trigger |
|---|---|---|
| **MAJOR** | Breaking change for customers | A documented breaking change (§4) |
| **MINOR** | Backwards-compatible addition | New endpoint, optional field, new error code, new feature that does not break existing use |
| **PATCH** | Backwards-compatible fix | Defect fix, security fix, documentation correction, dependency bump with no behaviour change |

---

## 3. What counts as compatible vs breaking

The authoritative rule is in [`api-conventions.md` §2](api-conventions.md).

**Compatible inside `v1`** — existing clients keep working:
- New endpoints
- New **optional** request fields
- New error codes for genuinely new failure modes
- Documentation and examples

**Breaking — requires a new major API version:**
- Removing or renaming an endpoint or field
- Changing a type, nullability, or meaning
- Changing a status code
- Changing the meaning of an existing error code
- Changing authentication or authorization requirements

> **`operationId` values are contractual.** Renaming one breaks generated clients even though the HTTP path is unchanged.

---

## 4. Breaking changes and deprecation

A breaking change is **not** made silently. The intended process:

1. Announce the deprecation **on the route**, which produces, automatically and together:
   - OpenAPI `deprecated: true` plus `x-deprecation-reason` / `x-deprecation-sunset` / `x-deprecation-successor`
   - HTTP `Deprecation: true`, `Sunset: …`, and `Link: <successor>; rel="successor-version"` response headers
2. The endpoint **keeps working unchanged** until its published sunset date. Deprecation never changes a status code or a response body.
3. Removal happens after the sunset date, in a new major version.

The full policy is [`api-conventions.md`](api-conventions.md) and [ADR-014](adr/014-api-versioning-deprecation-policy.md). An invalid deprecation declaration — an internal URL, a credential, a header-injection attempt, a past date — **fails at startup** rather than shipping a broken signal.

---

## 5. Bug fixes and security fixes

| Kind | Release type | Notes |
|---|---|---|
| Defect fix | PATCH | Backwards-compatible by definition |
| Security fix | PATCH | May be prioritised above ordinary defects; see [Security Reporting](security.md) |
| Defect requiring a migration | PATCH **or** MINOR | A new migration may ship; see §6 |

Fixes reach you through a **new release you download**. There is no automatic update mechanism, no update notification, and no patch channel pushed to installed copies — see §7 and §8.

**There is no guaranteed response time and no guaranteed fix interval.** A security fix may be prioritised above an ordinary defect, which is a statement about ordering, not a promise about when a fix will exist. See [Support Policy](support.md) §8.

---

## 6. Database migrations and upgrades

The workflow is fixed and safe by design:

```bash
npx prisma migrate deploy   # apply pending migrations
```

- **Migrations are never applied automatically** at application startup, by the container, or during deployment of a multi-replica service. The application never migrates.
- Deployments run migrations as a **single pre-deploy step** before the new version serves traffic (see `render.yaml` / `fly.toml`).
- **Never use `prisma migrate dev` or `prisma migrate reset` on a database you care about.** Both can destroy data. `migrate dev` may prompt to reset the database when it detects drift.

### Before upgrading

1. **Back up your database.** Always. Migrations are not automatically reversible.
2. Read the release notes in `CHANGELOG.md` and check whether a migration is included.
3. Apply with `npx prisma migrate deploy` — never `reset`.
4. If a migration fails partway, do **not** re-run it blindly and do **not** reset. Follow [Rollback & Recovery](rollback-recovery.md).

Migration compatibility across API versions is **not guaranteed**: a version that moves the schema may break a client written against an older contract. Check the changelog before every upgrade.

---

## 7. Release process

**Distinguish what exists from what is intended.**

| Capability | Status |
|---|---|
| Semantic Versioning convention | **In use** — `CHANGELOG.md` follows SemVer |
| `CHANGELOG.md` maintained | **Yes** — exists, currently at v1.0.0 |
| Automated publishing on tag | ⚠️ **Not verified** — a release workflow exists in the repository but has not been exercised against a live release |
| Signed releases / provenance attestations | **Not implemented** |
| Reproducible builds | **Not implemented and not claimed** |
| Automated artifact verification by customers | **Not implemented** |
| Published release notes beyond `CHANGELOG.md` | **Not implemented** |

### Support duration

Oxyide Forge is distributed under the MIT License. No purchase or subscription is required, and no support duration, maintenance window, or update schedule is guaranteed.

See [Updates & Maintenance](updates.md) for the update policy.

### Release cadence

No release schedule has been committed. Oxyide may publish updates, patches, bug fixes, security fixes, documentation updates, and new versions, but is not obligated to do so.

**"Next release" means a version that has not been decided or scheduled.** No committed cadence exists.

### Undefined: support duration

No fixed support duration or end-of-life date is defined. Each distributed version is available under the MIT License.

### Undefined: release cadence

No release schedule has been committed. No schedule is promised.

---

## 8. Distribution artifact identity

A release is a ZIP containing the source tree at a stated `package.json` `version`.

To identify what you have:

```bash
node -p "require('./package.json').version"
```

> **Packaging caveat ⚠️ — important.** The packaging script currently copies **working-tree contents** for tracked paths rather than the committed Git blobs. Until that is corrected, an artifact may contain local uncommitted modifications to files that are otherwise tracked. **Verify your artifact before relying on it** — do not assume a shipped file matches a committed revision. See [Versioning & Release Policy](versioning.md) and the open packaging-integrity item tracked in the project roadmap.

---

## 9. Identifying your version

```bash
# package version
node -p "require('./package.json').version"

# what the API contract says — independent of the package version
curl http://localhost:3000/openapi.json | head -20
```

`CHANGELOG.md` records what changed in each released version.

---

## 10. Related documents

- [Support Policy](support.md) — what is supported, and response expectations
- [Compatibility Policy](compatibility.md) — what is actually tested
- [Security Reporting Policy](security.md) — reporting a vulnerability
- [`api-conventions.md`](api-conventions.md) — authoritative versioning and compatibility contract
- [ADR-014](adr/014-api-versioning-deprecation-policy.md) — versioning and deprecation decision record
- `CHANGELOG.md` — release notes (source checkout only; release history is not published in the customer ZIP)
- [Release Contract](release-contract.md) — gates a release must pass
