# Tabibi Architecture — Foundation Proposal v0.3

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
A bounded queue/service period for one doctor at one clinic. Fields should include lifecycle status, planned start/end, actual start/end, pause/delay state and estimator configuration snapshot.

### QueueEntry
Represents one patient's place in one consultation session. Must support both account-linked patients and receptionist-created guests. Contains queue lifecycle state, immutable registration/booking order, call-eligibility order, check-in timestamps and privacy-preserving external access data.

### QueueEvent / AuditEvent
Append-oriented event history for operationally meaningful mutations such as creation, check-in, reordering, priority insertion, call, consultation start/end, cancellation, no-show and session pause/resume/cancellation.

### NotificationIntent
Records that a domain event warrants a notification. Provider-specific delivery should not be part of queue mutation transactions except through durable outbox-style handoff.

## Queue consistency

Queue mutation is a high-risk concurrency boundary.

Initial design requirement:
- every state transition is validated against a state machine;
- changes affecting order/position execute transactionally;
- conflicting concurrent updates cannot silently overwrite one another;
- queue order has explicit persisted representations;
- priority/manual reorder requires authorization and an audit reason;
- estimates are recomputed from committed queue/session state.

Implementation strategy (row locks, optimistic versioning, serializable transactions, advisory locks, etc.) should be selected after explicit concurrency tests are designed.

## Canonical queue state values

Persisted/database/API values are exactly:

`waiting`, `checked_in`, `called`, `in_consultation`, `completed`, `cancelled`, `no_show`.

Localized UI labels may differ, but domain schemas, payloads and tests must use these snake_case values consistently.

## Queue state machine — proposed

waiting -> checked_in -> called -> in_consultation -> completed

Allowed alternate terminal paths where context permits:
- waiting/checked_in/called -> cancelled
- waiting/checked_in/called -> no_show

Rollback/recovery transitions must be explicit administrative actions and audited; do not silently permit arbitrary state mutation.

### Arrival and call eligibility contract

`waiting` means the patient has a place in the session but is not yet confirmed physically present and ready to be called. `checked_in` means the patient is present and eligible for normal calling.

Each queue entry has two distinct ordering concepts:
1. `registration_order`: immutable historical booking/registration order used for audit and scheduling context;
2. `eligibility_order`: normal service-order key assigned transactionally when the entry becomes `checked_in`.

Rules:
- only `checked_in` entries are normally call-eligible;
- a `waiting` entry never blocks an eligible `checked_in` entry;
- among normal call-eligible entries, `eligibility_order` determines who is next, subject only to an explicit authorized priority override;
- an unarrived `waiting` entry does not reserve service capacity ahead of already checked-in patients;
- when an entry changes `waiting -> checked_in`, it receives an `eligibility_order` after the current normal checked-in cohort, so a late arrival cannot overtake patients who were already present;
- `registration_order` remains immutable and is never silently rewritten to mimic service order;
- assignment of `eligibility_order`, check-in mutation, estimate recomputation and any related audit event happen transactionally;
- concurrent check-in-versus-call operations must serialize so exactly one committed history determines whether a newly arrived patient was present before or after the call boundary;
- the estimator excludes unarrived `waiting` entries from active work-ahead for patients already `checked_in`;
- direct `waiting -> called` is disallowed in normal workflow; staff must check the patient in first unless a separately audited administrative override exists.

Required tests include mixed arrival ordering, late arrival behind an existing checked-in cohort, simultaneous check-ins, and concurrent check-in/call races against PostgreSQL.

### Consultation session lifecycle

Proposed normal states:

planned -> open -> paused -> open -> closing -> closed

A separate terminal state `cancelled` represents an abandoned service session.

