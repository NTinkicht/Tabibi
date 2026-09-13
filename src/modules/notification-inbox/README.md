# In-app notification inbox

WU33 adds a zero-network `in_app` delivery adapter and durable PostgreSQL inbox behind the existing notification authorization/rendering pipeline. WU34 adds exact-subject read acknowledgement without expanding that delivery boundary.

## Lifecycle boundary

`NotificationDispatchService` remains the owner of claim/fencing, current preference and consent evaluation, suppression, rendering, retry classification, and completion. The in-app adapter is invoked only after that service has authorized and rendered the delivery.

For `in_app`, routing identity is derived on every dispatch from the freshly authorized delivery context (`clinicId`, `subjectKind`, and `subjectId`) supplied separately from the rendered provider envelope. The adapter stores no constructor-bound subject scope. This prevents adapter reuse from misattributing one subject's message to another while keeping `RenderedNotificationDispatchEnvelope` free of clinic, patient, and account identifiers for external-provider compatibility.

An authorized dispatch persists through `InAppNotificationInboxStore.persist()`. Exact retries reuse the deterministic provider idempotency key and return `delivered` without creating a second row. Reuse of the same clinic/idempotency key for different logical content is rejected. Missing or mismatched in-app routing context fails closed, and unexpected persistence failures return a bounded `unknown` result so the existing outbox lifecycle can retry without persisting exception text.

Suppressed or unauthorized intents never invoke the renderer or the adapter. This keeps the WU27 final consent/preference gate authoritative.

## Read acknowledgement

`markRead()` is scoped to one inbox item plus the exact `clinicId`, `subjectKind`, and `subjectId`. A first successful acknowledgement records `read_at`; exact retries return the same item and preserve that first timestamp. A wrong clinic, subject, kind, or unknown item returns the same `null` not-found result and does not reveal or mutate another subject's row.

WU34 intentionally does not add an HTTP/UI surface, bulk acknowledgement, unread counts, deletion/archive, or retention behavior. Those concerns must compose on top of the exact-subject repository contract rather than widening it.

## Persistence and privacy

The inbox stores only the exact clinic/subject routing key plus bounded rendered fields needed by the application inbox: provider idempotency key, template id, locale, direction, title, body, creation time, and nullable read time.

It must not persist raw phone/email/contact values, bearer or exchange credentials, provider credentials, clinical payloads, arbitrary template variables, raw notification intent payloads, or exception text. Reads are exact-clinic plus exact-subject scoped and bounded to 1-100 rows ordered newest-first; there is no cross-subject enumeration contract.

## Zero-extra-spend constraint

The adapter and read-state lifecycle perform no external network call and require no vendor credential, API credit, PAYG/overage, OpenRouter, Vertex, or other paid service.
