# scheduling

This directory owns recurring schedule templates and occurrence generation.
`SchedulingService.generateSessions` accepts an explicit clinic scope, start date,
and configurable horizon of 7–366 days. Stable occurrence identifiers and a
PostgreSQL uniqueness constraint make retries and concurrent generators idempotent.
Local template times are converted using the clinic's configured IANA timezone.

One doctor never has two overlapping non-cancelled sessions in one clinic
(TAB-P0-02, #640): manual session creation rejects an overlap, and generation
skips any occurrence that would overlap an existing session of that doctor,
counting it as `skippedCollisions` in the `sessions.generated` audit event. The
clinic calendar advisory lock serializes both paths.
