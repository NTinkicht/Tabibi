# Notification template rendering boundary

WU28 provides deterministic, provider-neutral Arabic/French rendering. Template
IDs include an immutable copy version (`.v1`); `sourceIntentVersion` separately
preserves outbox ordering and supersession provenance. Unsupported locales fall
back to French, while Arabic regional tags render Arabic with RTL metadata.

The renderer accepts only a plain root object and exact, per-template allowlists
of non-negative operational integers. It rejects extra fields, nested values,
strings, symbols, unknown IDs and malformed versions. Therefore clinical data,
names, contact values or hashes, guest bearer credentials, provider identifiers,
secrets and arbitrary outbox payloads cannot enter or leave rendered copy.
Validation errors are generic and never reflect rejected values.

Rendering does not authorize delivery. A future adapter must independently load
the clinic-scoped preference immediately before dispatch, enforce
`isNotificationDeliveryEligible`, resolve destinations outside this boundary,
and retain outbox claim/version/idempotency fencing. Adapters and observability
must not log rendered bodies, destinations or provider payloads. This module
performs no network/provider dispatch and introduces no paid route.
