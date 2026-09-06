# scheduling

This directory owns recurring schedule templates and occurrence generation.
`SchedulingService.generateSessions` accepts an explicit clinic scope, start date,
and configurable horizon of 7–366 days. Stable occurrence identifiers and a
PostgreSQL uniqueness constraint make retries and concurrent generators idempotent.
Local template times are converted using the clinic's configured IANA timezone.
