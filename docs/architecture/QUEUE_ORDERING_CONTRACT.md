# Deterministic Queue Ordering Contract

Contract version: `queue-ordering/v1`

Issue: #576, under Epic #5.

The queue engine must derive the same service order from the same committed history. Ordering is therefore a pure function of committed state, never wall-clock iteration order or process-local insertion order. Implementations and audit events that depend on this ordering should record `queue-ordering/v1` so later contract revisions remain distinguishable.

## Eligibility

An entry is call-eligible only when its committed state is `checked_in` and its queue session is `open`. `waiting`, `called`, `in_consultation`, `completed`, `cancelled`, and `no_show` entries are not call-eligible. There is no implicit paused state. A state change affects eligibility only through the canonical queue state machine.

## Canonical ordering tuple

For every eligible `checked_in` QueueEntry, compare in this order:

1. priority bucket: entries with non-null `priority_order` before entries without priority;
2. for priority entries, numeric `priority_order`, lowest first;
3. numeric `eligibility_order`, lowest first;
4. immutable `registration_order`, lowest first as the deterministic final fallback.

This is equivalent to the executable ordering `CASE WHEN priority_order IS NULL THEN 1 ELSE 0 END, priority_order NULLS LAST, eligibility_order, registration_order`.

`registration_order` is immutable historical context. `eligibility_order` is assigned when an entry checks in. `priority_order` is the auditable priority override. A priority change must not rewrite `registration_order` or `eligibility_order`. Scheduled, walk-in, and guest entries use the same ordering once they are `checked_in`.

## Overrides

Priority overrides must be explicit and auditable, with actor and reason recorded according to the existing queue audit model. They affect service order through `priority_order` only and must not silently rewrite historical registration or eligibility order.

## Call-next invariant

Within the serialized queue mutation transaction, `call-next`/`call` must select the first eligible entry in the canonical ordering and transition only that entry from `checked_in` to `called`. Concurrent callers must not produce competing winners for the same committed queue state.

`call` does **not** establish an active consultation. `start_consultation` is a separate canonical transition from `called` to `in_consultation`; the existing doctor-global active-consultation invariant applies at that transition. The session-level called-entry invariant and the doctor-global active-consultation invariant therefore remain distinct.

## Acceptance examples

- Two non-priority checked-in entries are served by ascending `eligibility_order`, then `registration_order`.
- Two priority checked-in entries are served by ascending `priority_order`; arrival time does not replace the audited priority slot.
- A `waiting` entry is never selected, even if it has a priority override, until it transitions to `checked_in`.
- `called` and `in_consultation` entries are excluded from call-next selection.
- Cancellation removes an entry from selection without renumbering remaining historical fields.
- `call` transitions the selected entry to `called`; only `start_consultation` may transition it to `in_consultation`.
- Retrying against the same committed state produces the same selected QueueEntry.
- No process-local collection order may influence a tie.

Implementation and concurrency tests should use `queue-ordering/v1` as the expected ordering oracle and must remain consistent with `PRODUCT.md`, `ARCHITECTURE.md`, and the executable queue state machine.
