# WU61 - Guest booking cancellation via capability

Issue: #258
Parent epic: #2

## Contract

A guest holding the existing guest-access capability may cancel only the booking and queue participation durably bound to that capability.

The implementation must reuse the established guest capability verification and durable-scope checks. It must not define a new bearer format, duplicate signing/verification logic, or accept raw internal identifiers from the public caller.

Cancellation is one PostgreSQL transaction. The appointment state, queue-entry state, and required operational audit record must either commit together or roll back together. The mutation must lock/revalidate the durable booking/queue relationship before changing state.

Repeated or concurrent duplicate cancellation requests must converge safely to one committed cancellation outcome without duplicate operational side effects. Completed, no-show, or otherwise non-cancellable terminal states remain unchanged.

All public failures use one generic non-oracular shape. Public success serialization is an explicit allow-list and contains no patient, appointment, queue, clinic, doctor, session, tenant, membership, audit, user, credential, or other internal identifiers.

## Required PostgreSQL evidence

- valid capability cancels exactly its bound appointment and queue entry;
- repeated cancellation is idempotent;
- concurrent duplicate cancellation converges safely;
- concurrent cancellation of distinct prioritized bookings in one session must exercise the priority-cohort path under session-row-first locking without deadlock or partial mutation;
- booking-A capability cannot cancel booking B;
- cross-clinic/cross-tenant substitution and durable association drift cannot mutate state;
- malformed, tampered, expired, and revoked credentials produce the same safe rejection and zero writes;
- terminal non-cancellable states remain unchanged;
- injected late failure rolls back appointment, queue, and audit together;
- audit content is privacy-safe and emitted only for the committed mutation;
- public serialization contains no internal IDs, private contact data, bearer material, or database details;
- no external network dependency is required.

## Governance

Exactly one canonical WU61 branch and PR are allowed. The current canonical branch is `wu61-guest-booking-cancellation`. Material authorship and mechanical GitHub execution are tracked separately. ChatGPT authored this initial contract and is recused from sole final gating. Every Medium+/Major+/High+/Critical/Blocker reviewer finding must be reconciled before merge. Zero-extra-cost policy remains binding.
