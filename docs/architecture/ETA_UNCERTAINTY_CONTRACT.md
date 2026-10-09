# Deterministic ETA Uncertainty Contract

Contract version: `eta-uncertainty/v1`

Issue: #577, under Epic #5.

ETA output must be deterministic for the same committed queue/session history and must expose uncertainty instead of false precision. This contract complements `queue-ordering/v1`; it does not redefine service order.

## Committed inputs and scope

Every estimate is scoped to one clinic, one consultation session, one target QueueEntry, one committed `queue_order_version`, and one immutable evaluation instant `evaluated_at` captured by the trusted server transaction. Ambient process time is not an input.

Only committed inputs may affect ETA:

- ordered eligible `checked_in` entries ahead of the target under `queue-ordering/v1`;
- any already `called` entry that still represents work ahead of the target;
- active consultation state, including `started_at` and its deterministic remaining-minute contribution;
- session status and schedule context (`starts_at`, `ends_at`, pause/resume state) plus committed declared delay;
- historical consultation-duration priors and same-day completed consultation durations selected by the existing deterministic estimator policy;
- explicit priority changes and the current committed queue revision;
- the estimator/configuration version.

`waiting`, cancelled, completed, and no-show entries do not contribute merely by existing. A scheduled appointment contributes only after its canonical queue state makes it service work ahead of the target. Unknown, cross-clinic, malformed, or uncommitted inputs fail closed rather than being silently guessed.

## Versioned calculation

`eta-uncertainty/v1` defines the target behavior for the next versioned ETA output. It uses the deterministic consultation-duration estimate already selected by the estimator (`observed_median`, then `historical_median`, then the documented fallback). At this revision, production still reports active-consultation remaining time separately and publishes ETA bounds without adding that remainder into the range and without an `expected_minutes` field; adopting this contract therefore requires an explicit versioned implementation change rather than relabeling current output.

Let:

- `D` = committed non-negative declared delay minutes;
- `A` = deterministic remaining minutes for an active consultation at `evaluated_at`, or `0` when none is active;
- `N` = number of queued service slots ahead after accounting for the separately represented active consultation;
- `M` = selected estimated consultation minutes;
- `MIN = 0.75` and `MAX = 1.5`, matching the existing bounded uncertainty policy.

First compute the exact, unrounded values:

- `raw_earliest = D + A + N * M * MIN`;
- `raw_expected = D + A + N * M`;
- `raw_latest = D + A + N * M * MAX`.

Normalization must preserve real uncertainty. If `raw_earliest == raw_expected == raw_latest`, normalize all three fields to `round(raw_expected)`. Otherwise normalize outward around the expected value:

- `earliest_minutes = floor(raw_earliest)`;
- `expected_minutes = round(raw_expected)`;
- `latest_minutes = ceil(raw_latest)`.

All inputs must be finite and physically valid. The normalized range must satisfy `0 <= earliest_minutes <= expected_minutes <= latest_minutes`. When the unrounded bounds differ, normalization must also satisfy `earliest_minutes < latest_minutes`; rounding may never collapse a genuine uncertainty interval into a point estimate. A single-point estimate is allowed only when all three raw values are equal by rule, never by rounding convenience or by dropping uncertainty evidence.

A `called` entry that is not yet the active consultation counts as one queued service slot ahead. Once that entry becomes the active consultation, it is represented by `A` and must not also be counted in `N`.

## Output and field semantics

Each estimate is an immutable versioned tuple:

- `earliest_minutes`, `expected_minutes`, `latest_minutes`: normalized whole-minute range at `evaluated_at`;
- `estimate_version`: exactly `eta-uncertainty/v1` for this algorithm and multiplier policy;
- `queue_revision`: the committed session `queue_order_version` used to build the snapshot;
- `evaluated_at`: absolute timestamp used for active-consultation remaining-time calculation;
- `explanation_codes`: deterministic reason codes for material range/position inputs.

A read-only display estimate is identified by `(clinic, session, target_entry, queue_revision, estimate_version, evaluated_at)`. **Persisted claim evidence additionally requires the committed session source epoch and clinic prior epoch**, described below. A changed epoch requires recomputation even when queue order is unchanged; an identical tuple must never overwrite different evidence.

## Recompute and refresh policy

Recompute after every committed mutation that can affect service order or service velocity: check-in, call-next, consultation start/end, priority change, cancellation, no-show, pause/resume, doctor/session delay, session close, and queue-entry transfer. A transfer recomputes both affected sessions from their newly committed queue revisions: the source session after removal and the target session after insertion. `closed` and `cancelled` sessions are terminal; there is no post-close `reopen` trigger. The only transition back to `open` covered here is the existing non-terminal `paused -> open` resume operation already listed above.

