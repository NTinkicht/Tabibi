# WU65 - Capability-bound guest check-in

Issue: #266

## Scope

Extend the merged WU64 guest live-queue flow with one explicit guest check-in mutation. The mutation is capability-bound, idempotent, privacy-preserving, Arabic/French equivalent, and safe under retries and concurrency. No account/auth expansion, ETA prediction, geofencing, automatic arrival detection, notifications, rescheduling, cancellation, staff mutation, or analytics expansion.

## Authorization and privacy boundary

- Authority comes only from the valid guest capability already established by the guest booking/live-queue flow. Client-visible booking, appointment, queue, clinic, patient, or selection identifiers never grant mutation authority.
- The bearer remains memory-only and is transmitted only in the `Authorization` header. It must not enter URLs, browser storage, cookies, DOM text/attributes, logs, telemetry, analytics, or error payloads.
- Server-side authorization must bind the capability to the durable booking/appointment/queue/clinic relationship and fail closed on forged, malformed, expired, revoked, cross-booking, cross-clinic, or durable-binding-drift credentials.
- Rejections are generic and must not disclose whether a booking, queue entry, clinic, capability, or lifecycle state exists.
- The mutation response exposes only the minimum public state required for deterministic UI reconciliation; no internal identifiers or operational metadata.

## Mutation and lifecycle semantics

- Check-in is an explicit user action and never occurs automatically from location, polling, page visibility, or time.
- The server validates the lifecycle transition against durable PostgreSQL state inside the mutation transaction. Terminal or otherwise ineligible states are not mutated.
- A successful operation performs exactly one durable check-in transition and the corresponding allowed queue/audit effect.
- Repeated requests for the same logical operation are idempotent and reconcile to the same public outcome without duplicate queue or audit effects.
- Concurrent requests serialize on the authorized durable booking, not merely on `operationId`, so distinct operation identities racing for one eligible booking still produce at most one lifecycle transition and one allowed queue/audit effect.
- Mutation failure must not leave a partially updated booking/queue/audit state.

## Idempotency and ambiguous transport failure

- The mutation wire contract carries the bearer only in `Authorization: Bearer <capability>` and carries a separate opaque `operationId` request-body field. `operationId` is never accepted from a URL, cookie, storage-derived authority, or as a substitute for the bearer.
- The client generates `operationId` once when the user begins one logical check-in attempt. It is an opaque, high-entropy value with no booking, clinic, patient, queue, or other identifying information encoded in it.
- The client reuses that `operationId` for every retry of the same logical operation, including timeout, disconnect, response-loss, or other ambiguous transport failure. A new `operationId` is created only for a genuinely new logical operation after deterministic reconciliation of the previous one.
- After capability validation, the server binds the idempotency record to the authorized durable guest-booking identity resolved from that capability. The effective uniqueness scope is `(authorized guest booking, operationId)`; client-supplied booking/appointment/queue/clinic identifiers never participate in authority or widen this scope.
- Creation/claim of the idempotency record, booking-level lifecycle serialization, lifecycle validation, check-in transition, allowed queue/audit effects, and durable success outcome occur in one PostgreSQL transaction (or an equivalent atomic serialization boundary). A unique constraint protects same-operation replay while booking-level locking/serialization ensures distinct operation IDs cannot both transition the same booking.
- A committed replay of the same bound `operationId` returns the same allow-listed public reconciliation outcome without repeating booking, queue, or audit effects. Reuse of an `operationId` under a different capability/authorized booking is a separate authorization-bound scope and must never reveal whether the other operation exists.
- A failed transaction must not leave a success idempotency record or partial booking/queue/audit effects. Retry after an ambiguous client-side failure therefore safely re-enters with the same identity and either observes the committed result or performs the operation once.
- Idempotency identity is not authorization and cannot widen capability scope.

## Public reconciliation wire schema

The mutation has one privacy-preserving public schema shared by server, client, and executable tests. Successful first execution and committed replay both return HTTP `200` with JSON `{ "state": "checked_in", "reconciled": boolean }`: `state` is the literal public lifecycle value `checked_in`; `reconciled` is `false` only when this request performed the durable transition and `true` when the server returned an already-committed outcome for the same authorized booking and `operationId`. No bearer, `operationId`, booking/appointment/queue/clinic/patient identifier, audit identifier, timestamps, internal lifecycle reason, or operational metadata is returned.

