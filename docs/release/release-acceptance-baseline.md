# Tabibi release acceptance baseline

WU45 turns Epic #7 release hardening into one auditable go/no-go checklist. This document is deliberately conservative: an item is **PASS** only when repository evidence already exists and is executable or directly inspectable. Anything else is **GAP** until a later work unit supplies deterministic evidence.

No real patient data, external provider traffic, paid APIs, PAYG/overage, credits, Vertex, OpenRouter, or auto-topups are permitted by this baseline.

## Reference clinic-day scenario

A clinic must be able to operate a bounded full-day-style scenario in Arabic or French with receptionist and patient/guest flows while preserving deterministic queue behavior, clinic/patient isolation, privacy-safe notifications, recoverable infrastructure failures, and operator recovery evidence.

The acceptance scenario must ultimately demonstrate these phases in order:

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

| Release invariant | Current status | Repository evidence | Binding acceptance requirement / next owner |
| --- | --- | --- | --- |
| Guarded PostgreSQL backup/restore rehearsal | PASS | `docs/DATABASE_RECOVERY_REHEARSAL.md`; PostgreSQL CI rehearsal | Must remain green on the candidate release head. |
| Bounded clinic-day load regression rehearsal | PASS | `docs/release/clinic-day-load-baseline.md`; PostgreSQL CI load rehearsal | Treat as regression evidence, not production-capacity certification. |
| Notification persistence/provider/store fault handling | PASS | `tests/unit/notification-fault-injection.test.ts`; `docs/notification-fault-matrix.md` | Must remain green on the candidate release head. |
| Privacy-safe bounded dead-letter/dispatch observability | PASS | WU40/WU41 repository/API regressions already merged | Candidate release must retain clinic-scoped authenticated access and bounded operational metadata only. |
| Deterministic end-to-end queue lifecycle under realistic clinic-day flow | GAP | Existing unit/API/browser coverage is distributed; no single release acceptance scenario is asserted here yet | Add one deterministic acceptance test or orchestrated suite covering the declared queue lifecycle. |
| Cross-clinic and cross-patient isolation across the complete release scenario | GAP | Security/isolation regressions exist in component scopes, but this baseline does not yet have one end-to-end proof | Add explicit two-clinic/two-patient negative assertions in the release suite. |
| Arabic full-flow release acceptance | GAP | Localization exists in product scopes, but no repository evidence is claimed here as full release-path proof | Add deterministic Arabic browser acceptance covering RTL-sensitive patient and receptionist surfaces. |
| French full-flow release acceptance | GAP | Localization exists in product scopes, but no repository evidence is claimed here as full release-path proof | Add deterministic French browser acceptance for the same release scenario. |
| Accessibility / keyboard navigation on release-critical receptionist and patient flows | GAP | Component/browser checks may exist, but no consolidated release proof is claimed | Add keyboard-only and semantic-state assertions to the release suite. |
| Low-bandwidth / resilient refresh behavior across the full release scenario | GAP | Notification/status refresh regressions exist, but no full clinic-day release proof is claimed | Add bounded delayed-response or reconnect assertions without external network dependencies. |
| Threat-model refresh tied to the final release surface | GAP | Existing security design material is not treated as a current release sign-off by this matrix | Produce a final threat-model delta after the release suite stabilizes. |
| Deployment/rollback runbook for the release candidate | GAP | Recovery rehearsal exists, but deployment cutover/rollback is not claimed complete here | Add deterministic deployment prerequisites, rollback triggers, and post-rollback verification steps. |
| Product analytics limited to operational/product metrics without clinical profiling | GAP | No release sign-off evidence is claimed by this matrix | Define the allowed metric set and negative constraints before release. |

## Go/no-go rules

A release candidate is **NO-GO** if any of the following is true:

- any matrix row marked GAP is required by Epic #7 and remains unverified;
- exact-head required CI is not green;
- a Medium+/Major+/High+/Critical/Blocker review finding is unresolved;
- an acceptance path can disclose another clinic's or patient's data;
- a notification/provider/store failure can be reported as successful delivery without durable evidence;
- backup/restore, load, or fault-injection evidence is stale relative to the candidate release head;
- the acceptance run depends on paid/external capacity or real patient data;
- Arabic/French release behavior is inferred rather than exercised.

A release candidate becomes **GO-ELIGIBLE** only when all required rows are PASS on the same release head and an eligible non-author release gate confirms the evidence without self-gating.

## WU45 next implementation slice

The first executable follow-up should convert the highest-value GAP into repository evidence: a deterministic browser/API clinic-day release scenario with two clinics and two synthetic patients/guests, exercising queue progression plus isolation assertions. Localization, accessibility and low-bandwidth assertions should be layered onto that same canonical scenario rather than creating parallel competing suites.
