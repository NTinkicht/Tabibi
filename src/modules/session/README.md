# Session module

Owns consultation-session lifecycle and receptionist operations. The operational API is clinic-scoped, requires a signed `tabibi_staff_session` cookie, applies server-side membership/doctor ownership checks, same-origin mutation checks, and an `Idempotency-Key` on every command. Set `STAFF_SESSION_SECRET` to a secret of at least 32 characters; authentication issuance remains the identity provider's responsibility.

Session commands (`open`, `pause`, `resume`, `close`, `cancel`) and versioned delay commands are transactionally persisted and metadata-only audited. `open`/`resume` share the doctor advisory-lock boundary and database uniqueness invariant. This module intentionally has no patient, appointment, queue, ETA, guest credential, or notification-delivery behavior.
