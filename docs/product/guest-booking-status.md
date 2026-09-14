# WU60 Guest Booking Status Contract

Parent issue: #252

## Purpose

Provide a privacy-safe, read-only patient-facing projection of the booking and queue state created by WU59. Authorization is possession of a valid existing guest-access capability; no raw internal resource identifier is accepted as authority.

## Authorization boundary

- Reuse the existing guest-access bearer verification primitives and lifecycle rules.
- Do not introduce a second bearer format, signer, verifier, key source, or independent cryptographic implementation.
- Resolve the capability to its server-side appointment scope, then re-check durable appointment/queue/clinic state before returning data.
- Invalid, malformed, tampered, expired, revoked, cross-scope, or otherwise unauthorized capabilities fail closed through the same privacy-safe external rejection shape.

## Public projection

The response is an explicit allow-list intended for Arabic/French mobile presentation. It may include only fields required for a guest to understand the visit, such as:

- booking lifecycle state;
- service date and already-approved public service window;
- privacy-safe queue state / called indication already exposed by the queue domain;
- locale-facing labels derived from approved public enums.

The response must not contain raw patient, appointment, queue, clinic, doctor, consultation-session, tenant, user, membership, audit, template, or other internal identifiers. It must not contain private patient display/contact data, token plaintext, token claims, signing material, database diagnostics, or persistence rows.

## Side-effect rule

Status retrieval is read-only. Ordinary reads must not:

- mutate appointment or queue state;
- rotate or mint guest capabilities;
- generate consultation sessions;
- write audit events merely because a status was read;
- call external providers or networks.

## Lifecycle behavior

Projection must derive from durable existing domain state. It must not create a parallel lifecycle. Existing states such as booked, checked-in, called, completed, cancelled, and no-show are projected deterministically when those states are valid in the current domain.

## Privacy and isolation

- A capability scoped to one booking cannot read any other booking.
- Same-clinic, same-doctor, and similarly named fixtures must remain isolated.
- Cross-clinic or cross-tenant substitution must not disclose whether another resource exists.
- Public failures remain non-oracular.

## Required executable evidence

1. valid WU59 capability returns the correct current public booking/queue projection;
2. malformed, tampered, expired, or otherwise invalid capability fails closed with the same external error shape;
3. booking A capability cannot read booking B;
4. cross-clinic/cross-tenant or durable-scope drift cannot disclose state;
5. serialized output contains no internal IDs, private contact/display fields, membership/audit data, bearer claims, or raw database details;
6. lifecycle projection is deterministic and grounded in existing domain states;
7. repeated reads cause zero appointment, queue, session, audit, or capability mutation;
8. Arabic/French locale behavior is deterministic where localization is present;
9. PostgreSQL-backed tests prove non-vacuous behavior with no external network dependency;
10. existing WU56-WU59 behavior remains green.

## Explicitly out of scope

Guest cancellation, rescheduling, check-in mutation, notifications, ETA calculation, new queue lifecycle states, and new authentication mechanisms are not part of WU60.
