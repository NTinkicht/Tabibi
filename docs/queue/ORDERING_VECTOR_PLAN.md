# Canonical queue ordering vector plan

WU #592 turns the merged deterministic queue-ordering contract into executable fixtures without overlapping the concurrency/race stream in #591 or ETA evidence work in #589.

Contract version: `queue-ordering/v1`.

## Required vector families

1. Scheduled, walk-in, and guest entries use the contract-defined canonical ordering inputs after they are `checked_in`.
2. Call eligibility is exact: an entry is eligible only when `state == checked_in` **and** the owning consultation session is `open`. Fixtures must cover exclusion of every other queue state (`waiting`, `called`, `in_consultation`, `completed`, `cancelled`, `no_show`) and must cover a `checked_in` entry under every non-open session status (`planned`, `paused`, `closed`, `cancelled`).
3. Explicit audited priority overrides precede ordinary ordering only where the contract permits them.
4. Cancelled and no-show entries remain excluded from callable ordering even when their historical ordering fields would otherwise rank first.
5. Equal eligible entries resolve through the contract's deterministic tie-break sequence: priority bucket, numeric `priority_order`, numeric `eligibility_order`, then immutable `registration_order`.
6. Replaying identical committed inputs yields byte-for-byte identical expected order.
7. Reject vectors cover malformed or unsupported vector inputs rather than silently inventing ordering semantics, including an unknown contract version, a missing required ordering input for an eligible entry, and duplicate values where a fixture claims an immutable unique identity/order key.

## Machine-readable fixture schema

Every fixture must bind itself explicitly to `contractVersion: "queue-ordering/v1"` and contain:

- a stable `caseId`;
- committed session status and committed entry inputs, including source, state, `priority_order`, `eligibility_order`, and `registration_order` as applicable;
- `outcome: "accepted" | "rejected"`;
- for accepted vectors, the exact `expectedOrderedEntryIds` after eligibility filtering and canonical sorting;
- for rejected vectors, `expectedOrderedEntryIds: []` plus a stable non-empty `rejectionReason` identifying the fail-closed rule;
- a `rule` string naming the contract clause exercised.

Accepted fixtures must use `rejectionReason: null`. Rejected fixtures must never be reinterpreted as an empty accepted ordering result. Ineligibility itself is an accepted filtering outcome, while malformed/unsupported contract inputs are rejected fail closed.

## Acceptance

The implementation follow-up must provide machine-readable fixtures plus focused tests that load **every** vector and assert the exact outcome, rejection reason, eligibility filtering, and ordered identifiers. The validator must fail if the contract version is missing or differs from `queue-ordering/v1`. Tests must not introduce queue mutation/concurrency behavior owned by #591 and must not change ETA behavior owned by #589.

Material-Author: chatgpt
