# Tabibi Product Specification — Foundation v0.10

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
`planned`: registration/early check-in allowed, no call/start. `open`: normal service. `paused`: registration/check-in/non-consulting resolution allowed, no new call/start. `closed` and `cancelled` are terminal. MVP has no persisted/API-visible `closing` state: normal close atomically transitions `open|paused -> closed` after revalidating all preconditions.

Across all clinics, one doctor may have at most one `open` session and at most one patient `in_consultation` at a committed moment. Planned and paused sessions may coexist; a paused morning session at Clinic A therefore does not block opening an afternoon session at Clinic B when no consultation is active, but Clinic A cannot resume until Clinic B is no longer open.

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

---

## End-to-end prioritized product delivery catalog (2026-10-18)

**Purpose:** This is the proposed complete product feature and verification inventory from foundation through launch and subsequent product evolution. Keep the behavior/invariants above normative. This catalog is a **planning and acceptance checklist**, not proof that code, tests, deployments, or legal decisions are complete. Status is `VERIFY` unless an exact commit, test and release artifact are linked. Reconcile with live GitHub and `coordination/WORK_QUEUE.md` before admitting executable WUs. Do not recreate WUs already merged, and do not use old autonomous Grok/Mistral controllers retired by the simplified L5 migration.

**Priorities:** P0 = safety/security/core clinic release prerequisite; P1 = complete useful product and launch hardening; P2 = deliberate later enhancements. Order is dependency-first *within* priority; items may be safely parallelized only on disjoint scopes. **Scope:** product work, not authorization to handle clinical records or to deploy production.

