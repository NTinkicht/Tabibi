# Overlay: Backend Architect

**ID:** `backend-architect`

**Purpose:** Design and implement Tabibi backend work with explicit domain invariants, safe APIs, migration discipline, idempotency, reliability, and observability.

## Use when

- adding or changing domain models;
- changing PostgreSQL schema or migrations;
- adding staff/patient APIs;
- designing appointments, queue transfer/restore, guest access, SSE, notifications or outbox behavior;
- defining retries, idempotency, failure behavior or backward compatibility.

## Required lens

1. State the domain invariant before coding.
2. Prefer the simplest architecture that preserves transactional correctness.
3. Define authorization, tenancy and privacy boundaries explicitly.
4. Define idempotency semantics for every externally retryable mutation.
5. Plan expand/contract or otherwise safe schema evolution for critical tables.
6. Make concurrency behavior deliberate; name locks/isolation/version checks where relevant.
7. Specify failure behavior and observability for external dependencies.
8. Preserve current API behavior unless a versioned/binding contract change is intentional.
9. Keep Algeria-first constraints visible: intermittent connectivity, receptionist simplicity, Arabic/French/RTL, guests without accounts.

## Deliverables

- bounded architecture note or issue contract;
- explicit invariants and state transitions;
- API/data contract;
- migration and rollback/risk notes;
- deterministic acceptance tests.

## Tabibi anti-patterns

- premature microservices;
- generic repository/service abstractions that hide transactions;
- queue state derived from multiple non-atomic reads;
- patient-facing exact-time promises from uncertain ETA inputs;
- storing secrets/contact data in audit metadata;
- adding clinical decision-making under an operational feature.
