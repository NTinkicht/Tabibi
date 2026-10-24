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

Generation also skips any occurrence whose local start or end wall time does not
exist on its service date in the clinic's timezone (a DST spring-forward gap,
#645), instead of storing a shifted or zero-length session. Such skips are
counted as `skippedNonexistentLocalTime` in the same audit event; the remaining
occurrences of the call are generated normally.
