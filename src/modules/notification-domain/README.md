# notification-domain

This directory owns the **notification-domain** module boundary. Its domain,
application, and adapter code must expose intentional public APIs rather than
importing another module's internals.

The provider-neutral outbox persists the result of a claimed dispatch attempt as
`delivered`, retryable `failed`, `unknown`, or terminal `dead_letter`. Retryable
outcomes use deterministic attempt-based delays (1 minute, 5 minutes, 15 minutes,
1 hour, then 4 hours), and a claim is rejected until `next_attempt_at` is due.
Completion at the configured maximum attempt atomically becomes `dead_letter`.
Every completion is clinic-scoped and fenced by the current claim token and lease
expiry, so a superseded intent or stale worker cannot publish a late outcome.

`NotificationDispatchService` is the provider-neutral application boundary for
one dispatch attempt. It claims one specific persisted intent, invokes exactly one
injected provider adapter, maps the provider result onto the existing persisted
outcomes, and completes only the exact claim token. Provider exceptions are
classified as `unknown`; delivery success is never invented when execution is
indeterminate. If completion loses the claim fence after provider execution, the
service reports `claim_lost` and leaves recovery to the persisted lease/retry
lifecycle.

Provider adapters receive a deterministic idempotency key derived only from the
notification intent identifier and persisted attempt count. Payload content is
not included in that key. WU24 intentionally defines no real SMS, WhatsApp, push,
credential, scheduler, or network implementation; those remain later bounded
slices behind this contract.
