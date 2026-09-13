# In-app notification inbox

WU33 adds a zero-network `in_app` delivery adapter and durable PostgreSQL inbox behind the existing notification authorization/rendering pipeline. WU34 adds exact-subject read acknowledgement without expanding that delivery boundary. WU35 adds an exact-subject unread count over that same repository boundary.

## Lifecycle boundary

`NotificationDispatchService` remains the owner of claim/fencing, current preference and consent evaluation, suppression, rendering, retry classification, and completion. The in-app adapter is invoked only after that service has authorized and rendered the delivery.

For `in_app`, routing identity is derived on every dispatch from the freshly authorized delivery context (`clinicId`, `subjectKind`, and `subjectId`) supplied separately from the rendered provider envelope. The adapter stores no constructor-bound subject scope. This prevents adapter reuse from misattributing one subject's message to another while keeping `RenderedNotificationDispatchEnvelope` free of clinic, patient, and account identifiers for external-provider compatibility.

An authorized dispatch persists through `InAppNotificationInboxStore.persist()`. Exact retries reuse the deterministic provider idempotency key and return `delivered` without creating a second row. Reuse of the same clinic/idempotency key for different logical content is rejected. Missing or mismatched in-app routing context fails closed, and unexpected persistence failures return a bounded `unknown` result so the existing outbox lifecycle can retry without persisting exception text.

Suppressed or unauthorized intents never invoke the renderer or the adapter. This keeps the WU27 final consent/preference gate authoritative.

## Read acknowledgement and unread count

`markRead()` is scoped to one inbox item plus the exact `clinicId`, `subjectKind`, and `subjectId`. A first successful acknowledgement records `read_at`; exact retries return the same item and preserve that first timestamp. A wrong clinic, subject, kind, or unknown item returns the same `null` not-found result and does not reveal or mutate another subject's row.

`unreadCount()` uses the same exact clinic/subject scope and counts only rows whose `read_at` remains null. Subjects with no matching unread rows receive zero, including wrong-clinic, wrong-subject, and wrong-kind scopes, so the aggregate does not widen the repository's isolation boundary. Marking an item read decreases the exact subject's count once; an idempotent `markRead()` retry does not create further count churn.

WU35 intentionally does not add an HTTP/UI surface, badge rendering, bulk acknowledgement, deletion/archive, retention behavior, or broader inbox enumeration. Those concerns must compose on top of the exact-subject repository contract rather than widening it.

## Persistence and privacy

The inbox stores only the exact clinic/subject routing key plus bounded rendered fields needed by the application inbox: provider idempotency key, template id, locale, direction, title, body, creation time, and nullable read time.

It must not persist raw phone/email/contact values, bearer or exchange credentials, provider credentials, clinical payloads, arbitrary template variables, raw notification intent payloads, or exception text. Reads and unread aggregation are exact-clinic plus exact-subject scoped; bounded listing remains limited to 1-100 rows ordered newest-first, and there is no cross-subject enumeration contract.

## Zero-extra-spend constraint

The adapter, read-state lifecycle, and unread-count aggregate perform no external network call and require no vendor credential, API credit, PAYG/overage, OpenRouter, Vertex, or other paid service.
