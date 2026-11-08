# Queue

The queue module owns walk-in registration and the bounded receptionist lifecycle.

Receptionist and clinic-admin commands are clinic/session/entry scoped and support
`waiting -> checked_in -> called -> in_consultation -> completed`. A checked-in or
called entry may become `no_show`; a waiting, checked-in, or called entry may be
cancelled with a required patient/clinic source and operational reason. Commands
lock the session and entry in PostgreSQL, use durable actor-scoped idempotency
receipts, and emit metadata-only audit events. Partial unique indexes prevent more
than one called or in-consultation entry in a session.

Authorized priority overrides use the canonical optional `priority_order`, kept
separate from immutable `registration_order` and arrival `eligibility_order`.
Priority changes lock the session in PostgreSQL, require a metadata-only
operational reason, validate an optimistic queue version, persist an exact-retry
receipt, and audit both the prior and resulting priority cohort. Call selection
uses eligible priority entries first and normal eligibility order second.

Walk-in restore (`restore.ts`, `POST .../queue/[entryId]/restore`) returns a
cancelled or no-show walk-in entry to `waiting`, or to `checked_in` at a fresh
eligibility tail, for receptionist/clinic_admin with a reason and an idempotency
key; live priority is never carried back and appointment-backed entries are
refused (they restore through appointment recovery). Walk-in transfer
(`transfer.ts`, `POST .../queue/[entryId]/transfer`) moves a waiting, checked-in
or called walk-in entry to another planned/open/paused session of the same
doctor: the source is cancelled with a `transfer` cause in the audit event, and
the target entry is `waiting` (from waiting) or `checked_in` at the target tail
(from checked-in or called); called status and priority never carry over, and
consulting, terminal and appointment-backed entries are refused. ETA,
notifications and appointment-specific no-show rules remain outside this
bounded work unit.
