# Tabibi Architecture — Foundation Proposal v0.5

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
Represents one patient's place in one consultation session. Must support both account-linked patients and receptionist-created guests. Contains queue lifecycle state, immutable registration/booking order, normal call-eligibility order, optional persisted priority/service-order override, check-in timestamps and privacy-preserving external access data.

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
- estimates are recomputed from committed queue/session state;
- a one-doctor consultation session has at most one `in_consultation` entry at any committed point in time.

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

### Arrival, service order and call eligibility contract

`waiting` means the patient has a place in the session but is not yet confirmed physically present and ready to be called. `checked_in` means the patient is present and eligible for normal calling.

Each queue entry has three distinct ordering concepts:
1. `registration_order`: immutable historical booking/registration order used for audit and scheduling context;
2. `eligibility_order`: normal service-order key assigned transactionally when the entry becomes `checked_in`;
3. `priority_order`: optional persisted service-priority override, distinct from both historical registration order and normal arrival order.

Rules:
- only `checked_in` entries are normally call-eligible;
- a `waiting` entry never blocks an eligible `checked_in` entry;
- among call-eligible entries, an explicit authorized `priority_order` override is evaluated before normal `eligibility_order`; entries without a priority override retain normal arrival order;
- an unarrived `waiting` entry does not reserve service capacity ahead of already checked-in patients;
- when an entry changes `waiting -> checked_in`, it receives an `eligibility_order` after the current normal checked-in cohort, so a late arrival cannot overtake patients who were already present unless an authorized persisted priority override applies;
- `registration_order` remains immutable and is never silently rewritten to mimic service order;
- a manual priority/reorder action on a `waiting` entry persists only `priority_order` plus actor/reason/audit metadata; it does not assign `eligibility_order` early and does not alter `registration_order`;
- when that waiting entry later checks in, its `eligibility_order` is still assigned from the committed arrival cohort, while its pre-existing `priority_order` becomes effective in call selection;
- changing/removing `priority_order` for a `waiting` or `checked_in` entry is transactional, authorized, reasoned and audited;
- two entries may not commit the same effective priority slot in one session; the implementation must use a deterministic tie-breaker or transactional renumbering strategy, defined before coding;
- assignment of `eligibility_order`, check-in mutation, estimate recomputation and any related audit event happen transactionally;
- concurrent priority-change/check-in/call operations serialize through the same session mutation boundary so one committed history determines which priority state was effective at the call boundary;
- direct `waiting -> called` is disallowed in normal workflow; staff must check the patient in first unless a separately audited administrative override exists.

Required tests include mixed arrival ordering, late arrival behind an existing checked-in cohort, simultaneous check-ins, waiting-entry priority before check-in, checked-in priority changes, deterministic priority ties, and concurrent priority/check-in/call races against PostgreSQL.

### Consultation session lifecycle

Proposed normal states:

planned -> open -> paused -> open -> closing -> closed

A separate terminal state `cancelled` represents an abandoned service session.

#### Session-state operation matrix

All queue/session mutations are server-side gated by the current session state and must participate in the same session serialization strategy used for queue mutation.

| Operation | planned | open | paused | closing | closed | cancelled |
| --- | --- | --- | --- | --- | --- | --- |
| add/register `waiting` entry | allowed | allowed | allowed | reject | reject | reject |
| check in (`waiting -> checked_in`) | allowed | allowed | allowed | reject | reject | reject |
| call next (`checked_in -> called`) | reject | allowed | reject | reject | reject | reject |
| start consultation (`called -> in_consultation`) | reject | allowed, only if no other `in_consultation` entry exists | reject | reject | reject | reject |
| complete active consultation | reject | allowed | allowed | reject | reject | reject |
| cancel/no-show individual non-consulting entry | allowed | allowed | allowed | reject | reject | reject |
| manual reorder/priority insertion | allowed for waiting/checked-in only | allowed for waiting/checked-in only | allowed for waiting/checked-in only | reject | reject | reject |
| pause session | reject | allowed | idempotent no-op/reject by API policy | reject | reject | reject |
| resume session | reject | reject | allowed | reject | reject | reject |
| begin normal close | reject | allowed | allowed | n/a | reject | reject |
| cancel entire session | allowed | allowed | allowed | reject | reject | reject |