#### Normal closure
- a normal `close` operation is rejected while any queue entry remains in `waiting`, `checked_in`, `called`, or `in_consultation`;
- staff must first resolve remaining entries explicitly as `completed`, `cancelled`, or `no_show` as appropriate;
- `closing` serializes shutdown and rejects new queue mutations while final invariants are checked;
- transition to `closed`, final queue-entry validation, session timestamps, audit event and notification intents are atomic;
- concurrent close-versus-check-in/call/add/reorder operations must produce one deterministic winner;
- forced administrative closure is outside the MVP.

#### Session cancellation
Session cancellation is distinct from normal closure and is an MVP operation because clinics may cancel a doctor's remaining session.

Contract:
- only an authorized clinic role may initiate cancellation and a non-empty reason is mandatory;
- cancellation is rejected if any queue entry is `in_consultation`; the active consultation must first finish normally, unless a future elevated emergency-stop workflow is introduced;
- cancellation first obtains the session-level serialization/lock boundary used for queue mutation, preventing new add/check-in/call/reorder/start-consultation commits once cancellation wins;
- in the same transaction, every remaining `waiting`, `checked_in`, or `called` entry transitions to `cancelled` with a machine-readable session-cancellation cause plus human audit reason;
- their pending/live estimates become terminal/unavailable;
- the session transitions to `cancelled` with cancellation timestamp, actor and reason;
- audit records and durable `session_cancelled` notification intents for affected entries are inserted transactionally with the state changes;
- notification delivery happens asynchronously after commit and may retry idempotently;
- concurrent cancellation-versus-add/check-in/call/start-consultation tests must prove there is no state where a cancelled session retains a serviceable active queue entry.

## Estimation engine

Keep estimator as a pure/domain-oriented component receiving a snapshot of relevant session/queue facts.

Initial deterministic model should combine:
- active call-eligible entries ahead by `eligibility_order`;
- doctor/session baseline duration;
- robust statistic from completed consultations in current session when enough samples exist;
- active consultation elapsed time;
- pauses/delays;
- known terminal/non-serving entries excluded from work ahead.

Late arrivals join behind the current normal checked-in cohort, so they do not worsen existing arrived patients' work-ahead estimates unless a separately authorized priority override is applied.

The first model must expose which inputs produced the estimate. Avoid hidden ML in the MVP.

## Patient queue access

Patient-facing queue access must not expose sequential identifiers that make enumeration easy.

For account-linked patients, authenticated ownership can authorize access.

For guest/reception-entered patients, use a high-entropy, revocable external access credential. This bearer credential must be stored and transmitted as a secret and must never appear on public waiting-room displays, printed queue boards or casually logged URLs.

Every queue entry may also have a distinct public display label (for example a short queue number). A public display label is non-secret, non-identifying, may be shown in the clinic, and can never authorize patient lookup or mutation. Guest access credentials and public display labels are separate fields with separate security semantics. Authorization tests must verify that possession of a display label alone is rejected by all guest lookup/mutation endpoints.

## Notifications

Queue mutation emits domain events / durable notification intents.

A worker/provider adapter later delivers SMS/push/WhatsApp/email. Failed delivery must not roll back queue state.

Notification deduplication/idempotency is required before enabling real provider delivery.

## Localization

All user-facing strings externalized. Locale resolution should support French and Arabic from the start. Components must tolerate RTL layout.

## Observability

Application logs must not casually include patient names, phone numbers, access credentials or sensitive identifiers.

Audit events are distinct from operational logs.

## Open questions for architecture review
1. Is Next.js modular-monolith architecture sufficient for an MVP with real-time queue updates, or should we separate the API/runtime earlier?
2. Is Prisma adequate for the exact PostgreSQL locking/isolation strategy we choose?
3. Should queue history be a conventional audit table, event-sourced aggregate, or hybrid append log?
4. What is the minimum patient identity model for Algeria without creating unnecessary healthcare-data exposure?
5. What notification channel should be first in a deployable pilot?
6. What offline/degraded workflow must reception support if connectivity is poor?

These questions should not block foundation review unless a choice is required to prevent costly rework.
