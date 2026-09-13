# In-app notification inbox

WU33 adds a zero-network `in_app` delivery adapter and durable PostgreSQL inbox behind the existing notification authorization/rendering pipeline.

## Lifecycle boundary

`NotificationDispatchService` remains the owner of claim/fencing, current preference and consent evaluation, suppression, rendering, retry classification, and completion. The in-app adapter is invoked only after that service has authorized and rendered the delivery.

For `in_app`, composition must bind `InAppNotificationProviderAdapter` to exactly one routing scope: `clinicId`, `subjectKind`, and `subjectId`. The adapter receives only the WU30 rendered dispatch envelope. Routing identity is constructor-bound and is deliberately not added to `RenderedNotificationDispatchEnvelope`, so the external-provider boundary remains free of clinic, patient, and account identifiers.

An authorized dispatch persists through `InAppNotificationInboxStore.persist()`. Exact retries reuse the deterministic provider idempotency key and return `delivered` without creating a second row. Reuse of the same clinic/idempotency key for different logical content is rejected. Unexpected persistence failures return a bounded `unknown` result so the existing outbox lifecycle can retry without persisting exception text.

Suppressed or unauthorized intents never invoke the renderer or the adapter. This keeps the WU27 final consent/preference gate authoritative.

## Persistence and privacy

The inbox stores only the exact clinic/subject routing key plus bounded rendered fields needed by the application inbox: provider idempotency key, template id, locale, direction, title, body, and creation time.

It must not persist raw phone/email/contact values, bearer or exchange credentials, provider credentials, clinical payloads, arbitrary template variables, raw notification intent payloads, or exception text. Reads are exact-clinic plus exact-subject scoped and bounded to 1-100 rows ordered newest-first; there is no cross-subject enumeration contract.

## Zero-extra-spend constraint

The adapter performs no external network call and requires no vendor credential, API credit, PAYG/overage, OpenRouter, Vertex, or other paid service.
