# ETA executable vectors v1

This bounded artifact translates the existing deterministic ETA contract into executable fixture families without changing estimator, queue-ordering, or patient-facing semantics.

## Required vector families

- scheduled, walk-in, and guest entries with identical committed inputs produce identical estimate evidence;
- uncertainty is represented as a range and never collapsed to unsupported point precision;
- relevant committed queue/session mutations trigger recomputation while unrelated actions do not;
- only paths that have actually adopted `eta-uncertainty/v1` carry the canonical version marker; legacy estimator paths must not claim v1 evidence;
- exact retries over identical inputs are byte-equivalent, while stale queue-revision candidates are discarded and deterministically recomputed;
- unknown or incomplete required inputs are rejected rather than guessed.

## Test boundary

The checked-in machine-readable fixtures are synthetic and deterministic. Focused tests consume those vectors directly and verify adopted-v1 estimates, a negative legacy path, exact retry determinism, stale-revision recomputation, invalid-input rejection, and the recomputation trigger set. This WU does not own queue concurrency races, canonical queue-ordering fixtures, deployment, production data, credentials, or a new estimation algorithm.

Refs #5 #577 #587 #597.
