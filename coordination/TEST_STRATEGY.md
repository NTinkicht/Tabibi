# Tabibi Independent QA / Test Strategy

## Purpose

This branch is the repository's independent QA lane. It derives test priorities from `PRODUCT.md`, `ARCHITECTURE.md`, and `SECURITY.md` and stays test-only: executable tests, fixtures/harnesses, CI test workflows, and testing documentation. Production defects found here must be recorded as stable `QA-xxx` findings and handed to the canonical production stream instead of being silently patched in QA.

## Testing philosophy

- Test the committed contracts, not optimistic assumptions.
- Prefer real PostgreSQL integration for state, authorization, idempotency, and concurrency invariants.
- Keep public/privacy guarantees black-box: assert what unauthenticated/public callers can and cannot observe.
- Treat Arabic/French, RTL/LTR, and mobile flows as product behavior, not garnish.
- Add every confirmed MAJOR/BLOCKER defect as a permanent regression.

## Test layers and ownership

| Layer | Primary purpose | Current examples |
| --- | --- | --- |
| Unit | Pure boundaries, validation, auth helpers, domain-level invariants | `tests/unit/*.test.ts` |
| API | HTTP/auth/CSRF/validation/negative behavior | `tests/api/*.test.ts` |
| PostgreSQL integration | Real transaction, locking, idempotency, tenant isolation, lifecycle, priority-order invariants | `tests/integration/*.test.ts` |
| Browser E2E | Reception UX, locale/RTL/mobile behavior, end-to-end operational safety | `tests/e2e/*.spec.ts` |
| Scheduled deep QA | Repeated deterministic adversarial seeds, richer logging/artifacts, slower regression lanes | `.github/workflows/nightly-qa.yml` |

GitHub Copilot QA owns these suites and their documentation. Production implementers may add or update tests when they change behavior, but QA remains the primary independent maintainer of cross-cutting regression coverage.

## Pass / fail policy

- **PR-fast gates must pass**: format, lint, typecheck, unit/API, real PostgreSQL integration, and browser smoke/UX coverage already present in CI.
- **Deep/nightly gates must pass** before closing a QA finding that depends on repeated adversarial evidence.
- A failing QA test that exposes a product defect is not “noise”; it becomes a tracked finding with a stable ID and minimal reproducer.
- No production code is changed from this QA stream merely to turn red tests green.

## Regression and finding policy

- Stable QA finding IDs use `QA-xxx`.
- Every confirmed MAJOR/BLOCKER bug gets:
  1. a stable finding ID,
  2. the smallest reproducible failing scenario,
  3. a durable mapping in `tests/TEST_MATRIX.md`,
  4. handoff to the canonical production stream.
- Previously found cross-cutting regressions remain mapped even when their owning production fix lives on another branch/PR.

## Escalation rules

- If the required behavior is already implemented and observable, add/expand tests here.
- If the required behavior only exists on another unmerged branch, document the missing regression lane and keep the current branch honest about what it can verify.
- If a correct regression requires a production seam that does not exist yet, record the gap as a QA finding instead of introducing test-only hacks that misrepresent reality.

## PR-fast vs. deep / nightly split

### PR-fast

Use the existing `CI` workflow for:

- formatting, lint, typecheck;
- unit and API tests;
- current real-PostgreSQL integration suites;
- browser smoke / localization sanity.

### Deep / nightly

Use `.github/workflows/nightly-qa.yml` for:

- repeated deterministic adversarial queue-sequence runs with explicit seeds;
- slower browser localization/RTL/mobile regression coverage;
- log artifacts that preserve the seed and iteration that failed.

## Immediate current-branch priorities

1. Current migration-chain confidence through the committed `0001`-`0006` migrator.
2. Real PostgreSQL queue adversarial/state/idempotency invariants.
3. Queue API negative/security boundary coverage.
4. Arabic/French RTL/mobile queue regressions.
5. Documented pending lane for the faithful `0007` WU6 upgrade-path regression once that migration exists on the canonical branch.
