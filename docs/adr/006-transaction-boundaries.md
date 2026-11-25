# ADR 006: Transaction Boundary Ownership

> **Status:** Accepted
> **Date:** 2026-09-26
> **Decision makers:** Engineering
> **Supersedes:** None

## Context

Audit finding ARCH-04 identified contradictory wording in
`docs/engineering-standards.md`: §15.1 ("Only repositories call Prisma") read
oppositely from §16.1 ("only services open transactions"). The implemented code
is unambiguous and correct — `auth.service.register` and `users.service.remove`
each own an interactive `prisma.$transaction`, and repositories accept an
optional `Prisma.TransactionClient` (`tx ?? prisma`) — but the standards did
not state which layer owns the transaction boundary, and no ADR covered the
decision.

The transaction model must also accommodate cross-module atomicity established
in: user deletion spans the Users and Auth modules (Credential must be
deleted before User because of `ON DELETE RESTRICT`), so the transaction client
has to cross a module service boundary without losing atomicity.

## Decision

**Business transaction boundaries are owned by the service/use-case layer.**
Services open transactions with `prisma.$transaction`. Repositories own
query/mutation execution and never open their own transactions; they accept an
optional transaction client and use it for their operation when one is
provided. All persistence operations that must be atomic for one business
operation receive the same transaction client, threaded explicitly through
public service boundaries when crossing modules (Users service → Auth
`credentialService` → Auth credential repository, same `tx`).

Repositories participating in a transaction propagate unexpected database
errors to the owning service so the transaction rolls back; only the documented
not-found outcome (Prisma `P2025`) is converted to a `false`/`null` result.
Transaction clients are function-scoped and never stored on services,
singletons, or globals. Nested independent transactions are not introduced: an
inner service receives the outer transaction client. Transactions contain
database work only (no external I/O) and run with Prisma/PostgreSQL default
isolation and timeouts.

## Consequences

### Positive

- One rule resolves the §15.1/§16.1 contradiction: repositories own
 persistence implementation; services own the transaction boundary.
- Cross-module atomic operations (register, user removal) commit or roll back
 as a single business unit, with module ownership preserved.
- Database failures inside a transaction can no longer be silently converted
 into committed partial results.

### Negative

- Services import the Prisma client solely to open transactions. This is
 explicitly sanctioned by §16.1; queries still live only in repositories.
- A repository no longer masks arbitrary failures as `false`, so unexpected
 database errors surface as 500s instead of a misleading 404 for user
 deletion. This is the intended behavior.

### Risks

- If unit-of-work/transaction-context infrastructure is later introduced
 (architecture §10, Future), it must implement this same ownership rule and
 supersede the direct `prisma.$transaction` calls, not change who owns the
 boundary.

## Alternatives Considered

- **Repository-owned transactions** — rejected: repositories are per-entity
 and too granular; cross-entity and cross-module atomicity would require
 repositories to coordinate each other or to nest transactions.
- **Literal §15.1 ("only repositories call Prisma"), moving `$transaction`
 into repositories** — rejected: breaks the cross-module use case, inverts
 ownership toward persistence details, and contradicts §16.1 and
 `docs/auth.md` ("The service layer owns the transaction boundary").
- **Unit-of-work / transaction-context framework now** — deferred: architecture
 §10 marks it Future; the current rule defines the integration boundary for
 that infrastructure without introducing it.

## Related

- `docs/engineering-standards.md` §15.1, §16.1–§16.3
- `docs/architecture.md` §10 (Transactions)
- `docs/auth.md` (Transaction Requirement)
- `docs/adr/001-authentication.md` (registration transaction)
- `src/modules/auth/services/auth.service.ts`, `src/modules/users/users.service.ts`
