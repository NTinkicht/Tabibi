# Queue lifecycle executable vectors v1

This bounded artifact defines executable fixture families for the existing QueueEntry and ConsultationSession state-transition semantics. It does not redefine queue ordering, ETA, concurrency control, or audit evidence.

## Required vector families

- eligible check-in transitions an existing `waiting` entry to `checked_in`; duplicate or invalid check-in is rejected;
- call-next transitions only the canonically selected eligible `checked_in` entry to `called`; `waiting` entries are not call-eligible;
- consultation activation transitions `called` to `in_consultation`, and completion transitions `in_consultation` to `completed`;
- cancellation is allowed only from `waiting`, `checked_in`, or `called`; no-show is allowed only from `checked_in` or `called`, and both outcomes are terminal for later lifecycle commands;
- an exact authorized replay with the same idempotency key and identical request fingerprint returns the stored receipt without creating a second lifecycle event;
- reuse of an idempotency key with a changed payload, stale transitions, and impossible transitions fail closed;
- identical prior state plus identical transition input yields identical resulting state/evidence.

## Test boundary

The checked-in machine-readable fixtures are synthetic and deterministic. Focused tests consume those cases directly and assert the canonical transition table, terminal-state behavior, and exact replay versus conflicting idempotency reuse. Concurrency races remain owned by #590/#591; canonical ordering and mutation-audit vectors remain separate merged slices.

Refs #5 #590 #599.
