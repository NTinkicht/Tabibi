# WU70 - Account-owned dependent booking authorization

Canonical issue: #278

## Contract

WU70 extends the existing authenticated booking boundary so an authenticated account may book for self or one active dependent that is durably owned by that same account.

Authorization is server-side. A caller-provided dependent identifier is only a lookup key and never proof of ownership. The booking mutation must resolve ownership and active eligibility before persistence. Unknown, malformed, cross-account, archived, or concurrently archived dependents fail closed without revealing whether the dependent exists.

The existing booking transaction, availability checks, queue semantics, idempotency, and concurrency behavior remain authoritative. WU70 must not introduce a parallel booking implementation or weaken existing tenant/clinic/doctor boundaries.

## Privacy boundary

Public booking responses must not expose account or dependent database identifiers. Dependent names are display data only and must never become authorization, idempotency, routing, logging, or telemetry keys. No clinical data, family sharing/delegation, dependent guest bearer, notification-provider expansion, or paid dependency is introduced.

## Required executable evidence

- active owned dependent can be selected for one booking;
- cross-account substitution and archived/unknown dependents create zero booking/queue writes;
- archive-versus-booking race is covered against PostgreSQL and fails safely;
- retry/concurrency preserves the existing at-most-one logical booking guarantee;
- self-booking remains backward-compatible;
- Arabic/French/Unicode names do not affect authorization and do not leak to logs;
- exact-head CI is green and an independent non-author exact-SHA gate completes after all Medium+ findings are reconciled.
