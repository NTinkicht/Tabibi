# Queue

The queue module owns walk-in registration and the bounded receptionist lifecycle.

Receptionist and clinic-admin commands are clinic/session/entry scoped and support
`waiting -> checked_in -> called -> in_consultation -> completed`. A checked-in or
called entry may become `no_show`; a waiting, checked-in, or called entry may be
cancelled with a required patient/clinic source and operational reason. Commands
lock the session and entry in PostgreSQL, use durable actor-scoped idempotency
receipts, and emit metadata-only audit events. Partial unique indexes prevent more
than one called or in-consultation entry in a session.

Checked-in entries receive a mutable `service_order` that is separate from the
immutable `registration_order` and arrival `eligibility_order`. Authorized
reorders lock the session in PostgreSQL, require a metadata-only operational
reason, validate an optimistic queue version, persist an exact-retry receipt,
and audit both the prior and resulting order. Normal call selection accepts only
the first checked-in entry in that committed order.

ETA, notifications, appointment-specific no-show rules, restore, and transfer
remain outside this bounded work unit.
