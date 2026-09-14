# WU49 - Bilingual full-day clinic release acceptance

Issue: #230

## Purpose

Prove that one realistic synthetic clinic day can run end-to-end through the already implemented Tabibi surfaces without losing deterministic queue behavior, bilingual presentation, tenant isolation, accessibility basics, notification integrity, or privacy boundaries.

## Canonical scenario

The executable rehearsal added by this work unit must use local/synthetic PostgreSQL data only and cover one bounded clinic day with:

1. clinic/session setup using retry-safe per-run fixture identifiers;
2. scheduled and walk-in arrivals within the same clinic;
3. Arabic RTL and French LTR rendering on supported patient/public/receptionist surfaces;
4. receptionist keyboard interaction for the supported queue workflow;
5. call, complete, no-show and doctor-delay transitions already exposed by the product;
6. deterministic service order and ETA inputs after each relevant committed mutation;
7. notification side effects already supported by the application;
8. explicit cross-clinic and cross-patient negative assertions;
9. privacy-minimal public labels and diagnostics with no clinical payload leakage;
10. deterministic cleanup or unique fixture generation so Playwright retries cannot collide.

## Safety and cost contract

- Never target production or a remotely hosted clinic database.
- No external load-testing, observability, messaging, AI, or review SaaS is required by this work unit.
- No PAYG, overage, credits, Vertex, OpenRouter, auto-topups, or retired Gemini Agent/Chat.
- Keep workload bounded to existing GitHub Actions included capacity.

## Merge contract

Exactly one canonical implementation branch/PR is allowed for WU49. Material authorship must be recorded separately from any mechanical GitHub executor. Merge requires green CI on the exact final SHA and an eligible non-author exact-SHA `PASS - MERGE_READY` verdict with no unresolved Medium+ findings.