Generic authorization, binding, malformed-capability, revoked/expired-capability, cross-scope, or ineligible-lifecycle rejection returns HTTP `404` with JSON `{ "error": "guest_check_in_unavailable" }`. This deliberately shared status/body is an anti-oracle contract and must not vary by underlying existence or rejection reason. Validation of a syntactically invalid request body that occurs before any resource lookup returns HTTP `400` with JSON `{ "error": "invalid_request" }`; it must not echo request values. Transient server failure returns HTTP `503` with JSON `{ "error": "temporarily_unavailable" }`, again without identifiers or internal detail. No other public response fields are permitted.

## Client behavior and localization

- Extend the existing WU64 live-queue surface rather than introducing a parallel guest authority path.
- Arabic and French provide equivalent pending, success, already-reconciled, generic rejection, transient failure, and retry semantics, with RTL/LTR parity and accessible status/action announcements.
- While a check-in request is in flight, prevent overlapping submissions for the same operation.
- After success or idempotent reconciliation, update the UI only from the public allow-listed response and resume/read live status through the existing capability-bound path.
- Generic authorization/lifecycle rejection must not expose the underlying reason.

## Required executable evidence

1. A valid capability plus a fresh `operationId` performs exactly one allowed check-in transition and returns exactly HTTP `200` plus the public `{state,reconciled}` allow-list with `reconciled:false`.
2. An ambiguous transport-failure test commits or may commit the first request while withholding/losing its client-visible response, then retries with the same bearer and `operationId`; the retry returns the same public state with `reconciled:true`, exactly one durable transition, and no duplicate queue/audit effect.
3. Two concurrency tests are mandatory: same capability + same `operationId`, and same capability + two distinct high-entropy `operationId` values targeting one eligible authorized booking. Each race produces exactly one durable lifecycle transition and one allowed queue/audit effect. Database evidence must demonstrate both operation-identity uniqueness and booking-level lifecycle serialization; distinct keys being individually valid must not permit duplicate effects.
4. Replaying the same `operationId` with forged, expired, revoked, malformed, cross-booking, cross-clinic, or durable-binding-drift capabilities fails with the generic anti-oracle response and cannot reveal an idempotency record or booking.
5. Terminal/ineligible lifecycle states cannot be mutated and return the same generic rejection; deterministic replay of an already committed successful operation remains idempotent.
6. Transaction rollback evidence proves no success idempotency record or partial booking/queue/audit mutation survives a forced failure, and retry with the same `operationId` can subsequently execute exactly once when eligible.
7. Arabic/French browser evidence covers pending, success, already-reconciled, generic rejection, transient failure, and retry with RTL/LTR/accessibility parity; ambiguous retry visibly reuses the same logical operation rather than creating a second submission.
8. Capability, `operationId`, and internal identifiers are absent from DOM, URL, browser storage, logs/telemetry fixtures, and every public response/error payload; `operationId` is transmitted only in the mutation request body and is not treated as authority.
9. PostgreSQL integration evidence covers transaction, both concurrency races, operation-identity uniqueness/binding, booking-level serialization, rollback, and ambiguous-failure replay; browser evidence is external-network-free; full repository CI remains green.

## Governance

This branch/PR is the single canonical WU65 production stream. Exactly one production implementer lease exists at a time. All six active actors may become canonical developer when concretely executable; failover continues this same branch/PR and preserves material authorship separately from the mechanical GitHub executor. Gemini CLI and Mistral Vibe may implement only through an approved reachable write-capable path; unattended Issue #11 workflows remain read-only.

Mistral Vibe is preferred for routine exact-head review, test-quality/failure-path analysis, regression hunting, edge cases, and second opinions when operational. Every Mistral Medium+/Major+/High+/Critical/Blocker finding is mandatory to reconcile. Because this work crosses mutation, authorization, privacy, idempotency, and concurrency boundaries, preserve an eligible independent non-author exact-head final gate after green CI; escalate disputed/high-risk architecture/security/privacy/concurrency findings to Claude when appropriate.

Zero-extra-cost only: no retired Gemini Agent/Chat, paid fallback, PAYG/overage/credits, Vertex, OpenRouter, auto-topups, or duplicate implementation stream.
