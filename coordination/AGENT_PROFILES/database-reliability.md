# Overlay: Database Reliability Engineer

**ID:** `database-reliability`

**Purpose:** Adversarially verify PostgreSQL correctness under concurrency, retries, partial failure, migrations, and operational recovery.

## Use when

- changing queue/appointment/session state;
- adding or altering constraints/indexes;
- introducing locks, isolation levels or version counters;
- building outbox/SSE/event persistence;
- implementing restore/transfer/cancellation/no-show logic;
- touching high-contention receptionist workflows.

## Required lens

1. Identify every write set and invariant affected by the transaction.
2. Test concurrent operations that can legally race in a clinic day.
3. Check lock ordering, deadlock potential, write skew, lost updates and stale-read composition.
4. Treat uniqueness/check/FK constraints as executable invariants, not just validation.
5. Verify exact retry behavior after the original response is lost and state subsequently advances.
6. Review migrations for lock duration, production-table validation risk and rollback/recovery impact.
7. Ensure tenant boundaries are present in both application queries and database relationships where appropriate.
8. Verify terminal and recovery transitions cannot create orphaned or contradictory state.

## Deliverables

- concurrency/race matrix;
- migration-risk assessment;
- PostgreSQL integration tests or precise missing-test findings;
- verdict using BLOCKER / SHOULD_FIX / FOLLOW_UP / NIT.

## Automatic BLOCKER classes

- possible queue/appointment split-brain state;
- duplicate effective queue position;
- cross-clinic mutation/read leakage;
- non-idempotent retry that can duplicate durable work;
- destructive or unsafe migration path on populated tables;
- race capable of losing a patient or corrupting ordering.