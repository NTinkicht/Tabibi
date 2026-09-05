# Tabibi Product Specification — Foundation v0.9

## Problem
Many Algerian clinics operate with highly variable consultation queues. Patients may arrive very early, place their name on a physical list, leave, return later, and still have little reliable information about when they will be seen. Consultation duration, doctor delays, walk-ins, emergencies, cancellations and no-shows make rigid appointment slots insufficient on their own.

Tabibi digitizes that reality instead of assuming every clinic will immediately adopt appointment-only operations.

## Product proposition
Tabibi combines doctor/clinic discovery, future appointment booking, a virtual/live queue, receptionist-entered and walk-in patients, continuously updated estimates, material-change notifications, and reception-first controls that still work for patients without an app/account.

## Booking vs. queue position
An `Appointment` and a `QueueEntry` are different concepts. An appointment reserves service with a doctor/clinic for a scheduled session/date/time or arrival window; it does not guarantee live call position before arrival. A successful booking automatically becomes `confirmed` and atomically creates/links exactly one `waiting` queue entry for the concrete generated session, with immutable registration order but no call eligibility or capacity reservation. At check-in, that existing entry becomes `checked_in`, receives eligibility order, and the appointment becomes `checked_in`.

Once linked, appointment and queue terminal states must stay synchronized: completion -> `completed`, cancellation -> `cancelled`, no-show -> `no_show`, restore -> the matching active appointment state, and transfer -> the same appointment is re-linked to the target session/entry rather than stranded on the source. In particular, cancelling an appointment before check-in atomically cancels its linked `waiting` queue entry with an `appointment_cancelled` cause; a proper advance cancellation is never left waiting or later classified as a no-show. If cancellation races with check-in, the first valid operation to commit wins and the other is rejected after observing that result; an exact retry of the winning operation remains safe and idempotent.

Worked example: a patient books Dr X next Tuesday at 10:00. The doctor's schedule has already generated Tuesday's session (or generation occurs idempotently). Booking confirmation creates the linked `waiting` entry; on arrival/check-in, that same entry receives arrival-based `eligibility_order`. Booking retries cannot create another entry.

## Primary actors
Patient: discover/book/cancel, confirm arrival, view privacy-preserving status, receive provisional/live ETA and material notifications, choose language/contact preferences.

Receptionist/clinic staff: manage sessions, create guests/walk-ins with or without contact information, check in/cancel/no-show/call, pause/resume, record delay, apply authorized priority, restore mistakes, transfer eligible non-consulting patients, and bulk-resolve qualifying absent appointment-backed waiting entries as no-show before close.

Doctor: manage schedule/availability, progress consultations, configure basic service policies, review operational statistics.

Platform administrator: platform support/abuse workflows without implicit unrestricted patient-data access.

## Core principles
- Hybrid by design.
- No smartphone prerequisite.
- Contact information is **not required** to create a receptionist guest/walk-in entry. A contact-less entry remains fully serviceable in clinic but has no remote live-status or notification features until contact information is added.
- Deterministic/explainable estimates first.
- Privacy by design and clinic-tenant isolation.
- Arabic and French first-class, RTL-ready.
- Reception simplicity matters as much as patient convenience.

## MVP scope
Staff authentication/roles; clinic/doctor scheduling; deterministic session generation; appointments; session lifecycle; deterministic queue states/order; guests/walk-ins; restore/transfer; provisional/live ETA; secure SSE status with polling fallback; durable notification outbox; audit; Arabic/French foundation; automated tests/CI.

## Queue semantics
`waiting` = registered/booked but not confirmed present. `checked_in` = present and normally call-eligible. Waiting entries never block checked-in entries. Late check-in joins behind the current normal checked-in cohort unless authorized priority applies.

`registration_order` is immutable historical context; `eligibility_order` is assigned at check-in; `priority_order` is an auditable override.

The total eligible service order is priority checked-in entries first by `priority_order`, then non-priority checked-in entries by `eligibility_order`. This same order controls calling and checked-in ETA/work-ahead. Waiting entries, even with a future priority override, are not eligible and do not block checked-in patients.

Cancellation is distinct from no-show. `waiting -> no_show` is valid only for an appointment-backed patient past the configured grace deadline or through the explicit bulk close-time no-show operation. Walk-ins/contact-less guests are not auto-no-showed simply for remaining waiting.

Restore preserves audit history and assigns fresh live ordering when required. Transfer cancels the source with a transfer cause and creates a target entry: waiting stays waiting, while checked-in/called becomes checked-in at the target tail. Called status and live priority never silently carry across sessions. Transfer re-links any appointment, revokes source guest credentials and issues a fresh target exchange link when remote guest access exists.

## Session behavior
`planned`: registration/early check-in allowed, no call/start. `open`: normal service. `paused`: registration/check-in/non-consulting resolution allowed, no new call/start. `closing/closed/cancelled`: no new service mutations except the state-producing operation.

For one `(doctor, clinic)` pair, at most one session may be `open` or `paused`. Across all clinics, one doctor may have at most one patient `in_consultation` at a time. A paused morning session at Clinic A therefore does not block opening an afternoon session at Clinic B if no consultation is active.

Normal closure requires no active entries. Before close, reception may bulk-resolve only appointment-backed `waiting` entries whose arrival grace deadline has elapsed. Whole-session cancellation atomically cancels **all** remaining `waiting`, `checked_in`, and `called` entries and is rejected while a consultation is active.

## Guest access
Remote guest access uses a single-use short-TTL exchange link which yields a secure HttpOnly cookie. The cookie has bounded persistence appropriate to the active session and a rate-limited resend/recovery path if the patient loses the browser cookie. Credentials are revoked on terminal queue/session state after a short terminal-summary grace period. Contact-less entries intentionally have no remote guest credential until contact is added.

## Estimation model
Checked-in ETA uses committed work ahead (including `called`), effective order, configured/observed duration, active consultation remaining time, pause/delay and terminal exclusions. Waiting patients receive a provisional arrival window with uncertainty, never a fabricated exact live position.

Default material-change policy (clinic configurable): notify on >=10 minute ETA-midpoint movement, >=15 minute uncertainty movement, >=2 places, doctor/session delay/cancellation, or approaching-turn threshold.

## Live status delivery
SSE is preferred with canonical versioned snapshots and 30-second polling fallback. SMS/push-style messages are for material events rather than each position tick.

## Notification-domain events
Examples: `appointment_confirmed`, `queue_entry_created`, `estimate_changed_materially`, `turn_approaching`, `patient_called`, `session_delayed`, `session_cancelled`, `queue_entry_cancelled`, `queue_entry_transferred`.

Material notification dead-letters must be visible to clinic operations staff so manual contact can be attempted when appropriate.

## Explicitly out of MVP unless separately approved
EMR, diagnosis/treatment data, prescriptions, insurance claims, payments, telemedicine, AI diagnosis, medical recommendation engines, nationwide ranking, automated emergency triage.

## First engineering milestone success criteria
A realistic clinic day runs end-to-end with appointments, guests/walk-ins including contact-less entries, check-in/call/consultation progression, delay, no-show/bulk close resolution, restore/transfer with guest-access continuity, live status, deterministic ETA, multi-clinic doctor scheduling, session close/cancel, synchronized appointment/queue state, secure credential expiry/recovery and audit; concurrent mutations preserve invariants; Arabic/French strings are externalized; CI passes; and no unresolved BLOCKER/MAJOR reviewer finding remains.
