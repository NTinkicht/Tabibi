# Tabibi Architecture — Foundation Proposal v0.1

This is a proposal for independent review before production implementation.

## Architecture goals
- Simple deployment and local development.
- Strong transactional consistency for queue mutations.
- Clear separation between queue domain logic and notification delivery.
- Localization/RTL-ready UI.
- Minimal healthcare data footprint.
- Easy extraction into services later without premature microservices.

## Proposed initial stack

### Application
- TypeScript end-to-end.
- Next.js for web application and server-side UI/API boundary.
- PostgreSQL as the system of record.
- Prisma ORM initially, provided transaction/concurrency requirements are demonstrably met.

### Testing
- Unit tests for pure queue/estimation domain logic.
- Integration tests against PostgreSQL for transaction/concurrency behavior.
- API tests for authorization and state transitions.
- End-to-end tests for critical receptionist/patient flows.

This stack is intentionally provisional. Claude should challenge it before implementation.

## Deployment shape

Begin as a modular monolith:

- identity/access module
- clinic module
- scheduling/session module
- queue module
- estimation module
- notification-domain module
- audit module
- localization/UI module

All modules share one PostgreSQL database initially, but domain boundaries must be explicit.

## Core entities — preliminary

### Clinic
- id
- name
- timezone
- locale defaults
- status

### User
Authentication identity. Do not overload this entity with patient medical data.

### ClinicMembership
Maps users to clinic-scoped roles and permissions.

### DoctorProfile
Represents a clinician within a clinic context.

### ConsultationSession
A bounded queue/service period for one doctor at one clinic.
Fields should include lifecycle status, planned start/end, actual start/end, pause/delay state and estimator configuration snapshot.

### QueueEntry
Represents one patient's place in one consultation session.
Must support both account-linked patients and receptionist-created guests.
Contains queue lifecycle state, ordering data, check-in timestamps and privacy-preserving external access data.

### QueueEvent / AuditEvent
Append-oriented event history for operationally meaningful mutations such as creation, check-in, reordering, priority insertion, call, consultation start/end, cancellation, no-show and session pause/resume.

### NotificationIntent
Records that a domain event warrants a notification. Provider-specific delivery should not be part of queue mutation transactions except through durable outbox-style handoff.

## Queue consistency

Queue mutation is a high-risk concurrency boundary.

Initial design requirement:
- every state transition is validated against a state machine;
- changes affecting order/position execute transactionally;
- conflicting concurrent updates cannot silently overwrite one another;
- queue order has an explicit persisted representation;
- priority/manual reorder requires authorization and an audit reason;
- estimates are recomputed from committed queue/session state.

Implementation strategy (row locks, optimistic versioning, serializable transactions, advisory locks, etc.) should be selected after explicit concurrency tests are designed.

## Queue state machine — proposed

waiting -> checked_in -> called -> in_consultation -> completed

Allowed alternate terminal paths where context permits:
- waiting/checked_in -> cancelled
- waiting/checked_in/called -> no_show

Rollback/recovery transitions must be explicit administrative actions and audited; do not silently permit arbitrary state mutation.

## Estimation engine

Keep estimator as a pure/domain-oriented component receiving a snapshot of relevant session/queue facts.

Initial deterministic model should combine:
- active entries ahead;
- doctor/session baseline duration;
- robust statistic from completed consultations in current session when enough samples exist;
- active consultation elapsed time;
- pauses/delays;
- known terminal/non-serving entries excluded from work ahead.

The first model must expose which inputs produced the estimate. Avoid hidden ML in the MVP.

## Patient queue access

Patient-facing queue access must not expose sequential identifiers that make enumeration easy.

For account-linked patients, authenticated ownership can authorize access.

For guest/reception-entered patients, use a high-entropy, revocable external access token or equivalent privacy-preserving mechanism. Public queue displays should use non-identifying labels/tokens.

## Notifications

Queue mutation emits domain events / durable notification intents.

A worker/provider adapter later delivers SMS/push/WhatsApp/email. Failed delivery must not roll back queue state.

Notification deduplication/idempotency is required before enabling real provider delivery.

## Localization

All user-facing strings externalized. Locale resolution should support French and Arabic from the start. Components must tolerate RTL layout.

## Observability

Application logs must not casually include patient names, phone numbers, access tokens or sensitive identifiers.

Audit events are distinct from operational logs.

## Open questions for architecture review
1. Is Next.js modular-monolith architecture sufficient for an MVP with real-time queue updates, or should we separate the API/runtime earlier?
2. Is Prisma adequate for the exact PostgreSQL locking/isolation strategy we choose?
3. Should queue history be a conventional audit table, event-sourced aggregate, or hybrid append log?
4. What is the minimum patient identity model for Algeria without creating unnecessary healthcare-data exposure?
5. What notification channel should be first in a deployable pilot?
6. What offline/degraded workflow must reception support if connectivity is poor?

These questions should not block foundation review unless a choice is required to prevent costly rework.
