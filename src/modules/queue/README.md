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

Staff may restore a mistaken `no_show` or `cancelled` walk-in entry
(`POST .../queue/{entryId}/restore`, receptionist and clinic admin only): it
returns to `waiting`, or to `checked_in` at a fresh eligibility tail with
`checkIn`, drops any priority, advances the queue version and keeps the earlier
terminal transition in the audit trail. Appointment-linked entries are restored
through the appointment route so both records stay in step.

ETA, notifications, appointment-specific no-show rules, and transfer remain
outside this bounded work unit.
