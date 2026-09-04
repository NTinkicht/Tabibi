# Tabibi Product Specification — Foundation v0.4

## Problem

Many Algerian clinics operate with highly variable consultation queues. Patients may arrive very early, place their name on a physical list, leave, return later, and still have little reliable information about when they will actually be seen. Consultation duration, doctor delays, walk-ins, emergencies, cancellations and no-shows make rigid appointment slots insufficient on their own.

Tabibi digitizes the existing reality instead of assuming every clinic will immediately adopt a strict appointment-only model.

## Product proposition

Tabibi combines:

1. doctor discovery and appointment booking;
2. a virtual/live queue;
3. reception-entered and walk-in patients;
4. continuously updated estimated consultation times;
5. notifications when a patient's expected turn changes materially.

## Primary actors

### Patient
Can eventually:
- discover a doctor/clinic;
- reserve an appointment or join a supported queue;
- see queue status without exposing other patients' identities;
- receive a provisional arrival estimate before check-in and a live queue estimate after check-in;
- receive delay/acceleration/approaching-turn notifications;
- confirm arrival;
- cancel, including after being called but before consultation starts when clinic policy permits;
- manage preferred language/contact channel.

### Receptionist / clinic staff
Can eventually:
- open and manage a consultation session;
- add patients manually without requiring an app/account;
- register walk-ins;
- check patients in;
- mark no-show/cancelled;
- advance the queue;
- pause/resume a session;
- record doctor delay;
- handle urgent insertion according to explicit clinic policy.

### Doctor
Can eventually:
- manage schedule/availability;
- view and progress the current session;
- configure basic consultation/queue policies;
- review operational statistics.

### Platform administrator
Manages platform-level configuration, support and abuse/security workflows. Must not implicitly gain unrestricted access to sensitive patient data.

## Core principles

### Hybrid by design
Online appointments, virtual queues, receptionist-entered patients and walk-ins must coexist in one queue model.

### No smartphone prerequisite
A patient without an account or smartphone can still be entered and served by clinic staff.

### Explainable queue estimates first
Initial estimation must be deterministic and explainable. Machine learning may be considered only after sufficient trustworthy operational data exists and only if it demonstrably improves outcomes.

### Privacy by design
Collect the minimum necessary data. Queue views must not reveal patient identities to other patients.

### Algeria-first localization
French and Arabic are first-class product languages. UI architecture must support RTL. Tamazight may be added later without redesigning the system.

## Initial MVP scope

The first releasable vertical slice should support one clinic, one or more doctors, daily consultation sessions, receptionist-managed queue entries and patient-facing queue status.

MVP capabilities:
- secure authentication for clinic staff;
- clinic and doctor configuration;
- create/open/close/cancel consultation session;
- add scheduled or walk-in queue entry;
- queue states: `waiting`, `checked_in`, `called`, `in_consultation`, `completed`, `cancelled`, `no_show`;
- deterministic queue ordering and transitions;
- provisional pre-arrival estimate plus live checked-in waiting/consultation estimate;
- patient lookup using a privacy-preserving access mechanism;
- notification-domain events (delivery provider can initially be mocked/adapted);
- audit trail for operational queue changes;
- French/Arabic localization foundation;
- automated test suite and CI.

The snake_case values above are the canonical persisted/API queue-state names. UI labels may be localized or humanized but must map to these exact domain values.

## Explicitly out of MVP unless separately approved

- electronic medical records;
- diagnosis/treatment data;
- prescriptions;
- insurance claims;
- payments;
- telemedicine;
- AI diagnosis;
- medical recommendation engines;
- nationwide doctor marketplace ranking;
- automated emergency triage.

## Queue semantics — initial contract

A consultation session belongs to exactly one doctor and clinic and represents a bounded service period.

Each queue entry has:
- an immutable internal identifier;
- a distinct public display label/number suitable for clinic workflow;
- for guest access, a separate secret high-entropy access credential issued to the patient/contact channel while only a one-way verifier is persisted server-side; the credential is never the display label and can never be inferred from it;
- an immutable registration/booking-order reference for audit and scheduling context;
- a call-eligibility order assigned when the patient becomes `checked_in`.

Queue ordering must be explicit and deterministic. Any manual priority/urgent insertion must be authorized, auditable, and must cause estimates for affected patients to be recomputed.

Arrival semantics are explicit:
- `waiting` = registered/booked but not confirmed physically present and ready to be called;
- `checked_in` = present and eligible to be called;
- unarrived `waiting` patients do not block checked-in patients behind them;
- checking in later does not allow a previously unarrived patient to overtake patients who were already `checked_in` at that moment;
- on `waiting -> checked_in`, the entry joins the tail of the current normal call-eligible cohort, unless an explicit authorized priority policy applies;
- the immutable booking/registration order remains available for audit and UX, but normal call order among arrived patients is determined by call-eligibility order;
- check-in and call operations must be serialized transactionally so concurrent arrival/call activity produces one deterministic result;
- arrival/check-in triggers deterministic re-evaluation of eligible order and estimates.

