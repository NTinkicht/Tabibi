# Tabibi Architecture — Foundation Proposal v0.12

This is the canonical foundation architecture for independent review before production implementation.

## Architecture goals
- Simple deployment and local development.
- Strong transactional consistency for queue/session/appointment mutations.
- Clear separation between scheduling, queue domain logic, estimation and notification delivery.
- Localization/RTL-ready UI.
- Minimal healthcare data footprint.
- Explicit degraded/guest workflows for Algerian clinics.
- Easy extraction into services later without premature microservices.

## Initial stack decision
- TypeScript end-to-end.
- Next.js web application and server/API boundary for MVP.
- PostgreSQL as the system of record.
- Prisma is permitted only if the selected PostgreSQL locking/isolation strategy can be expressed and integration-tested; raw SQL/transaction helpers are allowed where required.
- Modular monolith first; no microservices until operational evidence justifies extraction.

Modules: identity/access, clinic, scheduling, session, queue, estimation, notification-domain, audit, localization/UI.

## Core entities

### Clinic
Clinic identity, timezone (`Africa/Algiers` by default), locale defaults and status.

### User / ClinicMembership
Authentication identity is separate from patient operational data. `ClinicMembership` maps a user to clinic-scoped role(s). No role grants cross-clinic access implicitly.

### DoctorProfile
Clinician identity within one or more clinic contexts.

### Appointment
A future reservation distinct from a live queue position.

MVP appointment fields include: clinic, doctor, scheduled service date/time or arrival window, status, patient/contact reference, source, locale/contact preferences and optional link to the eventual `ConsultationSession`/`QueueEntry`.

Canonical appointment lifecycle for MVP: `booked -> confirmed -> checked_in -> completed`, with terminal `cancelled` and `no_show` paths where policy permits.

`booked -> confirmed` is automatic when the booking transaction commits successfully and the chosen session/slot remains valid; clinics may later add an explicit patient-confirmation workflow without changing the queue semantics.

An appointment is not itself guaranteed call eligibility. Successful booking/confirmation for a concrete generated session atomically creates and links exactly one `QueueEntry` in `waiting`, with immutable `registration_order` and null `eligibility_order`. The appointment/queue-entry link is protected by a uniqueness constraint and the booking idempotency key, so an exact retry returns the existing pair rather than creating another entry. This provisional row reserves neither call eligibility nor service capacity; check-in activates eligibility instead of materializing the row.

### Appointment ↔ QueueEntry synchronization — TAB-FND-023
Appointment and queue state are separate models but may not drift once linked.
- `waiting -> checked_in` on an appointment-backed queue entry atomically sets the linked appointment to `checked_in`.
- `in_consultation -> completed` atomically sets the linked appointment to `completed`.
- queue-entry `cancelled` atomically sets the linked appointment to `cancelled`, except transfer where the appointment remains active and is re-linked to the target session/entry in the same transaction.
- queue-entry `no_show` atomically sets the linked appointment to `no_show`.
- restore from `cancelled`/`no_show` atomically restores the appointment to `confirmed` or `checked_in` matching the resulting queue state.
- transfer atomically updates `Appointment.session_id` and `Appointment.queue_entry_id` to the target while preserving booking identity/audit history.
- no committed state may leave a terminal queue entry paired with a non-terminal stale appointment unless the queue entry is a transfer source whose appointment was already re-linked to the target.

Required PostgreSQL integration tests cover check-in, complete, cancel, no-show, restore and transfer mappings plus retry/idempotency.

### ConsultationSession
A bounded service period for one doctor at one clinic with lifecycle state, planned/actual start/end, delay/pause state and estimator configuration snapshot.

Future sessions are created deterministically from a doctor/clinic schedule template by an idempotent scheduler job at least 7 days ahead (configurable), and may also be created manually by authorized clinic staff. Session generation uses a uniqueness constraint over clinic/doctor/service-date/template occurrence so retries cannot duplicate sessions. Appointment booking for a date with no generated session must either trigger idempotent generation from a valid schedule template or fail clearly; it may not create an implicit unconstrained queue.

