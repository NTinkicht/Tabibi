# Tabibi Architecture — Foundation Proposal v0.10

This is the canonical foundation architecture for independent review before production implementation.

## Architecture goals
- Simple deployment and local development.
- Strong transactional consistency for queue/session mutations.
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

An appointment is not itself a guaranteed live queue position. At check-in it resolves into, or links to, exactly one `QueueEntry` in the relevant session.

### ConsultationSession
A bounded service period for one doctor at one clinic with lifecycle state, planned/actual start/end, delay/pause state and estimator configuration snapshot.

Future sessions are created deterministically from a doctor/clinic schedule template by an idempotent scheduler job at least 7 days ahead (configurable), and may also be created manually by authorized clinic staff. Session generation uses a uniqueness constraint over clinic/doctor/service-date/template occurrence so retries cannot duplicate sessions. Appointment booking for a date with no generated session must either trigger idempotent generation from a valid schedule template or fail clearly; it may not create an implicit unconstrained queue.

Worked example: patient books Dr X next Tuesday at 10:00. A Tuesday session already exists from schedule generation (or is generated idempotently from the doctor's Tuesday template). The `Appointment` references that session but does not reserve call eligibility. When the patient arrives and checks in, a `QueueEntry` is created/linked and receives `eligibility_order` according to arrival semantics.

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

`waiting -> no_show` is valid only for an appointment-backed entry that reaches its clinic-configured arrival grace deadline (or session-close no-show resolution) without check-in; arbitrary staff discretion must use `cancelled` unless an explicit audited no-show condition is satisfied.

## Queue ordering contract

Each entry has three distinct ordering concepts:
1. `registration_order`: immutable historical registration/booking sequence;
2. `eligibility_order`: assigned transactionally on `waiting -> checked_in` and representing normal arrived service order;
3. `priority_order`: optional persisted authorized override.

Only `checked_in` entries are normally call-eligible. `waiting` never blocks arrived patients. Late check-in joins behind the current normal checked-in cohort unless an authorized priority override applies. Registration order is never rewritten to mimic service order.

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

### Transfer
Transfer moves a not-yet-consulting patient to another compatible session/doctor at the same clinic.
- Allowed source states: `waiting`, `checked_in`, `called`; never `in_consultation`/`completed`.
- Transfer is one serialized transaction spanning source and target session locks in deterministic ID order to avoid deadlock.
- Source entry becomes `cancelled` with machine-readable `transferred` cause; a new target `QueueEntry` is created with a link to the source/transfer event.
- Original registration history remains immutable; target receives new target-session registration/eligibility semantics.
- Transfer requires authorization, reason, target-session lifecycle validation and notification/estimate recomputation.

## Consultation-session lifecycle

States: `planned -> open -> paused -> open -> closing -> closed`, plus terminal `cancelled`.

`planned`: registrations/early check-ins allowed, no call/start.
`open`: normal service.
`paused`: registrations/check-ins and non-consulting resolution allowed; no new call/start; active consultation may complete.
`closing|closed|cancelled`: new service mutations rejected except the atomic operation producing the state.

Opening is an explicit serialized `planned -> open` command with idempotent retry behavior and audit metadata. Normal close is rejected while any entry remains `waiting`, `checked_in`, `called` or `in_consultation`. Session cancellation is rejected while a consultation is active; otherwise it atomically cancels remaining serviceable entries, terminates estimates, records audit and creates durable cancellation intents.

### One active service stream per doctor — TAB-FND-022

The capacity invariant is doctor-scoped, not merely session-scoped.
- For one doctor, at most one session may be actively serviceable (`open` or `paused`) at a time in MVP. Other sessions for that doctor may coexist only as `planned`, `closing`, `closed` or `cancelled`.
- Opening/resuming a session and starting a consultation acquire a doctor-level serialization boundary in addition to the session boundary, in deterministic lock order.
- After acquiring that boundary, the command revalidates that no other session for the doctor is `open`/`paused` and that no other entry for that doctor is `in_consultation`.
- PostgreSQL must enforce defense-in-depth using a transaction-safe constraint/locking strategy; application-memory checks are insufficient.
- Concurrent open/open, open/resume, resume/resume and start/start attempts across two sessions for the same doctor must produce one valid winner and one rejected/retried loser.

Within the winning service stream, at most one entry may be `in_consultation`.

## Doctor delay

Delay declare/update accepts strictly positive finite values only. Zero/negative/malformed values are rejected without side effects; clearing is a distinct command. Delay mutations are permitted only in `planned|open|paused`, use the same serialization boundary as lifecycle/queue changes, atomically update estimator state + audit + notification intents, and are idempotent under exact retry.

Delay/recovery messages use monotonically versioned replaceable streams. Newer versions supersede older not-yet-dispatched versions; session cancellation has terminal precedence.

## Estimation engine

The estimator is a pure/domain component over committed snapshots and must expose its inputs.

For `checked_in`, work ahead includes `called` entries plus checked-in entries ahead by effective service order. Once a called patient enters consultation, active-consultation remaining time replaces rather than stacks with the pending-duration contribution. Terminal/non-serving entries are excluded. Doctor baseline, robust same-session observed durations, pause/delay and current active consultation are explicit inputs.

`waiting` patients have no exact live position. They receive a clearly labelled provisional arrival window with uncertainty based on schedule context, session state, baseline/observed pace, delay, priority context and uncertainty from arrivals. Check-in atomically replaces provisional output with live service-order output.

Material notification threshold is configurable by clinic but defaults to: notify when ETA midpoint moves by >=10 minutes, the uncertainty window moves by >=15 minutes, queue position changes by >=2 places, session becomes delayed/cancelled, or the patient crosses an approaching-turn threshold. Threshold evaluation is deterministic and versioned with estimator output.

## Patient queue access and guest-token transport — CLAUDE-001

Account-linked patients use authenticated ownership/delegation.

Guest entries use a high-entropy revocable bearer credential whose raw value is issued once and never persisted. Only a one-way verifier is stored. Public display labels are separate non-secret values and can never authorize access.

MVP transport decision: **single-use exchange link**.
- SMS/other contact channel contains a short-TTL, single-use opaque exchange ID, never the durable guest bearer credential.
- The exchange ID has a one-way verifier, expires within 10 minutes by default, is single-use and rate-limited.
- Visiting `/g/exchange/<opaque-id>` performs no authenticated queue read itself. The server atomically consumes the exchange ID and sets the real guest credential in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie, then redirects to a clean status URL that contains no credential.
- Exchange/status responses set `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and a restrictive CSP; no third-party resources are loaded on the exchange route.
- Reverse-proxy/CDN/application logs must redact the exchange path segment before persistence. Analytics are disabled on the exchange route.
- Browser history may contain the expired one-time exchange URL, but after first successful exchange or expiry it cannot authorize queue access.
- Rotation/reissue revokes previous guest credential/verifier and any outstanding exchange IDs atomically.

Required security tests: raw guest bearer never appears in URL/log/referrer; exchange link cannot be reused; expired link cannot authenticate; copied persisted verifier cannot authenticate; public label cannot authenticate; log fixtures prove redaction; post-exchange navigation emits no credential-bearing `Referer`.

## Live status delivery — CLAUDE-004

MVP web transport is **Server-Sent Events (SSE)** with polling fallback.
- Canonical authorized snapshot endpoint: `GET /api/queue-entries/{id}/status` (or opaque guest equivalent) returns current versioned status/ETA.
- SSE endpoint streams only version/change notifications or authorized status deltas for that patient; clients reconnect using event IDs and must re-fetch canonical snapshot after reconnect gaps.
- 30-second polling fallback is available when SSE is unavailable, degraded, backgrounded or unsupported.
- No WebSocket dependency in MVP.
- Guest patients without an active web session still receive material SMS/push-style notifications according to policy; SMS is not used for every position tick.
- SSE never becomes the source of truth: PostgreSQL state + versioned snapshot is authoritative.

## Notification delivery lifecycle — TAB-FND-021 / CLAUDE-005

Notification intent delivery states are persisted:

`pending -> dispatching -> delivered | failed | unknown | skipped_obsolete | dead_letter`.

Immediately before `pending/failed/unknown -> dispatching`, the worker transactionally revalidates supersession, stream-head version, terminal/session state and attempt eligibility. If obsolete, it records `skipped_obsolete` and never invokes the provider.

After `dispatching` commits and provider invocation begins, that attempt is irrevocable/in-flight. A newer update/clear/cancellation can supersede only older intents whose provider invocation has not started. If newer/terminal state commits after an older dispatch has started, the older call may complete, but the newer/terminal intent remains deliverable afterward. This is the explicit bounded race; Tabibi does not claim impossible DB/network atomicity.

Provider idempotency keys suppress duplicate retry of the same logical intent/unknown result; they do not order different stream versions.

### Retry/backoff/dead-letter policy
- transient `failed`: exponential backoff with jitter at approximately 1m, 5m, 15m, 1h, 4h; maximum 5 delivery attempts unless a provider-specific contract is stricter;
- `unknown`: retry with the same provider idempotency key; at most 3 unknown-result retries after the initial attempt;
- permanent provider rejection (invalid destination/opt-out/etc.) goes directly to `dead_letter` with machine-readable reason;
- exhausted transient/unknown retry becomes `dead_letter` and emits an operator-visible structured event/metric; clinic UI may surface delivery failure without exposing provider secrets;
- a newer superseding/terminal stream version can make any not-yet-started retry `skipped_obsolete` rather than consuming remaining attempts.

Required barrier/crash tests:
1. newer mutation before dispatch transition => old provider call suppressed;
2. newer mutation after provider invocation starts => old call may finish, newer/terminal remains deliverable;
3. unknown retry reuses idempotency key;
4. terminal cancellation suppresses all older not-yet-started replaceable intents;
5. crash after `dispatching` before result persists leads to explicit `unknown` recovery, never silent loss;
6. retry exhaustion produces `dead_letter` plus observable operator signal.

## Database integrity defense-in-depth

Implementation must use PostgreSQL constraints/indexes/locking where possible, not application checks alone, including:
- canonical enum/check constraints for queue/session/appointment states;
- uniqueness of generated future session occurrence;
- uniqueness/consistency of active priority slots within a session;
- no duplicate appointment->queue linkage where cardinality is one;
- doctor-level serialization for active service stream and active consultation;
- optimistic/version fields where stale client mutation must be rejected.

Exact DDL strategy is selected during implementation and proved by PostgreSQL integration tests.

## Observability, privacy and audit

Operational logs exclude patient names, raw phone numbers, bearer credentials, exchange IDs and sensitive notification bodies. Audit events are separate from logs and include actor/action/target/clinic/session/time/reason with minimum necessary snapshots. Correlation IDs must be non-sensitive.

## Testing gates before production code is considered releasable
- pure state-machine/estimator tests;
- PostgreSQL concurrency tests for check-in/call/priority/session lifecycle/doctor-global stream/restore/transfer;
- API tenant/role/ownership tests;
- guest exchange/log/referrer security tests;
- notification supersession/dispatch/retry/dead-letter barrier tests;
- SSE reconnect/version-gap/polling-fallback tests;
- Arabic RTL/French localization tests;
- end-to-end clinic-day scenarios with scheduled appointments, walk-ins, guests, delays, no-shows, transfers and session cancellation.

## Remaining review questions
- exact Prisma vs lower-level SQL split after concurrency prototypes;
- conventional audit table vs richer append-log representation;
- first real SMS provider and commercial/legal onboarding;
- degraded reception workflow during prolonged connectivity loss.

None of those may weaken the contracts above.