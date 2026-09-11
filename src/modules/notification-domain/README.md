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
immutable notification intent identifier. The same logical intent therefore uses
the same provider key across retries, including retries after `unknown`, provider
exceptions, or expired claims, so a provider that accepted an earlier request can
deduplicate a later retry. Payload content and attempt counters are not included
in that key. WU24 intentionally defines no real SMS, WhatsApp, push, credential,
scheduler, or network implementation; those remain later bounded slices behind
this contract.

WU25 adds a deterministic, clinic-scoped discovery and bounded execution layer.
`NotificationDispatchEligibilityRepository` returns only intent identifiers and
their eligibility timestamp; it never returns notification payloads. It excludes
terminal/superseded intents, exhausted attempt budgets, not-yet-due retries, and
active unexpired claims, then orders eligible rows by due time with stable
persisted tie breakers. Batch size is explicitly bounded to 1-100 intents.

`NotificationDispatchBatchRunner` consumes that read-only scan and invokes the
existing single-intent dispatch boundary once per selected identifier. Selection
is not ownership: concurrent runners still race through the WU21 atomic claim
fence, so a losing runner records `notClaimed` rather than creating a second
ownership mechanism. The returned batch summary contains aggregate counts only
(`selected`, `completed`, `notClaimed`, `claimLost`) and therefore does not expose
provider payloads or patient-sensitive notification data. WU25 deliberately does
not add a timer, cron process, daemon, queue consumer, real provider network call,
or cross-clinic scheduler.