Worked example: patient books Dr X next Tuesday at 10:00. A Tuesday session already exists from schedule generation (or is generated idempotently from the doctor's Tuesday template). Booking confirmation atomically creates the appointment-backed `waiting` `QueueEntry` with immutable `registration_order`; it reserves no call eligibility or service capacity. When the patient arrives, `waiting -> checked_in` assigns `eligibility_order` and activates live eligibility on that existing row. A retry of either booking or check-in cannot duplicate the row or ordering assignment.

### QueueEntry
One patient's operational place in exactly one consultation session. Supports account-linked and receptionist-created guests. Contains canonical queue state, immutable `registration_order`, check-in-assigned `eligibility_order`, optional live `priority_order`, timestamps, appointment link where applicable, public display label and guest-access metadata.

### QueueEvent / AuditEvent
Append-oriented operational history for creation, check-in, priority, call, consultation, cancellation/no-show, restore/transfer, session lifecycle and delay changes.

### NotificationIntent
Durable outbox record for patient-facing notification work, with stream/version/supersession metadata, delivery state, attempts, provider idempotency key and terminal/dead-letter outcome.

## Authorization baseline
Minimum clinic roles for MVP:
- `doctor`: own session/queue progression and permitted session policy operations;
- `receptionist`: registration/check-in/cancel/no-show/call operations and explicitly permitted priority/restore/transfer actions;
- `clinic_admin`: staff membership, clinic configuration, elevated queue recovery/transfer and audit access;
- `platform_admin`: platform operations only; no default unrestricted patient-data access.

Every mutation is both clinic-scoped and permission-checked server-side. Cross-clinic IDs supplied by clients never expand authorization scope. Priority/recovery/transfer requires actor identity and a non-empty audit reason.

## Canonical queue state values
Persisted/database/API values are exactly:

`waiting`, `checked_in`, `called`, `in_consultation`, `completed`, `cancelled`, `no_show`.

Normal path: `waiting -> checked_in -> called -> in_consultation -> completed`.

Alternate terminal paths: `waiting|checked_in|called -> cancelled` and policy-defined `waiting|checked_in|called -> no_show`.

`waiting -> no_show` is valid only for an appointment-backed entry that reaches its clinic-configured arrival grace deadline without check-in, or through the explicit bulk close-time no-show resolution below. Arbitrary staff discretion must use `cancelled` unless an explicit audited no-show condition is satisfied.

## Queue ordering contract
Each entry has three distinct ordering concepts:
1. `registration_order`: immutable historical registration/booking sequence;
2. `eligibility_order`: assigned transactionally on `waiting -> checked_in` and representing normal arrived service order;
3. `priority_order`: optional persisted authorized override.

Only `checked_in` entries are normally call-eligible. `waiting` never blocks arrived patients. Late check-in joins behind the current normal checked-in cohort unless an authorized priority override applies. Registration order is never rewritten to mimic service order.

The authoritative total order for both `call next` and checked-in position/ETA work-ahead is: first, `checked_in` entries with non-null `priority_order`, ascending by unique `priority_order`; then `checked_in` entries with null `priority_order`, ascending by unique `eligibility_order`. No other state is call-eligible. In particular, a `waiting` entry carrying a future priority override neither blocks nor contributes checked-in work ahead until check-in.

The active priority cohort is exactly `waiting`/`checked_in` entries with non-null `priority_order`. Leaving it via call/cancel/no-show clears the live slot and transactionally renumbers the remaining priority cohort to contiguous `1..N`; history stays in audit events. Duplicate non-null priority slots are forbidden.

Priority requests are one-based integers. Insert permits `1..N+1`; move permits `1..N`; invalid or out-of-range values are rejected, not clamped. Bounds are revalidated after acquiring the session mutation boundary. Concurrent mutations serialize and the later transaction observes committed state.

## Reception recovery operations

### Restore
Restore exists for correcting operational mistakes without destroying history.
- Only `cancelled` or `no_show` entries that have never entered `in_consultation` may be restored in MVP.
- Restore is an explicit administrative/reception command with permission + mandatory reason.
- It creates an audit event referencing the erroneous terminal event; history is never deleted.
- Restore target is `waiting` unless the patient is physically present and the command explicitly performs `restore_and_check_in`; that variant assigns a fresh tail `eligibility_order` and cannot reclaim an old live service slot.
- Old `priority_order` is never resurrected automatically.
- Appointment synchronization follows the contract above.

### Transfer — CLAUDE-017 / TAB-FND-023
Transfer moves a not-yet-consulting patient to another compatible session/doctor at the same clinic.
- Allowed source states: `waiting`, `checked_in`, `called`; never `in_consultation`/`completed`.
- Transfer is one serialized transaction spanning source and target session locks in deterministic ID order to avoid deadlock.
- Source entry becomes `cancelled` with machine-readable `transferred` cause; a new target `QueueEntry` is created with a link to the source/transfer event.
- Original registration history remains immutable. Source `waiting` creates target `waiting` with null `eligibility_order`; source `checked_in` creates target `checked_in` with a fresh tail `eligibility_order` in the target session; source `called` also creates target `checked_in` with a fresh target-session tail `eligibility_order`, because a call is session-specific and never transfers as already-called.
- Live `priority_order` is never copied to the target. Target priority requires a separate authorized, reasoned and audited priority operation.
- Any linked `Appointment` is atomically re-linked to the target session and target queue entry. Its state becomes `confirmed` for target `waiting` and `checked_in` for target `checked_in`.
- For a guest entry, every source-entry guest verifier and outstanding exchange ID is invalidated in the same transaction. A fresh target-entry guest credential verifier + single-use exchange ID are created, and a `queue_entry_transferred` notification containing only the fresh exchange link is committed transactionally. The old cookie can return only a non-sensitive terminal/transferred response and cannot read the target status.
- Transfer requires authorization, reason, target-session lifecycle validation and notification/estimate recomputation.

Required transfer tests cover every allowed source-state mapping, fresh target tail ordering, no accidental priority/called carryover, guest access continuity, old-credential rejection, fresh-link usability, appointment state/re-linking, exact retry idempotency and transfer/check-in/call races.

## Consultation-session lifecycle
States: `planned -> open -> paused -> open -> closing -> closed`, plus terminal `cancelled`.

### Canonical state × operation table
| Operation | planned | open | paused | closing | closed | cancelled |
| --- | --- | --- | --- | --- | --- | --- |
| add/register waiting entry | allow | allow | allow | reject | reject | reject |
| check in | allow | allow | allow | reject | reject | reject |
| call next | reject | allow | reject | reject | reject | reject |
| start consultation | reject | allow | reject | reject | reject | reject |
| complete active consultation | reject | allow | allow | reject | reject | reject |
| cancel/no-show non-consulting entry | allow | allow | allow | reject | reject | reject |
| priority/reorder | allow | allow | allow | reject | reject | reject |
| delay declare/update/clear | allow | allow | allow | reject | reject | reject |
| pause | reject | allow | no-op/reject by API policy | reject | reject | reject |
| resume | reject | reject | allow | reject | reject | reject |
| normal close | reject | allow | allow | n/a | reject | reject |
| cancel entire session | allow | allow | allow | reject | reject | reject |

Opening is an explicit serialized `planned -> open` command with idempotent retry behavior and audit metadata.

### Bulk close-time no-show resolution — CLAUDE-007
To avoid forcing reception to touch every absent appointment individually, an authorized `resolve_absent_waiting_as_no_show` command may run in `planned|open|paused` before normal close.
- It targets only appointment-backed `waiting` entries whose grace deadline has elapsed.
- It atomically changes every qualifying entry to `no_show`, clears any live priority slot, synchronizes linked appointments to `no_show`, terminates estimates, writes per-entry audit events and creates any configured notification intents.
- Walk-ins/contact-less registrations are never auto-no-showed merely because they remain `waiting`; they must be explicitly cancelled or otherwise resolved.
- Concurrent check-in versus bulk resolution serializes at the session boundary; whichever commits first determines the valid outcome.
- The bulk action is idempotent for already-resolved entries.

Normal close remains rejected while any entry is `waiting`, `checked_in`, `called` or `in_consultation` after any optional bulk resolution.

### Session cancellation — TAB-FND-006 revisit
Session cancellation is rejected while a consultation is active. Otherwise, after acquiring the session mutation boundary, it atomically transitions **every remaining `waiting`, `checked_in`, and `called` entry** to `cancelled`, clears affected priority slots, synchronizes linked appointments, terminates estimates, records audit events and creates durable cancellation intents. There is no ambiguous `serviceable` subset: all three enumerated states are disposed of. No serviceable or unreachable active row may remain inside a cancelled session.

### Multi-clinic doctor capacity — CLAUDE-020 / TAB-FND-022
The capacity model has two distinct scopes:
- **doctor-global hard invariant:** across all clinics and sessions for a doctor, at most one queue entry may be `in_consultation` at any committed moment;
- **clinic-local service-stream invariant:** for a given `(doctor, clinic)` pair, at most one session may be `open` or `paused` at a time in MVP.

Therefore a doctor may have a paused session at Clinic A while a planned session at Clinic B opens, provided there is no active `in_consultation` entry anywhere for that doctor. Opening/resuming within the same clinic is serialized against that doctor's sessions at that clinic; starting consultation additionally acquires the doctor-global consultation boundary and rejects if another clinic/session already has an active consultation.

Any operation acquiring both consultation boundaries, including `start consultation`, always acquires the doctor-global consultation boundary first and then the clinic-local session boundary, and holds both through commit. No code path may invert this order.

Required tests:
- paused Clinic A + open planned Clinic B => allowed when no consultation is active;
- open/paused competing sessions in the same clinic => one winner;
- `in_consultation` at Clinic A + start consultation at Clinic B => rejected;
- concurrent cross-clinic start/start => one doctor-global winner.

## Doctor delay
Delay declare/update accepts strictly positive finite values only. Zero/negative/malformed values are rejected without side effects; clearing is a distinct command. Delay mutations are permitted only in `planned|open|paused`, use the same serialization boundary as lifecycle/queue changes, atomically update estimator state + audit + notification intents, and are idempotent under exact retry.

Delay/recovery messages use monotonically versioned replaceable streams. Newer versions supersede older not-yet-dispatched versions; session cancellation has terminal precedence.

## Estimation engine
The estimator is a pure/domain component over committed snapshots and must expose its inputs.

For `checked_in`, work ahead includes `called` entries plus checked-in entries ahead by effective service order. Once a called patient enters consultation, active-consultation remaining time replaces rather than stacks with the pending-duration contribution. Terminal/non-serving entries are excluded. Doctor baseline, robust same-session observed durations, pause/delay and current active consultation are explicit inputs.

`waiting` patients have no exact live position. They receive a clearly labelled provisional arrival window with uncertainty based on schedule context, session state, baseline/observed pace, delay, priority context and uncertainty from arrivals. Check-in atomically replaces provisional output with live service-order output.

Material notification threshold is configurable by clinic but defaults to: notify when ETA midpoint moves by >=10 minutes, the uncertainty window moves by >=15 minutes, queue position changes by >=2 places, session becomes delayed/cancelled, or the patient crosses an approaching-turn threshold. Threshold evaluation is deterministic and versioned with estimator output.

## Patient queue access and guest-token transport — CLAUDE-001 / CLAUDE-016 / TAB-FND-024
Account-linked patients use authenticated ownership/delegation.

Guest entries use a high-entropy revocable bearer credential whose raw value is issued once and never persisted. Only a one-way verifier is stored. Public display labels are separate non-secret values and can never authorize access.

MVP transport: **single-use exchange link**.
- SMS/other contact channel contains a short-TTL, single-use opaque exchange ID, never the durable bearer credential.
- Exchange ID default TTL is 10 minutes, has only a one-way verifier, is single-use and rate-limited.
- `/g/exchange/<opaque-id>` atomically consumes the exchange ID, sets the real guest credential in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie, and redirects to a clean status URL.
- The guest cookie has explicit `Max-Age` bounded by the earlier of 24 hours or the credential's server-side expiry. Session timing never shortens this cap; terminal-state revocation below remains authoritative however late a session runs. Active entries can obtain a fresh exchange link through a rate-limited resend flow without changing queue state.
- A credential is additionally bound to the current queue-entry/session state. On `completed`, `cancelled`, `no_show`, or whole-session `closed/cancelled`, authorization to live queue data is revoked immediately except for a <=15 minute terminal-summary grace window containing only the final non-sensitive status needed for UX. After that grace period the verifier is invalid and the cookie cannot authorize any queue read.
- Resend is allowed only while the target entry remains active (`waiting|checked_in|called|in_consultation`) and the intended contact channel still matches the entry; it issues a new exchange ID and rate-limits by entry/contact/IP.
- For contact-less guest entries, no remote bearer/exchange credential is created. They remain fully serviceable in-clinic but notification/live-remote features are explicitly unavailable unless contact information is later added by authorized staff.
- Exchange/status responses set `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, restrictive CSP; no third-party resources on exchange route; analytics disabled; logs redact exchange path segments.
- Rotation/reissue revokes previous verifier and outstanding exchange IDs atomically.

### Encrypted exchange-link delivery exception — TAB-FND-028-secret-outbox
Credential and exchange tables remain verifier-only. A notification that must deliver an exchange link may persist only a short-lived envelope-encrypted secret payload in its outbox row, alongside non-secret routing and delivery metadata. The data-encryption key is protected by a runtime secret/KMS-equivalent key that is never stored in the database or Git; authenticated encryption binds the ciphertext to the intent, entry and clinic identifiers. Only the notification worker may decrypt, immediately before provider dispatch.

Ciphertext expiry may not exceed the exchange ID TTL (default 10 minutes). Retry before expiry reuses the same logical exchange ID and provider idempotency key. Once expired, the stale link is never retried or decrypted; the intent terminates with an observable expiry outcome and resend must generate a fresh exchange ID, verifier, ciphertext and logical notification. Recoverable ciphertext is redacted/deleted as soon as audit requirements allow after successful delivery, terminal failure, or expiry, while non-secret delivery metadata remains. Plaintext links and decrypted payloads are forbidden in logs, metrics, errors, audit snapshots and general outbox columns. Key lookup/decryption failure is explicit, retry-bounded while the ciphertext is live, observable, and must never fall back to plaintext or dispatch corrupted data.

Required tests: raw bearer never in URL/log/referrer; link single-use/expiry; verifier cannot authenticate; public label cannot authenticate; cookie-loss + resend recovery; resend rate limit; terminal-state credential invalidation; terminal-summary grace expiry; a session already more than four hours past planned end still receives a positive/full bounded `Max-Age`; contact-less entry cannot access remote status until contact is added; transfer continuity tests above; database-dump/log safety for encrypted links, restart-safe retry before expiry, no retry after expiry, ciphertext redaction, and key/decrypt failure behavior.

## Live status delivery — CLAUDE-004
MVP web transport is **Server-Sent Events (SSE)** with polling fallback.
- Canonical authorized snapshot endpoint returns current versioned status/ETA.
- SSE streams only version/change notifications or authorized deltas; reconnect gaps force canonical snapshot re-fetch.
- 30-second polling fallback when SSE unavailable/backgrounded/unsupported.
- No WebSocket dependency in MVP.
- Guest patients without an active web session receive material notifications; SMS is not used for every position tick.
- PostgreSQL state + versioned snapshot remains authoritative.

## Notification delivery lifecycle — TAB-FND-021 / CLAUDE-005
The persisted lifecycle is:
- retryable states: `pending`, `failed`, `unknown`;
- `pending|failed|unknown -> skipped_obsolete` when final transactional relevance validation fails;
- `pending|failed|unknown -> dispatching -> delivered|failed|unknown|dead_letter` when dispatch begins.

Immediately before entering `dispatching`, the worker transactionally revalidates supersession, stream-head version, terminal/session state and attempt eligibility. If obsolete, it records `skipped_obsolete` and never invokes the provider.

After `dispatching` commits and provider invocation begins, that attempt is irrevocable/in-flight. A newer update/clear/cancellation can supersede only older intents whose invocation has not started. If newer/terminal state commits after an older dispatch starts, the old call may complete, but the newer/terminal intent remains deliverable afterward. Tabibi does not claim DB/network atomicity.

Provider idempotency keys suppress duplicate retry of the same logical intent/unknown result; they do not order different stream versions.

### Dispatch lease, recovery and fencing — TAB-FND-027-dispatch-recovery
Entering `dispatching` atomically increments/assigns a monotonic `dispatch_attempt_token` and sets `lease_expires_at`. Provider-result transitions to `delivered|failed|unknown|dead_letter` are conditional on the same current token. Thus a worker whose lease was reclaimed is fenced out and cannot finalize or overwrite the reclaimed attempt.

An idempotent, observable sweeper/claim path transactionally converts an expired `dispatching` lease to `unknown`, never blindly to `pending`, because provider invocation may already have occurred. A subsequent claim from recovered `unknown` uses the **same logical provider idempotency key** but a new attempt token and lease; provider status reconciliation may run first where available but is not required for MVP. Providers without sufficient idempotency/status guarantees follow the bounded unknown retry policy and ultimately surface `dead_letter` rather than silently duplicating forever. Recovery emits structured metrics/events and guarantees no expired `dispatching` row remains silently stuck.

### Retry/backoff/dead-letter policy
- transient `failed`: exponential backoff with jitter at approximately 1m, 5m, 15m, 1h, 4h; max 5 delivery attempts unless provider contract is stricter;
- `unknown`: same provider idempotency key; max 3 unknown-result retries after initial attempt;
- permanent rejection => direct `dead_letter` with machine-readable reason;
- exhausted transient/unknown retry => `dead_letter` plus operator-visible structured event/metric;
- **material-event dead letters** (`turn_approaching`, `patient_called`, `session_cancelled`, material delay/acceleration) must also surface in the clinic operations UI so staff have an explicit manual-contact fallback; routine low-stakes dead letters may remain metric-only;
- newer superseding/terminal versions can make not-yet-started retries `skipped_obsolete`.

Required barrier/crash tests cover pre-dispatch suppression; post-dispatch bounded race; crash before provider call; crash during/after provider call; lease expiry/reclaim; stale-worker completion fenced out; same-key retry with a new attempt token; terminal precedence; idempotent sweeper/claim observability; no silently stuck `dispatching` row; and retry exhaustion/operator surfacing. Concurrency tests also prove doctor-global-before-clinic-local lock acquisition and mixed priority/non-priority/waiting ordering under check-in, priority and call mutations.

## Database integrity defense-in-depth
Implementation must use PostgreSQL constraints/indexes/locking where possible, not application checks alone, including:
- canonical enum/check constraints for queue/session/appointment states;
- uniqueness of generated future session occurrence;
- uniqueness/consistency of active priority slots within a session;
- no duplicate appointment->queue linkage where cardinality is one;
- clinic-local doctor service-stream serialization plus doctor-global active-consultation serialization;
- optimistic/version fields where stale client mutation must be rejected.

Exact DDL strategy is selected during implementation and proved by PostgreSQL integration tests.

## Observability, privacy and audit
Operational logs exclude patient names, raw phone numbers, bearer credentials, exchange IDs and sensitive notification bodies. Audit events are separate from logs and include actor/action/target/clinic/session/time/reason with minimum necessary snapshots. Correlation IDs must be non-sensitive.

## Testing gates before production code is considered releasable
- pure state-machine/estimator tests;
- PostgreSQL concurrency tests for check-in/call/priority/session lifecycle/multi-clinic doctor capacity/restore/transfer/appointment synchronization;
- explicit state×operation permission-table tests;
- API tenant/role/ownership tests;
- guest exchange/resend/terminal-expiry/log/referrer security tests;
- notification supersession/dispatch/retry/dead-letter barrier tests;
- SSE reconnect/version-gap/polling-fallback tests;
- Arabic RTL/French localization tests;
- end-to-end clinic-day scenarios with scheduled appointments, walk-ins, contact-less guests, delays, no-shows, transfers and session cancellation.

## Remaining review questions
- exact Prisma vs lower-level SQL split after concurrency prototypes;
- conventional audit table vs richer append-log representation;
- first real SMS provider and commercial/legal onboarding;
- degraded reception workflow during prolonged connectivity loss.

None of those may weaken the contracts above.
