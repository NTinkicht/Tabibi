# WU63 - Capability-bound guest live queue status

Parent: #262

## Purpose

Allow a guest holding the existing booking capability to poll a privacy-safe live queue status for exactly the booking and queue participation durably bound to that capability.

## Authorization boundary

- Reuse the existing guest capability verification and bearer format; do not duplicate cryptography.
- Authority is derived from the completed booking receipt plus the presented capability, not from mutable credential or queue associations alone.
- The read must fail closed if durable booking/queue/session/clinic/tenant binding no longer matches the completed receipt.
- A capability for booking A must never authorize booking B, including same-clinic and same-session cases.
- Malformed, tampered, expired, revoked, substituted, or drifted credentials share one generic external rejection shape.

## Public response allow-list

The public serializer may expose only coarse guest-operational information needed for polling:

- participation state;
- coarse queue state;
- deterministic terminal state where applicable;
- non-identifying operational position information only if already supported by committed queue semantics.

It must not expose patient/contact data, internal IDs, clinic/doctor/session/tenant/membership identifiers, audit data, credential metadata, bearer material, database details, or implementation diagnostics.

## Side-effect and transport rules

- Read-only: no queue mutation, ETA prediction, notification, geofencing, rescheduling, staff override, analytics, or audit-event creation.
- Repeated and concurrent polling must be side-effect free.
- Responses must be `Cache-Control: no-store` and use a no-referrer policy consistent with the existing guest capability endpoints.

## Required PostgreSQL-backed evidence

1. A valid capability reads only its durably bound booking/queue participation.
2. Booking-A capability cannot read booking B, including same-clinic/same-session fixtures.
3. Cross-clinic/cross-tenant substitution and durable association drift fail closed.
4. Malformed/tampered/expired/revoked credentials produce the same generic external rejection shape.
5. Terminal booking/queue states serialize deterministically without private/internal data.
6. Public serialization is an explicit allow-list and contains no internal identifiers or bearer material.
7. Repeated and concurrent polling creates no mutation/version change/audit event.
8. Tests are non-vacuous, external-network free, and full CI remains green.

## Governance

This branch/PR is the single canonical WU63 production stream. ChatGPT is the initial material contract author and canonical implementer until a concrete failover is required; mechanical GitHub execution is tracked separately. ChatGPT is recused from sole final gating. Mistral Vibe is preferred for routine first-pass exact-head review, test-quality and failure-path analysis when its approved zero-cost path is concretely operational. Medium+ findings from any reviewer must be reconciled before merge. Preserve an eligible non-author exact-head final gate; escalate to Claude for security/privacy disputes or material high-risk findings. No paid fallback, PAYG, overage, credits, Vertex, OpenRouter, auto-topups, retired Gemini Agent/Chat, or duplicate implementation stream.