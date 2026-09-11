# notification-domain

This directory owns the **notification-domain** module boundary. Its domain,
application, and adapter code must expose intentional public APIs rather than
importing another module's internals.

The provider-neutral outbox persists the result of a claimed dispatch attempt as
`delivered`, retryable `failed`, `unknown`, or terminal `dead_letter`. `failed`
and `unknown` are immediately eligible for another explicit claim; this bounded
foundation intentionally does not calculate delays or run a scheduler/backoff
worker. Every completion is clinic-scoped and fenced by the current claim token,
so a superseded intent or stale worker cannot publish a late outcome.
