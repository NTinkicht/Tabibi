# Tabibi Product Specification — Foundation v0.1

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
- receive an estimated consultation time;
- receive delay/acceleration/approaching-turn notifications;
- confirm arrival;
- cancel;
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
- create/open/close consultation session;
- add scheduled or walk-in queue entry;
- queue states: waiting, checked-in, called, in-consultation, completed, cancelled, no-show;
- deterministic queue ordering and transitions;
- estimated waiting/consultation time;
- patient lookup using a privacy-preserving access mechanism;
- notification-domain events (delivery provider can initially be mocked/adapted);
- audit trail for operational queue changes;
- French/Arabic localization foundation;
- automated test suite and CI.

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

Each queue entry has an immutable internal identifier and a visible privacy-preserving token/number appropriate to the clinic workflow.

Queue ordering must be explicit and deterministic. Any manual priority/urgent insertion must be authorized, auditable, and must cause estimates for affected patients to be recomputed.

The system must never silently lose or duplicate queue entries because of concurrent updates.

## Initial estimation model

Start with an explainable estimator using a configurable baseline consultation duration and live session observations.

Candidate inputs:
- number of active entries ahead;
- configured baseline duration for the doctor/session;
- completed consultation durations from the current session;
- active pause/delay duration;
- cancellations/no-shows;
- current consultation elapsed time.

Do not promise exact times. Estimates must be represented as estimates and may include a confidence/range later.

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
- a patient can securely retrieve their own current queue position/estimate;
- concurrent queue mutations preserve consistency;
- the queue estimator responds deterministically to state changes;
- operational mutations are auditable;
- French and Arabic strings are externalized/localizable;
- CI passes deterministic tests;
- no unresolved BLOCKER or MAJOR Claude findings remain.
