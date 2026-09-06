# session

This directory owns authenticated, clinic-scoped operational session reads and the
`open`, `pause`, `resume`, `close`, `cancel`, and doctor-delay commands. Every command
requires correlation and idempotency identities and commits its metadata-only audit
event and durable retry receipt atomically with the session mutation. Open/resume
take a doctor-keyed PostgreSQL advisory lock; the doctor-global partial unique index
remains the final concurrency guarantee. Queue-dependent close/cancel behavior is
intentionally deferred.
