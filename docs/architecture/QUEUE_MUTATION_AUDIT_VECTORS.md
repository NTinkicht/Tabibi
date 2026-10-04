# Queue mutation audit vectors

Status: bounded WU #594 seed artifact under Epic #5.

## Purpose

Define deterministic audit-evidence cases for already-authorized queue lifecycle mutations without changing queue ordering, ETA, authorization, or concurrency semantics. These cases are intentionally separate from canonical ordering vectors (#592/#593) and adversarial race regressions (#590/#591).

## Required evidence shape

Every accepted vector must bind only evidence the current queue implementation actually emits. Common lifecycle evidence is: mutation kind, queue-entry identity, session identity, prior lifecycle state, resulting lifecycle state, actor identity, correlation identity, and idempotency identity. Family-specific evidence is additive:

- `call` binds selection to `queueOrderingContractVersion: "queue-ordering/v1"`;
- `priority override` (`queue_entry.reordered`) binds the operational `reason`, `previousOrder`, `resultingOrder`, `previousVersion`, `resultingVersion`, and `targetPosition`;
- `cancel` and `no_show` bind the existing operational `reason`; cancellation also binds the existing `cancellationSource`;
- ordinary lifecycle command audit events do **not** currently carry `queue_order_version`, so fixtures must not invent that field. Any future requirement to add it is a product-code change that must be explicit and independently reviewed.

There is no generic deterministic reason-code field in the existing contract. Ordering-dependent selection is evidenced by `queueOrderingContractVersion`; exceptional operational mutations use the existing free-form operational `reason`. Evidence must not contain credentials, secrets, or unnecessary patient data.

## Initial vector families

1. **check-in**: an eligible `waiting -> checked_in` transition records the existing lifecycle evidence and the committed entry identity/state; no noncanonical `arrived` alias is permitted.
2. **call-next**: the selected eligible `checked_in -> called` transition records `queueOrderingContractVersion: "queue-ordering/v1"` as the deterministic selection evidence.
3. **priority override**: an already-authorized override records prior/resulting priority order, `previousVersion`/`resultingVersion`, `targetPosition`, and the existing operational `reason`; missing required authorization or reason is rejected.
4. **cancellation**: cancellation records prior/resulting lifecycle state, operational `reason`, and `cancellationSource`, and the resulting terminal state is excluded according to the separate ordering contract.
5. **no-show**: no-show records prior/resulting lifecycle state and operational `reason` without inventing a new ordering rule.
6. **retry / idempotency**: preserve the production ordering of checks. The actor is reauthorized before any existing receipt may be returned. For an authorized actor, an exact matching command/reorder retry may return the stored receipt without creating a second audit event. For reorder specifically, receipt lookup occurs before live stale-version validation, so an exact matching retry can return its stored result even after the live queue version has advanced. A changed payload under the same idempotency key is rejected as a fingerprint conflict. A **new-key** priority request carrying a stale `expectedVersion` is rejected by the version check.

## Acceptance boundary

The executable follow-up must provide machine-readable positive and negative fixtures for each family and focused tests that consume them. The same committed inputs must yield the same audit result. Unknown mutation kinds, missing evidence fields required by the applicable family, contradictory prior/resulting states, unauthorized receipt replay, changed-payload idempotency reuse, new-key stale priority evidence, and secret-bearing evidence fail closed.

Fixtures must distinguish an exact receipt replay from a new request against stale live state; they must not collapse both into a generic retry/version outcome. This WU must not duplicate ordering-fixture assertions owned by #593 or race scheduling/interleaving assertions owned by #591.

Material-Author: chatgpt
