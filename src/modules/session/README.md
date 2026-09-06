# Session module

The session module owns the clinic-day operational read model and consultation-session commands.

- Reads require an authenticated `doctor`, `receptionist`, or `clinic_admin` membership and return only doctor identity, planned timing, lifecycle timestamps, state, and current delay metadata.
- Receptionists and clinic admins may operate sessions in their clinic. Doctors are additionally bound to their own doctor profile and clinic association. Platform administration grants no implicit access.
- Commands are explicit (`open`, `pause`, `resume`, `close`, `cancel`, and delay `declare`, `update`, `clear`) and carry correlation plus idempotency identities. Cancellation requires a reason.
- Successful command receipts and metadata-only audit events are durable. Reusing an idempotency key with a different command is a deterministic conflict.
- Open/resume retains the PostgreSQL doctor-global advisory lock and partial unique index. Terminal operations are session-only until queue behavior is implemented.
