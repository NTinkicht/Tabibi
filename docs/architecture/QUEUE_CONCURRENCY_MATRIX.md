# Adversarial Queue Concurrency Matrix

Issue: #578, under Epic #5.

Each row defines a race that implementation tests must reproduce against PostgreSQL-backed serialized queue mutations.

| Race | Required invariant | Deterministic expected outcome |
| --- | --- | --- |
| two simultaneous check-ins for the same entry | idempotent state transition | one committed check-in; retry observes the committed state |
| two `call-next` requests for one doctor/session | one active consultation | exactly one QueueEntry wins; the loser retries/reconciles |
| `call-next` vs priority change | canonical serialized order | winner reflects whichever committed transition serialized first; audit records both |
| cancellation vs `call-next` | cancelled entries are never newly selected | cancellation-first excludes the entry; call-first establishes consultation and cancellation must follow consultation rules |
| no-show vs arrival/check-in | one legal terminal/eligible state | transaction ordering determines one valid state transition; illegal second transition fails |
| queue close vs new check-in | closed queue rejects new eligibility | close-first rejects check-in; check-in-first commits then close applies to subsequent mutations |
| pause vs `call-next` | paused session cannot select new work | pause-first blocks selection; call-first may complete selection before pause becomes effective |
| duplicate retry after timeout | idempotency | retry returns/observes the original committed mutation, never a second semantic action |
| simultaneous emergency promotions | deterministic tie break | canonical ordering tuple resolves equal priority without process-local order |
| consultation end vs next call | one-active-consultation invariant | next selection can occur only after end commit releases the active slot |

## Test requirements

Every race test must use independent database transactions, an explicit synchronization barrier, bounded timeout, and assertions on both final state and audit history. Tests must be repeatable and must not accept multiple outcomes unless the contract explicitly states that either serialization order is legal. When two serialization orders are legal, each resulting state must still satisfy the same invariants and be explainable from committed history.
