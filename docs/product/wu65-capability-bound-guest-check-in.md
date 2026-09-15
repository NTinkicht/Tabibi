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
- Concurrent duplicate requests serialize safely so at most one durable transition/effect occurs.
- Mutation failure must not leave a partially updated booking/queue/audit state.

## Idempotency and ambiguous transport failure

- The client creates one opaque operation identity when the user begins a check-in attempt and reuses that same identity for retries of that logical operation, including after timeout, disconnect, or other ambiguous transport failure.
- A new operation identity is created only for a genuinely new logical check-in operation after the previous operation has reached a deterministic terminal reconciliation.
- The server persists or otherwise transactionally enforces the operation identity at the authorization-bound mutation boundary so replay cannot duplicate effects.
- Idempotency identity is not authorization and cannot widen the capability scope.

## Client behavior and localization

- Extend the existing WU64 live-queue surface rather than introducing a parallel guest authority path.
- Arabic and French provide equivalent pending, success, already-reconciled, generic rejection, transient failure, and retry semantics, with RTL/LTR parity and accessible status/action announcements.
- While a check-in request is in flight, prevent overlapping submissions for the same operation.
- After success or idempotent reconciliation, update the UI only from the public allow-listed response and resume/read live status through the existing capability-bound path.
- Generic authorization/lifecycle rejection must not expose the underlying reason.

## Required executable evidence

1. A valid capability performs exactly one allowed check-in transition and returns only the public allow-list.
2. Retry after an ambiguous transport failure reuses the same operation identity and remains idempotent.
3. Concurrent duplicate requests produce one durable transition/effect and no duplicate audit/queue effect.
4. Cross-booking, cross-clinic, forged, expired, revoked, malformed, and durable-binding-drift capabilities fail generically without an existence oracle.
5. Terminal/ineligible lifecycle states cannot be mutated and do not leak internal state.
6. Transaction rollback evidence proves no partial booking/queue/audit mutation survives a forced failure.
7. Arabic/French browser evidence covers pending, success, already-reconciled, generic rejection, transient failure, and retry with RTL/LTR/accessibility parity.
8. Capability and internal identifiers are absent from DOM, URL, browser storage, logs/telemetry fixtures, and public error payloads.
9. PostgreSQL integration evidence covers transaction, concurrency, and idempotency behavior; browser evidence is external-network-free; full repository CI remains green.

## Governance

This branch/PR is the single canonical WU65 production stream. Exactly one production implementer lease exists at a time. All six active actors may become canonical developer when concretely executable; failover continues this same branch/PR and preserves material authorship separately from the mechanical GitHub executor. Gemini CLI and Mistral Vibe may implement only through an approved reachable write-capable path; unattended Issue #11 workflows remain read-only.

Mistral Vibe is preferred for routine exact-head review, test-quality/failure-path analysis, regression hunting, edge cases, and second opinions when operational. Every Mistral Medium+/Major+/High+/Critical/Blocker finding is mandatory to reconcile. Because this work crosses mutation, authorization, privacy, idempotency, and concurrency boundaries, preserve an eligible independent non-author exact-head final gate after green CI; escalate disputed/high-risk architecture/security/privacy/concurrency findings to Claude when appropriate.

Zero-extra-cost only: no retired Gemini Agent/Chat, paid fallback, PAYG/overage/credits, Vertex, OpenRouter, auto-topups, or duplicate implementation stream.
