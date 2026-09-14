# WU58 — Opaque public availability selection reference

Parent epic: #2
Issue: #248

## Goal

Bridge the merged public availability read model to a future guest booking flow without publishing internal clinic, doctor, session, user, tenant, membership, queue, or audit identifiers.

This slice introduces only an integrity-protected, short-lived selection reference and read-only resolution semantics. It does not create an appointment, identify a patient, grant booking authority, alter queue/session state, or weaken the existing appointment-domain checks.

## Security properties

A public selection reference must be:

- opaque to the client: no raw UUID or private domain field is intentionally exposed;
- integrity protected with server-held signing material;
- non-enumerable with sufficient entropy;
- bounded by an explicit expiry;
- context bound to exactly one clinic/doctor/session window;
- rejected on malformed encoding, invalid signature, expiry, unsupported version, or unexpected claim shape;
- resolved by re-checking current durable server truth rather than trusting the signed payload as current authorization.

Signing material must come from protected runtime configuration. It must never be serialized, logged, embedded in source defaults suitable for production, or returned through public errors.

## Resolution rules

Successful resolution requires all of the following to remain true at resolution time:

1. the clinic is active;
2. the doctor remains associated with that clinic;
3. the referenced session belongs to that exact clinic and doctor;
4. the session remains in a non-terminal state compatible with appointment booking (`planned`, `open`, or `paused`);
5. the referenced window still matches durable session start/end values and remains future-facing;
6. the reference is valid and unexpired.

Any failure returns a bounded public not-available/invalid result without revealing which private predicate failed.

Possession or successful resolution of a reference is not booking authorization. A later booking mutation must independently re-check its full appointment-domain invariants, patient/guest requirements, consent/policy, idempotency, and concurrency behavior.

## Time and determinism

Production code may use the server clock through an injectable clock boundary. Tests must use a fixed clock so expiry/future-window assertions do not race the wall clock.

Expiry semantics are instant-based. Display localization of a service date/window is separate from token validity and must not become an authorization input.

## Mutation boundary

Issuing or resolving the reference is read-only with respect to clinical/operational state. It must not:

- generate consultation sessions;
- create/update appointments;
- create/update queue entries;
- alter clinic/doctor associations;
- write patient/guest identity data;
- emit an audit event merely for ordinary public availability reading.

If future abuse telemetry is added, it must be separately privacy-reviewed and must not carry the hidden reference payload or internal identifiers into public analytics.

## Required executable evidence

Tests must prove, without external network dependencies:

1. a valid reference resolves to the exact eligible current availability window;
2. tampered, malformed, unsupported-version and expired references fail closed;
3. clinic deactivation invalidates a previously issued reference;
4. doctor-clinic association removal invalidates it;
5. terminal or stale session state invalidates it;
6. session start/end drift invalidates the old reference rather than silently retargeting it;
7. same-name clinics and doctors remain isolated by internal identity;
8. public serialized reference and resolved output contain none of the raw fixture UUIDs/private names;
9. repeated issue/resolve reads leave session, appointment, queue and audit counts unchanged;
10. expiry/future checks use a fixed injected clock and are deterministic.

## Governance

Exactly one canonical stream: `wu58-opaque-availability-reference` / its single PR.

Initial material contract author: ChatGPT. Mechanical GitHub executor: ChatGPT connector. ChatGPT is therefore recused from being the sole final gate for any exact head containing materially equivalent implementation it later authors.

Mistral Vibe is the preferred routine first-pass reviewer when its included-capacity route is concretely operational. Claude is reserved for privacy/security escalation or final gating when appropriate. All Medium+/Major+/High+/Critical/Blocker findings from any reviewer source are mandatory to reconcile.

Merge requires fully green exact-head CI, an eligible independent non-author exact-SHA gate, unchanged reviewed head, and no unresolved mandatory findings.

Zero-extra-cost only: no paid APIs, PAYG/overage/credits, Vertex, OpenRouter, auto-topups, or retired Gemini Agent/Chat.
