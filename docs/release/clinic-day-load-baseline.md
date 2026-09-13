# WU43 clinic-day and burst load baseline

This work unit adds a bounded, zero-extra-cost performance rehearsal for Tabibi release hardening. It is a regression detector, not a production-capacity certification.

## Safety boundary

The load rehearsal must run only against synthetic non-production data. The implementation must require an explicit opt-in environment flag and refuse production-looking targets. It must not print request bodies, cookies, guest credentials, patient names, contact values, notification bodies, or clinical content.

No external load-testing SaaS, metered provider, PAYG/overage, Vertex, OpenRouter, credits, or provider traffic is allowed.

## Deterministic workload contract

The harness will define two bounded phases:

1. **Clinic-day phase** - sustained representative reads and mutations over a synthetic clinic/session population, using a fixed seed and fixed concurrency/operation counts.
2. **Burst phase** - a short, bounded spike around already-implemented check-in/queue/notification paths to catch lock-contention, retry, and latency regressions.

The harness must cap concurrency, total operations, and wall-clock duration. Every run records only aggregate metrics: operation counts, success/error counts, throughput, and latency percentiles.

## CI contract

Fast PR CI validates configuration guards, deterministic workload generation, metric aggregation, and threshold evaluation without relying on unstable wall-clock performance assertions.

A heavier real PostgreSQL rehearsal may run in the repository's bounded integration environment, but its thresholds must be deliberately loose enough for shared GitHub Actions runners and documented as regression alarms rather than production SLOs.

## Regression policy

A load run fails only for one of these reasons:

- a correctness/error-rate invariant is violated;
- configured operation/concurrency/time bounds are exceeded;
- an aggregate regression threshold defined by the harness is exceeded;
- the run targets a forbidden environment or lacks explicit opt-in.

Results must be reproducible from the fixed seed and configuration committed with the test harness.

## Acceptance evidence

Before merge, WU43 must provide:

- an executable bounded harness plus deterministic guard/configuration tests;
- synthetic clinic-day and burst scenarios using existing product boundaries;
- aggregate-only result output;
- exact-head CI evidence;
- reconciliation of all Medium+/Major+/High+/Critical/Blocker review findings;
- an eligible non-author exact-SHA final gate.
