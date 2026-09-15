# WU62 - Guest booking check-in via capability

Issue: #260
Parent epic: #2

## Contract

A guest holding the existing guest-access capability may check in only the booking and queue participation durably bound to that capability.

The implementation must reuse the established guest capability verification and bearer format. It must not define a second credential format, duplicate signing/verifier logic, or accept raw internal identifiers from the public caller.

Check-in is one PostgreSQL transaction. Appointment state, queue-entry state, any required session/version mutation, and the operational audit record must either commit together or roll back together. Lock ordering must be deterministic and compatible with the existing queue, reorder, and cancellation paths; when session-shared state can be touched, acquire the capability-bound consultation-session row before appointment/queue rows and revalidate durable scope after the lock is held.

Repeated or concurrent duplicate check-in requests must converge safely to one committed outcome without duplicate audit or other operational side effects. Cancelled, completed, no-show, or otherwise non-check-in-eligible states remain unchanged.

All public failures use one generic non-oracular shape. Public success serialization is an explicit allow-list and contains no patient, appointment, queue, clinic, doctor, session, tenant, membership, audit, user, credential, bearer, or database identifiers/details.

## Required PostgreSQL evidence

- valid capability checks in exactly its bound appointment and queue entry atomically;
- repeated check-in is idempotent;
- concurrent duplicate check-in converges safely;
- separately credentialed same-session check-ins exercise deterministic lock ordering without deadlock or partial mutation;
- booking-A capability cannot check in booking B;
- cross-clinic/cross-tenant substitution and durable association drift cannot mutate state;
- malformed, tampered, expired, and revoked credentials produce the same safe rejection and zero writes;
- cancelled, completed, no-show, and other non-eligible states remain unchanged;
- injected late failure rolls back appointment, queue/session, and audit together;
- audit content is privacy-safe and emitted only for the committed mutation;
- public serialization contains no internal IDs, private contact data, bearer material, or database details;
- no external network dependency is required.

## Governance

Exactly one canonical WU62 branch and PR are allowed. The canonical branch is `wu62-guest-booking-check-in`. Material authorship and mechanical GitHub execution are tracked separately. ChatGPT authored this initial contract and is recused from sole final gating for materially authored work. Mistral Vibe is preferred for routine first-pass exact-head review/test-quality/failure-path analysis when concretely operational. Every Medium+/Major+/High+/Critical/Blocker finding is mandatory to reconcile before merge. Because this work crosses capability/privacy/concurrency boundaries, preserve an eligible non-author final gate. Zero-extra-cost policy remains binding.