Additional rules:
- a planned session may accumulate registrations and early check-ins because clinics can receive patients before the doctor starts; nobody can be called until the session is `open`;
- a paused session can continue accepting registrations/check-ins and resolving non-consulting entries, but cannot call a new patient or start a new consultation;
- a consultation already `in_consultation` may be completed while the session is paused;
- for the MVP, one consultation session represents one doctor's sequential service stream and therefore has a hard invariant of at most one `in_consultation` entry;
- `start consultation` must re-check that invariant after acquiring the session-level serialization boundary; a second sequential or concurrent start request must fail once another entry is active;
- call/start selection and the one-active-consultation invariant must be enforced in PostgreSQL-backed integration tests, not only application-memory tests;
- operations rejected by lifecycle state fail without partial mutation or outbox/audit side effects;
- open/pause/resume/close/cancel races must serialize and produce one valid committed history.

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

### Checked-in/live estimate

For an entry in `checked_in`, the deterministic model should combine:
- all committed work ahead, including `called` entries ahead because a called patient still owns a pending consultation unless they are explicitly cancelled/no-show;
- other call-eligible `checked_in` entries ahead by effective service order (`priority_order` first when present, then normal `eligibility_order` with a deterministic tie-breaker);
- doctor/session baseline duration;
- robust statistic from completed consultations in current session when enough samples exist;
- active consultation elapsed/remaining-time estimate;
- pauses/delays;
- known terminal/non-serving entries excluded from work ahead.

A `called` entry contributes one pending consultation-duration unit (using the same current robust/baseline duration model) until it transitions to `in_consultation`, `cancelled`, or `no_show`; once `in_consultation`, its contribution is represented by active-consultation remaining time rather than counted twice.

Late arrivals join behind the current normal checked-in cohort, so they do not worsen existing arrived patients' work-ahead estimates unless a separately authorized persisted priority override is applied.

### Waiting/unarrived provisional estimate

An unarrived `waiting` patient has no `eligibility_order` and therefore must not be shown a fabricated exact live queue position. Instead the product exposes a clearly labelled **provisional arrival estimate/window** derived from session planned/open state, baseline/observed consultation duration, immutable registration/schedule context, current clinic delay, any persisted priority override, and explicit uncertainty from patients who may check in before them.

Rules:
- provisional output is semantically distinct from the live checked-in estimate and must include a confidence/uncertainty indicator or range;
- it must never imply that `registration_order` reserves service capacity;
- a persisted `priority_order` may influence the provisional scenario but must be labelled as priority-sensitive because actual call eligibility still begins only at check-in;
- upon `waiting -> checked_in`, the provisional estimate is discarded and replaced atomically from the committed eligibility/service-order live queue snapshot;
- mixed-arrival tests must verify that provisional estimates cannot change service ordering and that check-in deterministically switches estimate mode.

The first estimator must expose which inputs produced each estimate. Avoid hidden ML in the MVP.

## Patient queue access

Patient-facing queue access must not expose sequential identifiers that make enumeration easy.

For account-linked patients, authenticated ownership can authorize access.

For guest/reception-entered patients, issue a high-entropy, revocable external access bearer credential exactly once to the client/contact channel. The raw bearer credential is never persisted after issuance. Persist only a one-way verifier (for example a keyed cryptographic hash/HMAC or password-token verifier selected during implementation) plus non-sensitive metadata required for lookup, rotation, revocation and expiry.

Guest-token contract:
- raw token is generated from a CSPRNG with sufficient entropy and returned only at issuance/rotation;
- database storage contains a non-reversible verifier, never the usable bearer token;
- authentication compares a presented token to the verifier using a timing-safe strategy appropriate to the chosen construction;
- rotation/reissue revokes the previous verifier atomically before or with activation of the replacement;
- revocation/expiry immediately prevents further lookup or mutation authorization;
- operational logs, analytics, URLs and notification payload logs must never contain raw tokens;
- tests must prove that the persisted verifier itself cannot authenticate to guest endpoints.

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
