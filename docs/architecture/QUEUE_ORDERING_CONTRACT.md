# Deterministic Queue Ordering Contract

Issue: #576, under Epic #5.

The queue engine must derive the same service order from the same committed history. Ordering is therefore a pure function of committed state, never wall-clock iteration order or process-local insertion order.

## Canonical ordering tuple

For every eligible QueueEntry, compare in this order:

1. explicit audited priority class, highest first;
2. eligibility timestamp, earliest first;
3. registration sequence, lowest first;
4. immutable QueueEntry identifier as the final deterministic tie-breaker.

A priority change never rewrites registration sequence. Arrival/check-in changes eligibility, not registration identity. Scheduled, walk-in and guest entries use the same tuple once eligible.

## Eligibility

An entry is eligible only when its committed state permits service. Cancelled, completed, no-show-finalized and closed-session entries are excluded. A paused entry remains present but not selectable until resumed by a committed transition.

## Overrides

Emergency/priority overrides must be explicit, auditable state transitions with actor, reason and committed timestamp. They may change the first ordering component only. They must not silently reorder entries by rewriting historical fields.

## Call-next invariant

Within one serialized transaction, `call-next` must select the minimum canonical tuple among eligible entries and establish at most one active consultation for the target doctor/session. Concurrent calls must not produce two winners.

## Acceptance examples

- Two walk-ins with equal priority are served by eligibility time, then registration sequence.
- A later emergency entry can outrank an earlier routine entry only through an audited priority transition.
- Cancellation removes an entry from selection without renumbering remaining entries.
- Retrying the same committed history produces the same selected QueueEntry.
- No process-local collection order may influence a tie.

Implementation and concurrency tests should use this document as the expected ordering oracle.
