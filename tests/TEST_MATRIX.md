# Tabibi Test Matrix

This matrix maps committed requirements/invariants to their current test layer, executable file, CI lane, and status on this branch.

## Requirement / invariant coverage

| Requirement / invariant | Layer | File(s) | CI lane | Status |
| --- | --- | --- | --- | --- |
| Clinic-scoped staff auth and no unauthenticated operational access | Unit, API | `tests/unit/staff-auth.test.ts`, `tests/api/session-operations.test.ts`, `tests/api/queue-operations-negative.test.ts` | `CI / Quality and build` | Covered |
| Same-origin mutation enforcement | API | `tests/api/session-operations.test.ts`, `tests/api/queue-operations-negative.test.ts` | `CI / Quality and build` | Covered |
| Walk-in registration preserves privacy and public labels are non-PII | Integration, E2E | `tests/integration/walkin-queue.test.ts`, `tests/e2e/smoke.spec.ts` | `CI / PostgreSQL integration`, `CI / Browser smoke` | Covered |
| Registration evidence remains immutable while service ordering changes | Integration | `tests/integration/queue-priority.test.ts`, `tests/integration/queue-adversarial.test.ts` | `CI / PostgreSQL integration` | Covered |
| Queue lifecycle transitions are serialized and auditable | Integration | `tests/integration/queue-lifecycle.test.ts`, `tests/integration/queue-adversarial.test.ts` | `CI / PostgreSQL integration` | Covered |
| Tenant isolation and role denial on queue operations | Integration, API | `tests/integration/walkin-queue.test.ts`, `tests/integration/queue-priority.test.ts`, `tests/api/queue-operations-negative.test.ts` | `CI / PostgreSQL integration`, `CI / Quality and build` | Covered |
| Exact retries do not duplicate effects; conflicting idempotency reuse is rejected | Integration | `tests/integration/walkin-queue.test.ts`, `tests/integration/queue-lifecycle.test.ts`, `tests/integration/queue-adversarial.test.ts`, `tests/integration/clinic-scheduling.test.ts` | `CI / PostgreSQL integration` | Covered |
| Stale queue-version writes are rejected | Integration, E2E | `tests/integration/queue-priority.test.ts`, `tests/e2e/queue-rtl-mobile.spec.ts` | `CI / PostgreSQL integration`, `CI / Browser smoke`, `Nightly QA / Browser RTL and mobile` | Covered |
| `priority_order` is the authoritative live override and stays contiguous | Integration | `tests/integration/queue-priority.test.ts`, `tests/integration/queue-adversarial.test.ts` | `CI / PostgreSQL integration`, `Nightly QA / Deep PostgreSQL adversarial` | Covered |
| Deterministic adversarial queue sequences preserve invariants after every step | Integration | `tests/integration/queue-adversarial.test.ts` | `CI / PostgreSQL integration`, `Nightly QA / Deep PostgreSQL adversarial` | Covered |
| Arabic/French + RTL/LTR + mobile reception flows remain usable | E2E | `tests/e2e/smoke.spec.ts`, `tests/e2e/queue-rtl-mobile.spec.ts` | `CI / Browser smoke`, `Nightly QA / Browser RTL and mobile` | Covered |
| Current migration chain applies through the real migrator and remains idempotent | Integration | `tests/integration/database.test.ts`, `tests/integration/migration-chain.test.ts` | `CI / PostgreSQL integration` | Covered for `0001`-`0006` |

## Known regression / finding mapping

| Finding ID | Requirement | File / lane | Status |
| --- | --- | --- | --- |
| `CLAUDE-027` | Real PostgreSQL integration must stay deterministic under Vitest | `vitest.config.ts`, all `tests/integration/*.test.ts` | Fixed and covered |
| `CLAUDE-031` | Priority compaction must avoid uniqueness collisions | `tests/integration/queue-priority.test.ts` | Fixed and covered |
| `CLAUDE-032` | `no_show` requires an audited reason | `tests/integration/queue-priority.test.ts`, `tests/api/queue-operations-negative.test.ts` | Fixed and covered |
| `CLAUDE-033` | `priority_order`, not `service_order`, defines live override semantics | `tests/integration/queue-priority.test.ts`, `tests/integration/queue-adversarial.test.ts` | Fixed and covered |
| `CLAUDE-034` | Public waiting-room labels must not derive from internal IDs | Upstream PR #51 regression lane | Pending outside this branch base |
| `CLAUDE-035` | Upgrades must backfill legacy insecure public labels | Upstream PR #51 regression lane | Pending outside this branch base |
| `CLAUDE-036` | Migration-path regression should exercise the real `0007` migrator, not duplicated SQL | Planned WU6 upgrade-path lane once `0007` exists locally | Pending / blocked on upstream migration availability |

## Deep-suite reproducibility

- Fixed-seed adversarial integration uses `QA_FIXED_SEED` (default `20260907`).
- Nightly jobs must log the seed and upload artifacts so failures can be replayed locally with the same seed.
