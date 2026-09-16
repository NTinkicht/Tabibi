# WU70 - Account-owned dependent booking authorization

Canonical issue: #278

## Contract

WU70 extends the existing authenticated booking boundary so an authenticated account may book for self or one active dependent that is durably owned by that same account.

The existing clinic-role prerequisite remains authoritative: the caller must first satisfy the current `receptionist` or `clinic_admin` authorization enforced by `AppointmentService.bookForExistingPatient`. Account ownership and active-dependent eligibility are additional requirements for dependent selection and never replace clinic-role authorization.

Authorization is server-side. A caller-provided dependent identifier is only a lookup key and never proof of ownership. The booking mutation resolves the selected patient record, verifies that it is account-linked to the authenticated actor for dependent booking, then locks the owned active dependent row inside the same booking transaction. The dependent status is rechecked while locked and the row lock is held through booking persistence. This serializes archive races: archive-first causes dependent booking to fail closed, while booking-first commits before a waiting archive can complete. Unknown, malformed, cross-account, archived, or concurrently archived dependents all fail with the same dependent-unavailable response without revealing whether the dependent exists.

The existing booking transaction, availability checks, queue semantics, idempotency, and concurrency behavior remain authoritative. WU70 must not introduce a parallel booking implementation or weaken existing tenant/clinic/doctor boundaries.

## Persistence and privacy boundary

A nullable `appointments.dependent_id` is the minimum durable reference required to preserve the selected booking subject through the appointment lifecycle. It is protected by a restrictive foreign key to the account-owned dependent record. The queue continues to use the account-linked patient operational record for existing operational/contact semantics.

Booking responses do not serialize the dependent identifier or owner identifier. Dependent names are display data only and never become authorization, idempotency, routing, logging, telemetry, or audit keys. Audit metadata records only whether the subject kind is `self` or `dependent`. No clinical data, family sharing/delegation, dependent guest bearer, notification-provider expansion, or paid dependency is introduced.

## Required executable evidence

- active owned dependent can be selected for one booking and the internal durable dependent reference is persisted without being serialized in the booking response;
- malformed, unknown, cross-account, and archived dependent identifiers produce the same public failure and create zero rows in `queue_entries`, `appointments`, `appointment_booking_receipts`, and appointment `audit_events`;
- archive-versus-booking race is covered against PostgreSQL and fails safely under transaction-held dependent-row serialization;
- retry/concurrency preserves the existing at-most-one logical booking guarantee;
- self-booking remains backward-compatible;
- Arabic/French/Unicode names do not affect authorization and do not leak to responses, logs, or audit metadata;
- exact-head CI is green and an independent non-author exact-SHA gate completes after all Medium+ findings are reconciled.
