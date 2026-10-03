# Adversarial queue concurrency matrix

Status: bounded engineering contract for WU-L5-QUEUE-CONCURRENCY (#578).

This matrix translates the deterministic queue invariants from Epic #5 into race-oriented acceptance cases. Implementations must serialize committed queue mutations so that identical committed history yields identical service order and ETA inputs. Retries must be idempotent and exceptional overrides auditable.

| Race | Required invariant | Deterministic expected outcome | Test oracle |
| --- | --- | --- | --- |
| Two check-ins for the same appointment | One canonical active queue entry per appointment/patient/session identity | Exactly one check-in commits; the duplicate observes/reuses the committed entry and cannot create a second service position | One active entry, one immutable registration identity, no duplicated ETA contribution |
| Two independent check-ins for different patients | Registration ordering is derived from committed serialization, never request arrival timing | Both may commit; their canonical order is the database commit/sequence order with a stable tie-breaker | Replaying the committed history produces the same order |
| Two `call-next` commands for one doctor/session | At most one active consultation per doctor/session and one queue entry may be claimed once | One command atomically claims the deterministic next eligible entry; the loser re-evaluates after the winner commits and may claim the next eligible entry only if the session permits it | No entry is called twice; no two active consultations violate the session invariant |
| `call-next` races with check-in | Eligibility is evaluated against the serialized committed snapshot | If call-next serializes first, the later check-in is not retroactively eligible for that call. If check-in serializes first, it participates according to canonical ordering | Outcome matches serialization order, never wall-clock handler timing |
| Priority override races with `call-next` | Priority changes are audited and affect only selections serialized after the override | Override-first means the new priority participates in selection; call-first means the already claimed entry remains claimed and the override affects later selections | Audit record identifies actor/reason/version and selected entry is explainable from prior committed version |
| Two priority overrides | Every override is versioned/audited; last committed valid override wins | Both valid events remain in audit history; effective priority is determined by serialization/version order | No lost audit event and deterministic effective priority |
| Cancellation races with `call-next` | A cancelled entry cannot newly become active; an already atomically claimed entry cannot be silently erased | Cancellation-first excludes the entry. Claim-first produces an explicit post-claim cancellation/termination transition rather than rewriting history | No state combination reports both never-called and actively-called |
| No-show races with `call-next` | Eligibility/state transition is atomic and monotonic | No-show-first excludes or demotes according to policy; claim-first keeps the claim and records any later no-show attempt as rejected/inapplicable | State machine rejects impossible backward transitions |
| Session/doctor closure races with `call-next` | Closure prevents new claims after its serialization point | Closure-first blocks call-next. Claim-first preserves the already committed consultation and closure applies to subsequent work according to closure policy | No new consultation begins from a snapshot committed after closure |
| Session closure races with check-in | Closed sessions cannot accept newly eligible queue work | Closure-first rejects/parks the check-in according to product policy; check-in-first remains a historical committed entry and is handled by closure semantics | No hidden deletion or reordering of the committed entry |
| Cancellation races with priority override | Terminal/ineligible state dominates future ordering changes | Cancellation-first makes later priority change a no-op/rejection; override-first is audited but cancellation removes eligibility afterward | Cancelled entry never returns to eligible order because of stale override |
| Retry after ambiguous timeout of check-in | Mutation identity is idempotent | Retry with the same operation/idempotency identity returns the original committed result if commit occurred, otherwise performs it once | At most one entry/version increment |
| Retry after ambiguous timeout of `call-next` | Claim operation is idempotent and cannot advance twice | Retry returns the originally claimed entry/result for the same command identity; it cannot claim a second patient | One command identity maps to one claim result |
| Retry after priority/cancel/no-show mutation | Mutation identity and expected version prevent duplicate or stale transition | Same operation identity is replay-safe; a different stale operation must re-read and fail/re-evaluate against current version | No duplicate audit side effect; stale expected version cannot overwrite newer state |
| Simultaneous mutation of one entry from two workers | Optimistic/pessimistic serialization must expose one winner and force loser reconciliation | One transition commits at the expected version; loser observes conflict and recomputes from fresh committed state | No last-write-wins overwrite of a transition based on stale state |
| ETA recomputation races with any queue mutation | Published ETA version is bound to a committed queue/session version | Recompute based on stale version cannot overwrite a newer ETA; committed mutation triggers/marks recomputation for its new version | ETA payload carries source version and monotonically advances |

## Cross-cutting acceptance rules

1. Tests must control serialization order explicitly rather than relying on sleeps or scheduler luck.
2. Every mutating command needs a stable operation/idempotency identity and an expected state/version where applicable.
3. A conflict is not success: the losing worker must re-read committed state before deciding whether another action remains valid.
4. Registration/service ordering and ETA inputs must be reconstructable from durable committed state plus audited overrides; process-local timing is never an ordering source.
5. Cancellation, no-show, closure and consultation activation are state-machine transitions, not destructive deletion of history.
6. ETA publication must include the queue/session source version so stale computations can be rejected.
7. Adversarial tests should execute both serialization orders for every two-way race above and repeat retry cases after simulated drop-after-commit responses.

## Implementation follow-up hooks

- Add PostgreSQL transaction/integration tests that force each serialization order with barriers or explicit transaction locks.
- Add command-level idempotency tests for check-in, call-next, priority, cancellation and no-show.
- Add state-machine property tests asserting one-active-consultation and no duplicate active queue entry invariants.
- Add ETA stale-write rejection tests keyed by committed queue/session version.

This document defines testable concurrency behavior only. It does not authorize deployment, production mutation, or changes to the product ordering policy.