Cancellation semantics are distinct from no-show semantics. A patient or authorized staff member may move an entry to `cancelled` from `waiting`, `checked_in`, or `called` before consultation begins. `no_show` is reserved for operational absence according to clinic policy and must not be used merely because a patient cancels after being called.

The system must never silently lose or duplicate queue entries because of concurrent updates.

## Consultation session closure and cancellation contract

Normal session closure is permitted only when no entries remain active in `waiting`, `checked_in`, `called`, or `in_consultation`.

If active entries remain, staff must resolve them explicitly as `completed`, `cancelled`, or `no_show` as appropriate before closure. The final close operation must atomically validate the queue, close the session, record its audit event and create any required notification intents. A force-close workflow, if ever added, requires elevated authorization, an explicit reason and deterministic disposition of every affected entry; it is not part of the initial MVP.

Cancelling an entire session is a distinct MVP operation:
- only authorized clinic staff may cancel a session and an explicit cancellation reason is required;
- cancellation is rejected while any entry is `in_consultation`; the active consultation must first be completed or otherwise resolved through a future elevated emergency workflow;
- once cancellation begins, new queue additions, check-ins, calls, reorders and consultation starts are rejected for that session;
- all remaining `waiting`, `checked_in`, and `called` entries are atomically transitioned to `cancelled` with a session-cancellation reason;
- affected estimates become unavailable/terminal rather than continuing to imply service will occur;
- audit events and durable `session_cancelled` notification intents for affected patients are written in the same transaction as the session and queue dispositions;
- concurrent cancel-versus-add/check-in/call/start operations must produce one deterministic winner and may not leave serviceable entries inside a cancelled session.

## Session-state product behavior

Lifecycle gating is part of the product contract, not an implementation preference:
- `planned`: registration and early check-in are allowed; calling/consultation start are not;
- `open`: normal queue service operations are allowed;
- `paused`: registration/check-in and resolution of non-consulting entries remain allowed, but no new patient may be called and no new consultation may start; an already active consultation may be completed;
- `closing`, `closed`, `cancelled`: new queue-service mutations are rejected except the atomic transitions that created those states.

The detailed operation matrix and concurrency rules live in `ARCHITECTURE.md` and are mandatory for implementation/tests.

## Initial estimation model

Start with an explainable estimator using a configurable baseline consultation duration and live session observations.

For a `checked_in` patient, live estimate inputs include:
- all committed work ahead, including a patient already `called` but not yet resolved;
- checked-in entries ahead by call-eligibility order;
- configured baseline duration for the doctor/session;
- completed consultation durations from the current session;
- active pause/delay duration;
- cancellations/no-shows;
- current consultation elapsed/remaining-time estimate.

A `called` patient remains committed work ahead until consultation starts or that entry is explicitly cancelled/no-show; the estimator must not drop that pending consultation from patients behind them.

For an unarrived `waiting` patient, Tabibi must not present an exact live queue position because no call-eligibility order exists yet. Instead it presents a clearly labelled **provisional arrival estimate/window** based on schedule/registration context, current session delay and observed/baseline service pace, with visible uncertainty. The provisional value never reserves service capacity. At check-in it is atomically replaced by the live checked-in estimate derived from the new call-eligibility order.

Unarrived `waiting` entries are not treated as guaranteed active work ahead of already checked-in patients. When a late patient checks in, the patient joins behind the current normal checked-in cohort, so already-arrived patients' estimates are not worsened by the late arrival unless an explicit authorized priority rule applies. The clinic dashboard may still expose unarrived counts separately for operational awareness.

Do not promise exact times. Estimates must be represented as estimates; provisional estimates should use a range/uncertainty indication from the MVP, and live estimates may also expose a range where appropriate.

## Notification-domain events

Examples:
- queue_entry_created;
- appointment_confirmed;
- estimate_changed_materially;
- N_patients_remaining;
- turn_approaching;
- patient_called;
- session_delayed;
- session_cancelled;
- queue_entry_cancelled.

Notification generation and notification delivery should be separate concerns.

## Success criteria for first engineering milestone

We have a deployable, tested vertical slice when:
- a receptionist can create a session and manage patients through the complete queue lifecycle;
- a waiting/unarrived patient can securely retrieve a clearly provisional estimate without being shown a fabricated exact call position;
- a checked-in patient can securely retrieve their own current live queue position/estimate;
- a `called` patient is counted as committed work ahead for patients behind them until resolved;
- concurrent queue mutations preserve consistency;
- the queue estimator responds deterministically to state changes;
- mixed arrived/unarrived queues have deterministic call eligibility and estimates;
- late arrivals cannot unexpectedly overtake patients already checked in;
- session-state gates reject invalid operations and boundary races produce one valid history;
- normal session closure cannot strand active entries;
- session cancellation atomically disposes all eligible active entries and rejects unsafe cancellation during an active consultation;
- public display labels cannot authorize guest access;
- raw guest bearer tokens are not persisted and stored verifiers cannot authenticate;
- persisted/API state names are canonical and consistent;
- operational mutations are auditable;
- French and Arabic strings are externalized/localizable;
- CI passes deterministic tests;
- no unresolved BLOCKER or MAJOR reviewer findings remain.