| Order | ID | Priority | Feature / precise outcome | Existing issue / contract | Required verification / exit criterion | Status |
|---|---|---|---|---|---|---|
| 01 | TAB-P0-01 | P0 | Tenant-scoped clinic and doctor identity, staff RBAC, scoped API access, staff session/logout and secure configuration | `README.md`, `PRODUCT.md` | Unit/API + Postgres authorization matrix; cross-tenant IDOR denial; invalid token, session expiry, CSRF/origin and audit negative cases | VERIFY |
| 02 | TAB-P0-02 | P0 | Clinic locations, staff assignments, doctor availability, consultation types/durations, schedules, holidays and deterministic generated sessions; global doctor collision prevention | `README.md` | Scheduling API/integration; timezone/DST and generation-idempotency; same doctor competing clinics and concurrent open-session races | VERIFY |
| 03 | TAB-P0-03 | P0 | Discover active doctors/clinics by specialty, location and available sessions; operationally correct public profile, filters and privacy-minimal responses | `VISION.md` | API contract/search pagination/filter and empty/error scenarios; no hidden contacts, private patients or tenant data | VERIFY |
| 04 | TAB-P0-04 | P0 | Book, confirm, reschedule where supported and cancel appointments; atomic one-to-one waiting QueueEntry creation and state synchronization | `PRODUCT.md` booking contract | Postgres concurrent booking/check-in/cancel/retry; zero duplicates and orphan entries; invalid capacity/date, cancelled-session and idempotency-key cases | VERIFY |
| 05 | TAB-P0-05 | P0 | Receptionist guest/contact-less walk-in registration, check-in, no-show/bulk close resolution, restore and transfer | Epic [#5](https://github.com/NTinkicht/Tabibi/issues/5) | Full lifecycle API/integration and Playwright clinic day; zero contact required; guest credential transfer/revoke; consistent appointment state | VERIFY |
| 06 | TAB-P0-06 | P0 | Canonical queue and consultation states; deterministic registration, eligibility and priority ordering; one consulting patient per doctor; authorized call-next/start/complete | [#576](https://github.com/NTinkicht/Tabibi/issues/576), Epic #5 | Table-driven transitions, priority ties, late arrival, closed/paused session rejections, fixed-seed DB races, immutable audit | VERIFY |
| 07 | TAB-P0-07 | P0 | PostgreSQL transactional queue mutations, expected-version CAS, concurrent operation conflict handling and exact retries | [#578](https://github.com/NTinkicht/Tabibi/issues/578), #590 | Adversarial simultaneous call-next, check-in, cancellation, priority, no-show, transfer/close; fault injection; no double call or lost state | VERIFY |
| 08 | TAB-P0-08 | P0 | Deterministic ETA range, uncertainty, work-ahead, ongoing consultations, pause/delay and recomputation | [#577](https://github.com/NTinkicht/Tabibi/issues/577), historical #606 | Exact input/output vectors; checked-in versus waiting provisional behavior; no spurious position/precision; recompute race assertions | VERIFY |
| 09 | TAB-P0-09 | P0 | Versioned ETA audit and canonical source epochs with atomic latest snapshot publication, safe stale-write rejection | [#587](https://github.com/NTinkicht/Tabibi/issues/587), [#610](https://github.com/NTinkicht/Tabibi/issues/610) | Parallel epoch CAS, retry/restart/recompute, contract-version persistence, privacy-minimal audit, rollback/error vectors | VERIFY |
| 10 | TAB-P0-10 | P0 | Patient/guest secure status, single-use exchange, safe cookie recovery, terminal revocation; SSE with polling fallback | `PRODUCT.md`, `docs/product/guest-live-queue-status.md` | Expiry/replay/rate-limit, no identity leak, cross-session access denial, stream disconnect/reconnect/backpressure, low-bandwidth E2E | VERIFY |
| 11 | TAB-P0-11 | P0 | Durable notification-domain event/outbox, material-change deduplication, retries/dead letters and staff escalation | `PRODUCT.md`, `VISION.md` | Outbox delivery concurrency, threshold boundary, duplicate/retry, transport outage, opt-out, no-contact patient, secrets/PII redaction | VERIFY |
| 12 | TAB-P0-12 | P0 | Arabic RTL and French LTR flows for patient, guest, receptionist and doctor, accessibility and responsive/mobile UX | `VISION.md`, `tests/TEST_MATRIX.md` | Playwright key journeys in both languages/viewport widths, keyboard, screen-reader labels, validation/errors, RTL mirroring | VERIFY |
| 13 | TAB-P0-13 | P0 | Privacy/tenant security, observability, safe schema migration/recovery, production configuration and release assurance | `README.md`, `docs/release/` | Threat model and penetration checklist; DB migration forward/rollback drills; rate limits, audit retention, secret scan, dependency audit, CI/E2E, staging failure/recovery | VERIFY |
| 14 | TAB-P0-14 | P0 | Full realistic bilingual synthetic clinic-day acceptance and operational pilot gate | `docs/release/bilingual-full-day-clinic-acceptance.md`, `tests/TEST_MATRIX.md` | Appointment→arrival→queue→consultation→closure including guest, delay, no-show, recovery, cross-clinic doctor; no open critical/high findings | VERIFY |
| 15 | TAB-P1-01 | P1 | Family/dependent profiles and permitted delegated booking/access (nonclinical only) | `VISION.md` | Consent/delegation and revocation; minor privacy controls; role/IDOR and shared-device tests | PLANNED |
| 16 | TAB-P1-02 | P1 | Saved doctors, operational visit history and patient self-service cancellation/rescheduling UX | `VISION.md` | History minimization, retention, pagination, authorized dependent viewing, DST/race behavior | PLANNED |
| 17 | TAB-P1-03 | P1 | Clinic/doctor operational statistics, delay trends and throughput, no clinical inference | `VISION.md` | Correct time windows, reconciled aggregates, tenant isolation, privacy-safe small cohorts, performance | PLANNED |
| 18 | TAB-P1-04 | P1 | Staff disruption communication, template management, recovery and escalation UI | `VISION.md`, notification contract | Delivery-failure paths, bulk-message eligibility/consent, queue consistency, accessibility, offline recovery | PLANNED |
| 19 | TAB-P1-05 | P1 | Clinic onboarding, staff invite/revoke, operational configuration, support and abuse workflows | `VISION.md` | Tenant provisioning isolation, duplicate invite/revoke, least privilege, audit, abusive traffic and support boundaries | PLANNED |
| 20 | TAB-P1-06 | P1 | Capacity, reliability, monitoring, backups and disaster recovery rehearsal; operator training/launch readiness | `docs/release/` | Synthetic peak clinic load, p95 budgets defined before test, SSE fanout, recovery-point/recovery-time targets, chaos/restart/runbook drills | PLANNED |
| 21 | TAB-P2-01 | P2 | Tamazight-ready localization and additional accessible patient channels | `VISION.md` | Locale fallback, RTL/LTR and translation QA, template coverage, no regression | FUTURE |
| 22 | TAB-P2-02 | P2 | Enhanced discovery preferences and verified clinic profile enrichment | `VISION.md` | Relevance, accuracy, fairness and sensitive-preference handling; fallback and abuse tests | FUTURE |
| 23 | TAB-P2-03 | P2 | Extra notification provider integrations, subject to owner budget and privacy approval | `VISION.md` | Contract, retry, opt-out, failover, cost cap, webhook/auth and data-minimization tests | FUTURE |
| 24 | TAB-P2-04 | P2 | Optional data-driven ETA calibration only after deterministic baseline measurement and explicit approval | `VISION.md` | Backtesting/calibration/drift/bias tests and deterministic fallback; **never** clinical triage or diagnosis | FUTURE |

### Non-negotiable full test inventory

- **Unit/property:** queue state transition tables, ordering and tie breakers, ETA vectors and versioning, permission decisions, normalization/localization, event thresholds, deterministic retries and idempotency.
- **API/contract:** schema validation, permissions, malformed/duplicate/stale requests, version conflicts, 401/403/404/409 distinctions, pagination, safe public serialization, rate limits, contact-less and terminal states.
- **Real PostgreSQL integration:** transaction isolation, cross-clinic locks, race and retry matrices, atomic booking/QueueEntry coupling, outbox, migrations, query-plan/index regression and repeated fixed seeds.
- **End-to-end browser/mobile:** patient booking, guest without account, receptionist and doctor shared clinic day, Arabic/French, RTL/LTR, keyboard accessibility, responsive views, disconnect/reconnect, expired guest credentials, slow network.
- **Security/privacy:** threat/abuse cases, tenant isolation, authn/authz, CSRF/origin, SSRF where integrations apply, secrets, PII minimization, logs, data retention/erasure, dependency/vulnerability review.
- **Reliability/release:** low-bandwidth behavior, deterministic load baseline, notifier downtime, process and DB recovery, backup/restore and rollback rehearsal, runtime health/readiness, staging with synthetic data and explicit release gate.

**Coverage ledger rule:** For each row, a follow-up implementation WU must record exact requirements, test filenames, baseline commit, CI run and independent current-head review. `tests/TEST_MATRIX.md` is useful existing evidence but has historical status notes; refresh it before declaring rows complete. Test presence alone is not a passing release gate.

### Execution and completion protocol

1. Reconcile current branch/issue/PR state: closed historical #606 must not become a new duplicate merely because older `coordination/WORK_QUEUE.md` named it NEXT. Check implementation of #576/#577/#578/#587/#610 and regressions against latest main; close/re-scope tickets only using actual evidence.
2. Make **small dependency-ready feature WUs** for uncovered pieces (one canonical PR per WU); update issue links in this table, rather than adding planned rows directly to an executable queue or opening redundant PRs.
3. Run deterministic unit, API, Postgres integration, browser, security and staging acceptance as relevant; exact-head CI + truly independent nonauthor review; resolve review findings before merge.
4. P0 exit = reproducible, stable, bilingual synthetic clinic day with zero unresolved blocking findings and operable rollback; P1 exit = complete approved nonclinical product experience and measurable performance; P2 items are optional, individually approved, and not prerequisites for MVP.

**Explicit exclusions:** EMR, diagnosis, treatment, prescriptions, insurance claims, payments, telemedicine and emergency triage remain outside the MVP unless separately authorized with new legal/security/clinical requirements. No production deployment is authorized by this document.
