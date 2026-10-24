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

`SchedulingService.setTemplateActive` retires or restores a recurring template
(TAB-P0-02, #647). Only a `clinic_admin` or the template's own doctor may change
it; a non-member or receptionist is denied before the lookup. An unknown id and
another clinic's template id both fail with `ScheduleTemplateNotFoundError`.
Deactivation leaves already generated sessions unchanged; later generation skips
the template. Reactivation re-runs the doctor collision check under the same
per-doctor lock as template creation and fails with `ScheduleCollisionError` on
overlap. A real change writes `schedule_template.deactivated` or
`schedule_template.activated`; setting the current state is a no-op without audit.

A clinic admin can remove a clinic closure day with
`SchedulingService.removeClosure` (#649). Only that clinic's closure is deleted,
one `clinic_closure.removed` audit event is written, and removing a day that is
not a closure is a no-op. Removal takes the clinic calendar lock; it does not
generate sessions itself, so the next generation plans the reopened day.
