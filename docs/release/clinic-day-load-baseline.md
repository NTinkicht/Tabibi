# WU43 clinic-day and burst load baseline

This work unit adds a bounded, zero-extra-cost performance rehearsal for Tabibi release hardening. It is a regression detector, not a production-capacity certification.

## Safety boundary

The load rehearsal runs only against synthetic non-production data. It requires `TABIBI_ALLOW_LOAD_REHEARSAL=1`, refuses `NODE_ENV=production`, and refuses database names that do not explicitly contain a non-production marker such as `test`, `dev`, `stage`, `staging`, `local`, or `sandbox`.

The harness never prints request bodies, cookies, guest credentials, patient names, contact values, notification bodies, or clinical content. Its output contains only aggregate operation counts, error counts/rates, throughput, and latency percentiles.

No external load-testing SaaS, metered provider, PAYG/overage, Vertex, OpenRouter, credits, or provider traffic is allowed. The notification portion exercises the repository's in-app delivery path only.

## Implemented workload

The executable harness is `scripts/load/clinic-day.ts` and is exposed as `npm run db:clinic-day-load`.

It creates a uniquely namespaced synthetic clinic, receptionist, doctor, and consultation session, then exercises existing product boundaries in two phases:

1. **Clinic-day phase** - bounded concurrent walk-in registration, queue reads, check-in, and serial call/start/complete lifecycle progression.
2. **Burst phase** - bounded concurrent walk-in registration plus in-app preference change, notification intent production, in-app dispatch, check-in, and queue reads.

The workload shape is controlled by a fixed seed and explicit operation/concurrency caps. Runtime identifiers are opaque and namespaced per execution so retries do not collide with earlier synthetic runs.

## Default bounds

The committed defaults are deliberately small for shared runners:

- clinic-day patients: `12` (allowed range `4..50`);
- burst patients: `6` (allowed range `2..20`);
- concurrency: `4` (allowed range `1..8`);
- workload wall-clock cap: `30,000 ms` (allowed range `5,000..60,000 ms`);
- aggregate p95 regression threshold: `4,000 ms` (allowed range `100..10,000 ms`).

Any recorded operation error fails the rehearsal. The p95 threshold is intentionally loose and is a regression alarm only, not a production SLO.

## Run manually

Use a dedicated migrated test/staging database. Do not point this command at production or at a database whose name is not clearly marked non-production.

```bash
NODE_ENV=test \
TABIBI_ALLOW_LOAD_REHEARSAL=1 \
TABIBI_LOAD_SEED=wu43-manual-v1 \
DATABASE_URL='postgresql://user:password@127.0.0.1:5432/tabibi_load_test' \
npm run db:clinic-day-load
```

Optional bounded overrides are:

- `TABIBI_LOAD_CLINIC_DAY_PATIENTS`;
- `TABIBI_LOAD_BURST_PATIENTS`;
- `TABIBI_LOAD_CONCURRENCY`;
- `TABIBI_LOAD_MAX_DURATION_MS`;
- `TABIBI_LOAD_MAX_P95_MS`.

Values outside the committed safety ranges fail closed before workload execution.

## CI contract

Fast PR CI validates configuration guards, deterministic identifiers, metric aggregation, threshold evaluation, and bounded-concurrency behavior in unit tests.

The PostgreSQL integration job also runs the real harness against the ephemeral `tabibi_test` service after the normal integration suite and recovery rehearsal. CI uses the committed `wu43-ci-v1` seed, 12 clinic-day patients, 6 burst patients, concurrency 4, a 30-second workload cap, and a 4-second aggregate p95 regression threshold.

The rehearsal uses repository services and PostgreSQL only. No external provider traffic or paid service is involved.

## Regression policy

A load run fails when:

- any measured operation fails;
- configured operation/concurrency/time bounds are invalid or exceeded;
- aggregate p95 latency exceeds the configured regression threshold;
- the target environment is production-like or lacks explicit opt-in;
- the harness produces no measured operations.

Shared-runner timing is noisy. Treat changes in these metrics as a signal to investigate, never as proof of production capacity.

## Acceptance evidence

Before merge, WU43 must provide:

- this executable bounded harness plus deterministic guard/configuration tests;
- synthetic clinic-day and burst scenarios using existing product boundaries;
- aggregate-only result output;
- exact-head CI evidence including the live PostgreSQL rehearsal;
- reconciliation of all Medium+/Major+/High+/Critical/Blocker review findings;
- an eligible non-author exact-SHA final gate.
