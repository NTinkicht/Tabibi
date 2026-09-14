# Tabibi release acceptance baseline

WU45 established Epic #7 release hardening as one auditable go/no-go checklist. WU54 reconciled that checklist against the merged WU46-WU53 repository evidence, and WU55 closes the remaining keyboard-reachability gap with deterministic browser evidence. This document remains deliberately conservative: an item is **PASS** only when deterministic repository evidence already exists and is executable or directly inspectable.

No real patient data, external provider traffic, paid APIs, PAYG/overage, credits, Vertex, OpenRouter, or auto-topups are permitted by this baseline.

## Reference clinic-day scenario

A clinic must be able to operate a bounded full-day-style scenario in Arabic or French with receptionist and patient/guest flows while preserving deterministic queue behavior, clinic/patient isolation, privacy-safe notifications, recoverable infrastructure failures, and operator recovery evidence.

The acceptance scenario must demonstrate these phases in order:

1. Clinic staff authenticate and open the clinic queue.
2. Patients or guests enter and progress through queue/check-in flows without cross-clinic or cross-patient disclosure.
3. Queue transitions remain deterministic under normal and bursty activity.
4. Notification dispatch remains privacy-safe and idempotency-aware.
5. Injected persistence/provider/store faults do not become false delivery or silent success.
6. Operators can inspect bounded operational failure state without clinical profiling.
7. Database backup/restore rehearsal succeeds in the guarded non-production path.
8. The bounded clinic-day load rehearsal remains within its declared regression thresholds.
9. Arabic or French user-facing operation is exercised end-to-end with accessibility and low-bandwidth expectations intact.

## Current evidence matrix

| Release invariant | Current status | Repository evidence | Binding acceptance requirement |
| --- | --- | --- | --- |
| Guarded PostgreSQL backup/restore rehearsal | PASS | `docs/DATABASE_RECOVERY_REHEARSAL.md`; PostgreSQL CI rehearsal | Must remain green on the candidate release head. |
| Bounded clinic-day load regression rehearsal | PASS | `docs/release/clinic-day-load-baseline.md`; PostgreSQL CI load rehearsal | Treat as regression evidence, not production-capacity certification. |
| Notification persistence/provider/store fault handling | PASS | `tests/unit/notification-fault-injection.test.ts`; `docs/notification-fault-matrix.md` | Must remain green on the candidate release head. |
| Privacy-safe bounded dead-letter/dispatch observability | PASS | WU40/WU41 repository/API regressions | Candidate release must retain clinic-scoped authenticated access and bounded operational metadata only. |
| Deterministic end-to-end queue lifecycle under realistic clinic-day flow | PASS | WU46 `tests/integration/release-clinic-day-isolation.test.ts`; WU49 `tests/e2e/bilingual-full-day-clinic-acceptance.spec.ts` | Exact-head CI must continue to execute the deterministic synthetic release path successfully. |
| Cross-clinic and cross-patient isolation across the complete release scenario | PASS | WU46 two-clinic integration isolation proof; WU47 `tests/e2e/release-bilingual-isolation.spec.ts`; WU49 bilingual full-day acceptance | Any later release-path change must preserve explicit negative cross-clinic/cross-patient assertions. |
| Arabic full-flow release acceptance | PASS | WU47 bilingual public release proof; WU48 receptionist bilingual acceptance; WU49 `tests/e2e/bilingual-full-day-clinic-acceptance.spec.ts` and `tests/e2e/bilingual-full-day-public-proof.spec.ts` | Arabic/RTL behavior must be exercised, not inferred, on the release candidate head. |
| French full-flow release acceptance | PASS | WU47 bilingual public release proof; WU48 receptionist bilingual acceptance; WU49 `tests/e2e/bilingual-full-day-clinic-acceptance.spec.ts` and `tests/e2e/bilingual-full-day-public-proof.spec.ts` | French/LTR behavior must be exercised, not inferred, on the release candidate head. |
| Accessibility / keyboard navigation on release-critical receptionist and patient/public flows | PASS | WU55 `tests/e2e/receptionist-bilingual-accessibility.spec.ts` uses bounded real browser `Tab` traversal before keyboard activation; `tests/e2e/guest-notification-center.spec.ts` proves keyboard reachability/activation for interactive guest `Mark as read` and `Retry` controls; `tests/e2e/bilingual-full-day-public-proof.spec.ts` proves the waiting-room projection is semantic display-only in Arabic and French | Candidate release CI must preserve real keyboard reachability without programmatic focus shortcuts; any new release-critical interactive control requires equivalent keyboard-reachability evidence. |
| Low-bandwidth / resilient refresh behavior across the release scenario | PASS | WU50 `tests/e2e/low-bandwidth-refresh-acceptance.spec.ts`; `docs/release/low-bandwidth-refresh-acceptance.md` | Delayed refresh/reload must not duplicate mutations, regress terminal state, or weaken privacy/isolation. |
| Threat-model refresh tied to the final release surface | PASS | WU51 `docs/release/release-threat-model-delta.md` | Any material release-surface change requires a corresponding threat-model delta before release. |
| Deployment/rollback runbook for the release candidate | PASS | WU52 `docs/release/deployment-cutover-rollback-runbook.md` | Cutover/rollback must preserve exact-head gates, privacy stop conditions, and separate application rollback from schema recovery. |
| Product analytics limited to operational/product metrics without clinical profiling | PASS | WU53 `docs/release/privacy-constrained-product-analytics.md` | Guest exchange remains analytics-free; 90-day maximum retention and fail-closed allowlist rules remain binding; any emitter requires negative leakage tests. |

## Go/no-go rules

A release candidate is **NO-GO** if any of the following is true:

- any required matrix row regresses from PASS or its cited evidence is removed/bypassed;
- exact-head required CI is not green;
- a Medium+/Major+/High+/Critical/Blocker review finding is unresolved;
- an acceptance path can disclose another clinic's or patient's data;
- a notification/provider/store failure can be reported as successful delivery without durable evidence;
- backup/restore, load, or fault-injection evidence is stale relative to the candidate release head;
- the acceptance run depends on paid/external capacity or real patient data;
- Arabic/French release behavior is inferred rather than exercised;
- deployment/rollback or analytics/privacy boundaries are weakened without explicit reviewed evidence.

A release candidate becomes **GO-ELIGIBLE** only when all required rows are PASS on the same release head and an eligible non-author release gate confirms the evidence without self-gating.

## WU54 reconciliation boundary

WU54 changed no product behavior and created no competing release suite. It aligned this matrix with already merged WU46-WU53 evidence and deliberately kept keyboard reachability as GAP because the existing browser tests used programmatic `focus()` shortcuts.

## WU55 keyboard-reachability boundary

WU55 changes no production behavior unless deterministic browser execution exposes a real tab-order defect. Its acceptance proof must reach release-critical receptionist controls and interactive guest-notification controls through real browser keyboard traversal, confirm focus before keyboard activation, retain bilingual/privacy/isolation assertions, and keep the public waiting-room projection explicitly semantic/display-only. The PASS row is valid only after required CI is green on the exact WU55 head and one eligible non-author reviewer confirms the evidence without self-gating.

Material author: ChatGPT. Mechanical GitHub executor: ChatGPT connector. ChatGPT is recused from the final gate.