Time passage alone may change active-consultation remaining time. A refresh therefore captures a new committed `evaluated_at` and produces a new estimate snapshot; replay of an older snapshot always uses its original `evaluated_at`. No test or recovery path may call the ambient clock while replaying historical input.

If a session is paused or otherwise not currently advancing, consumers must not present a precise-looking countdown. The receptionist and guest read-only projections suppress ETA while paused and expose the existing explicit session status. If required schedule/evaluation inputs are absent or invalid, no persisted claim may be created until a valid committed snapshot exists.

## Determinism and concurrency

No random sampling, process-local clock drift, unordered collection traversal, or hidden model state may influence the result. The same committed history, configuration version, queue revision, and evaluation instant must yield identical output.

The read-only receptionist and guest GET projections are **not** atomic database publication claims. A same-snapshot queue revision check never qualifies as CAS. Persisted publication must use the database-bound exact-source claim procedure described below; a changed session or clinic-prior epoch rejects the stale candidate, and the caller must recompute from a fresh committed snapshot. Concurrent identical claims for one immutable input tuple must converge on the same row and payload.

## Explainability

Every estimate must retain explanation codes sufficient to show whether the range widened or moved because of queue depth, a called-but-not-started slot, active-consultation remaining time, priority changes, observed same-day duration, historical prior, fallback prior, pause/delay, or active-consultation overrun. Codes describe committed facts; they must not reveal patient identity.

## Acceptance examples

- Adding an eligible patient increments the queue revision and deterministically recomputes affected estimates.
- A `called` patient ahead contributes one service slot until consultation starts; after start, the same work is represented only by active-consultation remaining time.
- Cancelling an entry removes its contribution without changing unrelated historical priors.
- Transferring an eligible entry from session A to session B increments/recomputes both affected queue snapshots; neither session may retain an ETA derived from its pre-transfer revision.
- Closing a session may trigger its final recomputation/invalidations, but no subsequent `reopen` transition exists; `resume` applies only to a paused non-terminal session.
- With `D=0.8`, `A=0`, `N=1`, and `M=1`, the distinct raw bounds are normalized outward rather than collapsed to one point.
- A same-day observed slowdown changes `M` and may move all three range values while preserving `earliest <= expected <= latest`.
- Replaying the same committed history with the same `evaluated_at` produces byte-equivalent normalized estimate data for the same configuration version.
- A retry computed from queue revision 41 cannot be published as revision 42; it must be discarded and recomputed.
- Missing or invalid `evaluated_at`, source policy, queue revision, or session scope fails closed rather than using process-local defaults.

## Owner-approved source-epoch and claim protocol (#610)

The additive 0035/0036 migrations introduce a **canonical session ETA source epoch** and a **clinic prior epoch**. Both are internal, non-negative bigint counters, *not* `queue_order_version`. The latter retains `queue-ordering/v1` semantics and remains the revision displayed to existing clients. A source epoch changes transactionally for relevant session status/delay/schedule mutations, queue insertion/transition/timing/reorder/transfer, and committed reorder audit evidence. A queue transfer advances both source and destination sessions. A newly completed or edited consultation-duration sample also advances the clinic prior epoch, so a different session cannot publish against a stale historical-duration prior. Existing records are backfilled with epoch zero on deployment; no historic queue order or ETA data is rewritten.

The internal claim-only service `EtaUncertaintyClaimService` requires an authorized clinic receptionist or administrator. It stores the normalized public-safe fields, immutable evaluation time, queue revision and both source epochs in `eta_uncertainty_claims`. The publication guard runs inside the **same database transaction** as `INSERT`: it locks the session source row, then the clinic prior row, verifies the full epoch tuple, validates a current eligible target and open session, and refuses stale or malformed evidence. The trigger also protects direct SQL writers. Replaying an identical committed tuple returns the existing claim; conflicting payloads never overwrite it. Claims are immutable, even if sources subsequently advance.

Read-only guest polling never creates a claim, mutates source epochs or exposes the private clinic-prior epoch, claim ID, internal patient identity or raw reorder audit metadata. A response generated before a newer committed mutation is a historical read-only snapshot, not a claim that remains current indefinitely. The existing refresh interval and public capability allowlist remain unchanged.

The reorder explanation lookup uses an online partial index on `(clinic_id, metadata->>'sessionId')` for `queue_entry.reordered` facts. Migration 0036 creates that index **concurrently** to avoid a blocking build across the entire append-only audit history. Neither the index nor a successful snapshot read alone authorizes a claim or production deployment.
