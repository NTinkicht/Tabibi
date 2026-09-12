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

Waiting-state copy never presents registration order as a live queue position.
Material estimate updates use provisional lower/upper minute bounds and explicitly
state that the estimate may change; inverted uncertainty windows fail closed.

A remotely enabled guest transfer is the sole narrow post-decryption composition
exception. The general renderer still rejects arbitrary strings and exchange URLs.
After the fresh single-use exchange URL has been resolved outside this module,
`composeGuestTransferExchangeLink` may append it only to an already-rendered
`queue_entry_transferred.v1` message, and only when it is HTTPS, has no embedded
credentials/query/fragment, and matches `/g/exchange/<opaque-id>`.

Rendering does not authorize delivery. A future adapter must independently load
the clinic-scoped preference immediately before dispatch, enforce
`isNotificationDeliveryEligible`, resolve destinations outside this boundary,
and retain outbox claim/version/idempotency fencing. Adapters and observability
must not log rendered bodies, destinations or provider payloads. This module
performs no network/provider dispatch and introduces no paid route.
