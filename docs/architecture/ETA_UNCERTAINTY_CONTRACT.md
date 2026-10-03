# Deterministic ETA Uncertainty Contract

Issue: #577, under Epic #5.

ETA output must be deterministic for the same committed queue/session history and must expose uncertainty instead of false precision.

## Inputs

Only committed inputs may affect ETA: ordered eligible queue entries, active consultation state, historical consultation-duration priors, same-day completed consultation durations, pause/delay state, and explicit priority changes.

## Output

Each estimate is a versioned tuple:

- `earliest_minutes`
- `expected_minutes`
- `latest_minutes`
- `estimate_version`
- `queue_revision`
- `explanation_codes`

The range must satisfy `0 <= earliest <= expected <= latest`. A single-point estimate is allowed only when all three values are equal by rule, never by rounding convenience.

## Recompute triggers

Recompute after every committed mutation that can affect service order or service velocity: check-in, call-next, consultation start/end, priority change, cancellation, no-show, pause/resume, doctor/session delay, and queue closure/reopen.

## Determinism

No random sampling, process-local clock drift, unordered collection traversal, or hidden model state may influence the result. The same committed history and configuration version must yield identical output.

## Explainability

Every estimate must retain explanation codes sufficient to show whether the range widened or moved because of queue depth, priority changes, observed same-day duration, historical prior, pause/delay, or active-consultation overrun.

## Acceptance examples

- Adding an eligible patient increments the queue revision and deterministically recomputes affected estimates.
- Cancelling an entry removes its contribution without changing unrelated historical priors.
- A same-day observed slowdown may move expected/latest while preserving the explicit range.
- Replaying the same committed history produces byte-equivalent normalized estimate data for the same configuration version.
