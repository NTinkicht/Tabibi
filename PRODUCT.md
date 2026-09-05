# Tabibi Product Specification — Foundation v0.5

## Problem
Many Algerian clinics operate with highly variable consultation queues. Patients may arrive very early, place their name on a physical list, leave, return later, and still have little reliable information about when they will be seen. Consultation duration, doctor delays, walk-ins, emergencies, cancellations and no-shows make rigid appointment slots insufficient on their own.

Tabibi digitizes that reality instead of assuming every clinic will immediately adopt appointment-only operations.

## Product proposition
Tabibi combines:
1. doctor/clinic discovery;
2. appointment booking for a future service session;
3. a virtual/live queue;
4. receptionist-entered and walk-in patients;
5. continuously updated estimated consultation times;
6. material-change notifications;
7. reception-first operational controls that still work for patients without an app/account.

## Booking vs. queue position
An **Appointment** and a **QueueEntry** are different concepts.

An appointment reserves service with a doctor/clinic for a scheduled session/date/time or arrival window. It does **not** guarantee a live call position before arrival. The live queue position begins only when the patient checks in and the appointment resolves into/links to a `QueueEntry` in that consultation session.

Worked example: a patient books Dr X for next Tuesday at 10:00. The doctor's schedule has already generated Tuesday's consultation session (or generation occurs idempotently from the schedule template). The appointment references that future session. On arrival/check-in, Tabibi creates/links the queue entry and assigns `eligibility_order` after the current normal arrived cohort, unless an authorized priority policy applies.

## Primary actors
### Patient
Can discover a doctor/clinic, book/cancel an appointment, join supported queues, confirm arrival, view privacy-preserving status, receive provisional/live ETA, receive delay/acceleration/approaching-turn notifications, and choose language/contact preferences.

### Receptionist / clinic staff
Can manage consultation sessions, create guests/walk-ins without accounts, check in/cancel/no-show/call patients, pause/resume sessions, record doctor delay, apply authorized priority, restore an operationally misclassified entry, and transfer an eligible patient to another compatible session/doctor at the same clinic with a mandatory reason/audit trail.

### Doctor
Can manage schedule/availability, view/progress their active service stream, configure basic consultation policies, and review operational statistics.

### Platform administrator
Manages platform-level configuration/support/abuse workflows without implicit unrestricted access to patient data.

## Core principles
- Hybrid by design: scheduled appointments, virtual queues, walk-ins and receptionist-created guests coexist.
- No smartphone prerequisite.
- Deterministic/explainable estimates first; no hidden ML in MVP.
- Privacy by design and clinic-tenant isolation.
- Arabic and French first-class, RTL-ready; Tamazight extensible later.
- Reception simplicity matters as much as patient convenience.

## MVP scope
- staff authentication and clinic-scoped roles;
- clinic/doctor schedule configuration;
- deterministic generation/manual creation of consultation sessions;
- appointments linked to future sessions;
- session lifecycle `planned/open/paused/closing/closed/cancelled`;
- queue states `waiting`, `checked_in`, `called`, `in_consultation`, `completed`, `cancelled`, `no_show`;
- deterministic registration/eligibility/priority ordering;
- receptionist guest/walk-in entry;
- restore/transfer operations with explicit audit semantics;
- provisional pre-arrival ETA and live checked-in ETA;
- patient status via secure web view using SSE with polling fallback;
- durable notification-domain/outbox semantics, initially provider-adapted/mocked where required;
- audit trail;
- French/Arabic localization foundation;
- automated tests and CI.

## Queue semantics
`waiting` means registered/booked but not confirmed present and ready to call. `checked_in` means present and normally call-eligible. Waiting patients do not block checked-in patients. A late check-in joins behind the current normal checked-in cohort unless an authorized priority override applies.

`registration_order` is immutable historical context. `eligibility_order` is assigned at check-in. `priority_order` is an authorized auditable live override and never rewrites registration history.

Cancellation is distinct from no-show. A patient/staff cancellation uses `cancelled`. `waiting -> no_show` is allowed only for an appointment-backed patient who fails to check in by the clinic-configured grace deadline (or is resolved as absent during session close). Staff may not use no-show as an arbitrary substitute for cancellation.

Reception recovery:
- restore corrects a mistaken `cancelled`/`no_show` classification without deleting audit history; a restored arrived patient gets a fresh eligibility position rather than reclaiming an old live slot;
- transfer moves a non-consulting patient to a compatible target session through an explicit audited operation and preserves source history.

The system must never silently lose/duplicate queue entries under concurrent updates.

## Session behavior
- `planned`: registration and early check-in allowed; no call/start;
- `open`: normal service;
- `paused`: registration/check-in and non-consulting resolution remain allowed; no new call/start; active consultation may complete;
- `closing/closed/cancelled`: new service mutations rejected except the atomic transition creating the state.

One doctor has at most one active service stream (`open`/`paused`) at a time in MVP and at most one active consultation across all of that doctor's sessions.

Normal closure requires no active queue entries. Whole-session cancellation atomically cancels remaining eligible entries but is rejected while a consultation is active.

## Estimation model
For checked-in patients, live ETA uses committed work ahead, including `called` patients, effective checked-in order, baseline consultation duration, robust same-session observations, active-consultation remaining time, pauses/delays and terminal exclusions.

Waiting/unarrived patients receive a clearly labelled provisional arrival window with uncertainty, never a fabricated exact live position. Check-in atomically switches to live estimate mode.

Default material-change notification policy (clinic configurable): notify on >=10 minute ETA-midpoint movement, >=15 minute uncertainty-window movement, >=2 queue-place movement, doctor/session delay/cancellation, or approaching-turn threshold crossing.

## Live status delivery
SSE is the preferred MVP web transport with a canonical versioned status snapshot endpoint and a 30-second polling fallback. SMS/push-style messages are for material events, not every queue tick. Patients without an active web session can still receive important notifications.

## Notification-domain events
Examples: `appointment_confirmed`, `queue_entry_created`, `estimate_changed_materially`, `turn_approaching`, `patient_called`, `session_delayed`, `session_cancelled`, `queue_entry_cancelled`, `queue_entry_transferred`.

Generation and provider delivery are separate concerns. Delivery failure never rolls queue state back.

## Explicitly out of MVP unless separately approved
EMR, diagnosis/treatment data, prescriptions, insurance claims, payments, telemedicine, AI diagnosis, medical recommendation engines, nationwide ranking, automated emergency triage.

## First engineering milestone success criteria
A realistic clinic day can be run end-to-end with scheduled appointments, guests/walk-ins, check-in/call/consultation progression, delay, no-show, restore/transfer, live patient status, deterministic ETA, session close/cancel and audit; concurrent mutations preserve invariants; guest access does not leak credentials; Arabic/French strings are externalized; CI passes; and no unresolved BLOCKER/MAJOR reviewer finding remains.
