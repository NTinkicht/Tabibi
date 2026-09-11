# notification-domain

This directory owns the **notification-domain** module boundary. Its domain,
application, and adapter code must expose intentional public APIs rather than
importing another module's internals.

The provider-neutral outbox persists the result of a claimed dispatch attempt as
`delivered`, retryable `failed`, `unknown`, or terminal `dead_letter`. Retryable
outcomes use deterministic attempt-based delays (1 minute, 5 minutes, 15 minutes,
1 hour, then 4 hours), and a claim is rejected until `next_attempt_at` is due.
Completion at the configured maximum attempt atomically becomes `dead_letter`.
Every completion is clinic-scoped and fenced by the current claim token, so a
superseded intent or stale worker cannot publish a late outcome.
