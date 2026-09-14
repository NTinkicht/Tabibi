# WU50 low-bandwidth and resilient refresh acceptance

WU50 supplies deterministic release evidence for the remaining low-bandwidth / resilient-refresh gap in Epic #7. It extends the existing clinic-day release path rather than creating a competing workflow.

## Scope

The executable follow-up on this branch must use synthetic local PostgreSQL fixtures and the existing browser/API surfaces only. No production target, external SaaS, paid API, PAYG/overage, credits, Vertex, OpenRouter, or auto-topup is allowed.

The acceptance rehearsal must cover both sides of the operational loop:

1. a patient/public queue-status surface;
2. a receptionist release-critical surface.

## Required evidence

The final WU50 implementation must prove all of the following on one retry-safe scenario:

- a deliberately delayed local response does not corrupt queue state or produce a duplicate mutation;
- after a bounded refresh or reconnect, the UI converges to current server truth;
- terminal queue state never regresses to an earlier state after refresh/reconnect;
- the exercised patient/public surface renders expected real queue data before privacy-negative assertions are evaluated;
- cross-clinic/private identifiers remain absent from the patient/public surface;
- receptionist state after refresh matches durable server state rather than stale browser state;
- no notification/provider outcome is reported as delivered solely because of a client refresh/reconnect;
- Arabic/French directionality and localized labels remain correct on any localized surface exercised by the rehearsal;
- diagnostics stay aggregate/privacy-minimal and contain no clinical payloads or secrets.

## Determinism and CI bounds

Network degradation must be simulated locally and deterministically, for example with Playwright request routing or an application-controlled bounded delay. Do not depend on real network throttling, third-party services, or wall-clock sleeps longer than required for the assertion.

The scenario must use unique fixture keys per run and cleanly tolerate retry. Timing assertions are regression bounds for the CI environment, not production-capacity certification.

## Merge gate

WU50 is merge-eligible only when:

- the executable acceptance evidence above exists in the repository;
- exact-head required CI is fully green;
- every Medium+/Major+/High+/Critical/Blocker finding is resolved;
- an eligible non-author reviewer gates the unchanged exact head;
- material authorship is recorded separately from any mechanical GitHub executor.
