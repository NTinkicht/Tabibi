# P0 evidence matrix (TAB-P0-01..15)

Serves issue #729 and the `PRODUCT.md` "Execution and completion protocol". This file is evidence for the owner; it does not change any `PRODUCT.md` status.

## Method and limits

- Baseline: `main` at `7450a943` (PR #738; #739 merged afterwards, so TAB-P0-01 cites it). Latest green `CI` run on that commit: `41414559219` (format, lint, typecheck, unit+api, build, PostgreSQL integration, recovery rehearsal, clinic-day load, full Playwright suite).
- Each evidence line is machine-checkable: `node scripts/verify-p0-evidence-matrix.mjs` fails if a cited `src:` path or `test:` file/title no longer exists. `npm run test:unit` runs the same check (`tests/unit/p0-evidence-matrix.test.ts`).
- Verdicts: COVERED = implementation and a requirement-specific test were both located and the test title matches the criterion; PARTIAL = part of the criterion is evidenced or only indirectly; MISSING = no implementation or test found. A document alone never yields COVERED. Test bodies were located, not re-derived line by line; the green `main` run is the execution evidence.
- Independent review: every cited PR was approved by `ntk-reviewer[bot]` on its exact merged head (listed as `pr:`). PRs older than the cited ones (WU1..WU190 era) were not individually audited here and are marked `review: not audited`.
- Exit criteria are condensed from the `PRODUCT.md` row of the same ID; the row text is authoritative.

## TAB-P0-01 Tenant identity, RBAC, scoped API, staff session

- [COVERED] Staff sessions store only a verifier and are revocable | src: src/modules/identity/index.ts, db/migrations/0036_staff_sessions.sql | test: tests/integration/staff-session-revocation.test.ts :: "stores only a SHA-256 verifier of the session identifier" | pr: #635 (ntk-reviewer APPROVED ec834746f895)
- [COVERED] Revoked/expired tokens rejected, replay is a no-op | src: src/modules/identity/index.ts | test: tests/integration/staff-session-revocation.test.ts :: "treats a replayed revoked token as an idempotent no-op that stays rejected"; tests/unit/staff-session-claims.test.ts :: "rejects an expired token and a token at its exact expiry second" | pr: #629 (ntk-reviewer APPROVED 91fc21ae3c10)
- [COVERED] Origin/CSRF check on staff mutations | src: src/modules/identity/index.ts | test: tests/unit/staff-auth.test.ts :: "rejects a cross-site origin even when a Host header is present" | pr: review: not audited
- [COVERED] Every staff route enforces an authorization boundary | src: src/middleware.ts | test: tests/api/staff-route-boundary-matrix.test.ts :: "lists every discovered route module and exported handler" | pr: review: not audited
- [COVERED] Password sign-in: salted hash, uniform 401, lockout | src: src/modules/identity/staff-credentials.ts, db/migrations/0045_staff_credentials.sql | test: tests/integration/staff-credentials.test.ts :: "locks after N consecutive failures, refuses the right password while locked, and resets on success"; tests/integration/staff-sign-in.test.ts :: "returns one uniform 401 for unknown user, wrong password and locked account" | pr: #733 (ntk-reviewer APPROVED 9cb4fc535092)
- [COVERED] Cross-tenant denial on membership administration | src: src/modules/identity/index.ts | test: tests/integration/staff-membership-http-api.test.ts :: "denies non-admin staff and other clinics" | pr: review: not audited
- [COVERED] Secure configuration fails fast | src: src/platform/config/env.ts | test: tests/unit/env.test.ts :: "fails fast when the database URL is absent" | pr: review: not audited
- [PARTIAL] Cross-tenant IDOR matrix over all read/write routes | src: src/modules/identity/index.ts | test: tests/integration/queue-lifecycle.test.ts :: "enforces clinic isolation and one called/consulting patient under concurrent commands" | pr: review: not audited
- [COVERED] First clinic_admin bootstrap and staff invites: verifier-only token, admin-only create/revoke, cross-clinic denied | src: src/modules/identity/bootstrap-admin.ts, src/modules/identity/staff-invites.ts | test: tests/integration/staff-invites.test.ts :: "limits grantable roles: clinic_admin and unknown roles are refused" | pr: #739 (merged; ntk-reviewer verdict not audited)

## TAB-P0-02 Scheduling, availability, deterministic sessions

- [COVERED] Deterministic idempotent session generation | src: src/modules/scheduling/index.ts | test: tests/integration/clinic-scheduling.test.ts :: "generates seven days idempotently and prevents concurrent duplicates" | pr: review: not audited
- [COVERED] Timezone and DST-gap handling | src: src/modules/scheduling/index.ts, db/migrations/0037_clinic_closures.sql | test: tests/integration/scheduling-dst-gap.test.ts :: "leaves a clinic without DST unaffected for the same local times" | pr: review: not audited
- [COVERED] Doctor temporal collision validation incl. midnight spans | src: src/modules/scheduling/index.ts | test: tests/integration/doctor-session-overlap.test.ts :: "rejects an overlap with a session that spans midnight from the previous day" | pr: review: not audited
- [COVERED] Consultation types, absences, closures over HTTP with role checks | src: src/modules/scheduling/consultation-types.ts, db/migrations/0038_consultation_types.sql, db/migrations/0039_doctor_absences.sql | test: tests/integration/consultation-types.test.ts :: "denies creation to receptionists, doctors, outsiders and other clinics"; tests/integration/scheduling-http-api.test.ts :: "maps an overlapping template to 409 and a receptionist write to 403" | pr: #658 (ntk-reviewer APPROVED 3c1e18461bff)

## TAB-P0-03 Discovery

- [COVERED] Privacy-minimal deterministic projections | src: src/app/public-discovery-clinics.ts | test: tests/integration/public-discovery.test.ts :: "returns deterministic active-clinic projections without internal identifiers" | pr: #691 (ntk-reviewer APPROVED f052353c480e)
- [COVERED] Strict filters, allow-list and no-store | src: src/app/public-discovery-pages.ts | test: tests/api/public-discovery.test.ts :: "rejects unknown, repeated, empty or uncontrolled filters without querying"; tests/api/public-discovery.test.ts :: "never serializes sensitive fields added by the discovery service" | pr: #691 (ntk-reviewer APPROVED f052353c480e)
- [COVERED] Bookable-session windows and empty result | src: src/modules/public-availability/index.ts | test: tests/integration/public-bookable-sessions.test.ts :: "returns an empty list when nothing is bookable" | pr: #671 (ntk-reviewer APPROVED ef1bd90fdc5b)
- [COVERED] Pagination, availability and language filters | src: src/app/public-discovery-pages.ts | test: tests/integration/public-discovery.test.ts :: "combines both filters" | pr: #695 (APPROVED afe2e955eb59 after earlier CHANGES_REQUESTED f06593166a36), #693 (APPROVED 2fed98147a2d), #697 (APPROVED 6b48162dd8ec)

## TAB-P0-04 Pure queue/session contract

- [COVERED] Full state x command matrix, session gating | src: src/modules/queue/lifecycle-contract.ts | test: tests/unit/queue-lifecycle-contract.test.ts :: "matches the full state x command matrix"; tests/unit/queue-lifecycle-contract.test.ts :: "gates queue commands on the session status" | pr: #673 (ntk-reviewer APPROVED f16d536cefde)
- [COVERED] Session 5x5 matrix, reason/lock rules, close precondition | src: src/modules/session/lifecycle-contract.ts | test: tests/unit/session-lifecycle-contract.test.ts :: "enforces the full 5x5 command x status matrix"; tests/unit/session-lifecycle-contract.test.ts :: "blocks closing while any non-terminal queue entry remains (v4)" | pr: #675 (ntk-reviewer APPROVED 94c704b49888)
- [COVERED] Priority insert 1..N+1 and waiting priority never call-eligible | src: src/modules/queue/ordering-contract.ts | test: tests/unit/queue-lifecycle-contract.test.ts :: "inserts a new entry at every position 1..N+1"; tests/unit/queue-lifecycle-contract.test.ts :: "never makes a waiting entry with priority call-eligible" | pr: #683 (ntk-reviewer APPROVED f0b3c3424c4a)
- [COVERED] Versioned ordering contract bound to call selection | src: src/modules/queue/ordering-contract.ts | test: tests/unit/queue-ordering-contract.test.ts :: "binds call selection to the exact versioned ordering contract" | pr: review: not audited

## TAB-P0-05 PostgreSQL serialized mutation

- [COVERED] Fixed-seed adversarial replay keeps invariants | src: src/modules/queue/index.ts | test: tests/integration/queue-adversarial.test.ts :: "replays a fixed-seed operational sequence and preserves invariants after every step" | pr: review: not audited
- [COVERED] Doctor-global open guard, DB-enforced | src: db/migrations/0032_doctor_global_consultation_open_guard.sql, db/migrations/0034_doctor_global_active_consultation_guard.sql | test: tests/integration/clinic-scheduling.test.ts :: "WU177 rejects a direct open INSERT while another clinic has the doctor in consultation" | pr: review: not audited
- [COVERED] Per-transition audit; one called/consulting patient under concurrency | src: src/modules/audit/index.ts | test: tests/integration/queue-lifecycle.test.ts :: "progresses check-in through completion and audits every transition" | pr: review: not audited
- [COVERED] Concurrent delay update/clear serialization | src: src/modules/session/index.ts | test: tests/integration/session-delay-hardening.test.ts :: "serializes truly concurrent update-delay and clear-delay commands" | pr: review: not audited
- [COVERED] Negative payload/authN vectors and audit vectors | src: src/modules/queue/index.ts | test: tests/integration/queue-operations-negative.test.ts :: "rejects invalid reorder payloads before they can mutate queue state"; tests/integration/queue-mutation-audit-vectors.test.ts :: "pins the vector contract version" | pr: review: not audited
- [PARTIAL] Exact-retry and outbox atomicity at queue-command level (covered by outbox tests, not shown per transition) | src: src/modules/notification-outbox/index.ts | test: tests/integration/queue-notification-producer.test.ts :: "replays one source event idempotently and supersedes only with a newer version" | pr: review: not audited

## TAB-P0-06 Booking and appointment sync

- [COVERED] One confirmed appointment linked to one waiting entry | src: src/modules/appointment/index.ts | test: tests/integration/appointment-booking.test.ts :: "atomically creates one confirmed appointment linked to one waiting queue entry" | pr: review: not audited
- [COVERED] Idempotency conflict and terminal session rejection | src: src/modules/appointment/index.ts | test: tests/integration/appointment-booking.test.ts :: "rejects conflicting idempotency reuse, foreign patients, terminal sessions" | pr: review: not audited
- [COVERED] Guest booking replay, rollback and convergence | src: src/modules/public-guest-booking/index.ts, db/migrations/0027_public_guest_booking.sql | test: tests/integration/public-guest-booking.test.ts :: "converges concurrent equivalents and rolls back every row after a late failure" | pr: #618 (ntk-reviewer APPROVED 1ae9c9463af7)
- [COVERED] Receipt credential binding (authentic ciphertext swap) | src: src/modules/public-guest-booking/index.ts | test: tests/integration/public-guest-booking.test.ts :: "creates one privacy-safe booking and replays the same usable capability" | pr: #618 (ntk-reviewer APPROVED 1ae9c9463af7)
- [PARTIAL] Ciphertext cleanup/retention of replay receipts (PRODUCT.md forbids claiming a scrubber exists; none found in src) | src: src/modules/public-guest-booking/index.ts | pr: review: not audited

## TAB-P0-07 Staff arrival, no-show, transfer, priority

- [COVERED] Contact-less walk-in registration, exact retry, no PII | src: src/modules/queue/index.ts | test: tests/integration/walkin-queue.test.ts :: "registers a contact-less patient as waiting without exposing PII in the public representation" | pr: review: not audited
- [COVERED] Registration race against closed session | src: src/modules/queue/index.ts | test: tests/integration/walkin-queue.test.ts :: "never commits an active waiting row into a closed session during a registration race" | pr: review: not audited
- [COVERED] Priority insert/move bounds, roles, tenants | src: src/modules/queue/index.ts, db/migrations/0006_queue_priority_order.sql | test: tests/integration/queue-priority.test.ts :: "supports waiting inserts, enforces insert/move bounds, roles, and tenants" | pr: #683 (ntk-reviewer APPROVED f0b3c3424c4a)
- [COVERED] Bulk no-show only after grace, never reclassifies arrived | src: src/modules/appointment/index.ts, db/migrations/0031_appointment_bulk_no_show.sql | test: tests/integration/appointment-bulk-no-show.test.ts :: "never reclassifies cancelled or arrived appointments and leaves queue revision unchanged" | pr: review: not audited
- [COVERED] Arabic/French keyboard-operable receptionist UI | src: src/app/operations | test: tests/e2e/receptionist-bilingual-accessibility.spec.ts :: "receptionist queue stays clinic-scoped, private, bilingual, and keyboard operable" | pr: review: not audited
- [COVERED] Transfer is serialized ahead of a queued cancellation without split state | src: src/modules/queue/index.ts, src/modules/appointment/index.ts | test: tests/integration/appointment-recovery-race.test.ts :: "serializes transfer ahead of a queued cancellation without split state" | pr: review: not audited
- [COVERED] Restore-versus-cancel, restore-versus-call and priority-insert-versus-transfer races are named tests | src: src/modules/appointment/recovery.ts, src/modules/queue/index.ts | test: tests/integration/queue-restore-race.test.ts :: "applies a restore queued ahead of a competing cancel, then the cancel"; tests/integration/queue-restore-race.test.ts :: "rejects a second restore queued behind a first restore that already restored the appointment"; tests/integration/queue-restore-race.test.ts :: "applies a cancel queued ahead of a restore of an active appointment, then restores it"; tests/integration/queue-restore-race.test.ts :: "rejects a priority insert queued behind a transfer of the same entry without leaving priority state"; tests/integration/queue-restore-race.test.ts :: "rejects a call queued ahead of restore_and_check_in of a cancelled entry, then checks the entry in"; tests/integration/queue-restore-race.test.ts :: "calls the entry once restore_and_check_in queued ahead of the call has made it callable" | pr: pending (#759)
- [COVERED] Priority move versus call-next and cancel races are named held-session-lock tests (stale move rejected behind a call or cancel with no priority state or receipt; move queued ahead of a call applies and the call is rejected as not next) | src: src/modules/queue/index.ts | test: tests/integration/queue-priority-race.test.ts :: "rejects a priority move queued behind a call of another entry as stale"; tests/integration/queue-priority-race.test.ts :: "applies a priority move queued ahead of a call of the former head, then rejects the call as not next"; tests/integration/queue-priority-race.test.ts :: "rejects a priority move queued behind a cancel of the same entry without priority state" | pr: pending (#763)

## TAB-P0-08 Guest status access and encrypted exchange link

- [COVERED] Single-use exchange, verifier-only persistence, target binding | src: src/modules/guest-access/index.ts, db/migrations/0014_guest_exchange_credential_foundation.sql | test: tests/integration/guest-access.test.ts :: "persists only verifiers, then consumes exactly once with target binding and safe audit metadata" | pr: review: not audited
- [COVERED] Hardened status cookie issued on exchange | src: src/app/api | test: tests/api/guest-exchange.test.ts :: "sets a hardened bearer cookie and redirects without credentials" | pr: review: not audited
- [COVERED] Rotation/revocation rejects old credential | src: src/modules/guest-status/index.ts | test: tests/integration/guest-status-credential-rotation.test.ts :: "rejects an old bearer when its exact credential is revoked after authorization" | pr: review: not audited
- [COVERED] Staff-created guest status link audited without link material | src: src/modules/guest-access/index.ts | test: tests/integration/staff-status-link.test.ts :: "mints a link for same-clinic staff, stores only a verifier, and audits without link material" | pr: #738 (merged; reviewer not audited)
- [COVERED] Envelope-encrypted exchange-link outbox intents (AES-GCM, AAD binding intent/entry/clinic, ciphertext TTL capped at the exchange deadline, missing or short key fails closed) | src: src/modules/guest-access/link-envelope.ts | test: tests/unit/guest-link-envelope.test.ts :: "rejects any AAD binding drift (intent, entry, clinic)"; tests/unit/guest-link-envelope.test.ts :: "refuses a missing or short key without a plaintext fallback"; tests/unit/guest-link-envelope.test.ts :: "caps expiry at the exchange absolute deadline and rejects expired ones" | pr: #742 (merged; reviewer not audited)
- [COVERED] Cross-class negative tests (status cookie vs Authorization route) | src: src/app/api/public/bookings, src/app/api/guest | test: tests/api/guest-credential-class-boundary.test.ts :: "Authorization-only route %s ignores the exchange status cookie" | pr: #765 review: not audited

## TAB-P0-09 Guest booking arrival confirmation

- [COVERED] Atomic single check-in, one audit, reconciled response | src: src/modules/public-guest-booking-check-in/index.ts, db/migrations/0028_public_guest_check_in_operations.sql | test: tests/integration/public-guest-booking-check-in.test.ts :: "atomically checks in once, increments the session version, emits one privacy-safe audit" | pr: review: not audited
- [COVERED] Distinct-operationId race converges to one transition | src: src/modules/public-guest-booking-check-in/index.ts | test: tests/integration/public-guest-booking-check-in.test.ts :: "converges concurrent distinct-operationId races on one eligible booking into exactly one transition" | pr: review: not audited
- [COVERED] Tampered/expired/revoked/terminal fail closed generically | src: src/modules/guest-access/index.ts | test: tests/integration/public-guest-booking-check-in.test.ts :: "fails closed for tampered, expired, revoked, drifted, and terminal bookings with zero check-in audit"; tests/integration/guest-bearer-authorization.test.ts :: "rejects a forged bearer envelope before credential verification" | pr: review: not audited
- [COVERED] Bearer from Authorization header only, memory-only handoff | src: src/modules/public-guest-live-queue-status/index.ts | test: tests/api/public-guest-live-queue-stream.test.ts :: "accepts the bearer only from the Authorization header"; tests/e2e/guest-live-queue.spec.ts :: "guest live queue completes the booking-to-live handoff using only the Authorization header" | pr: review: not audited

## TAB-P0-10 Deterministic ETA

- [COVERED] Sample precedence, invalid/future timestamps fail closed | src: src/modules/queue-eta-estimator, src/modules/estimation/README.md | test: tests/unit/queue-eta-estimator.test.ts :: "prefers three current-session samples over historical evidence"; tests/unit/queue-eta-estimator.test.ts :: "fails closed for invalid or future active-consultation timestamps" | pr: review: not audited
- [COVERED] Uncertainty vectors, deterministic and stale rejected | src: src/modules/queue-eta-estimator | test: tests/unit/eta-uncertainty-vectors.test.ts :: "rejects stale publication and requires recomputation" | pr: #714 (ntk-reviewer APPROVED 85d5618344f3)
- [COVERED] Historical prior vs dashboard snapshot race | src: src/modules/queue-eta-estimator | test: tests/integration/wu68-historical-eta-concurrency.test.ts :: "never mixes a newly committed historical threshold/delay with the older dashboard snapshot" | pr: review: not audited

## TAB-P0-11 ETA audit and source epochs

- [COVERED] Source epoch bumps on lifecycle, ordering, transfer | src: db/migrations/0042_eta_source_epoch.sql | test: tests/integration/session-eta-source-epoch.test.ts :: "bumps both sessions exactly once for a transfer between sessions" | pr: #705 (ntk-reviewer APPROVED d2bb8f0c825b)
- [COVERED] Contract version persisted and immutable | src: db/migrations/0044_eta_publication_claims.sql | test: tests/integration/eta-contract-version-audit.test.ts :: "keeps the stored version immutable" | pr: #714 (ntk-reviewer APPROVED 85d5618344f3)
- [COVERED] Claim CAS at current epochs, stale after prior change | src: db/migrations/0044_eta_publication_claims.sql | test: tests/integration/eta-publication-claims.test.ts :: "is stale after a historical prior change from another session" | pr: #709 (ntk-reviewer APPROVED 25ebe77fb730)
- [COVERED] Receptionist ETA publication path | src: src/modules/receptionist-dashboard | test: tests/unit/receptionist-eta-publication.test.ts :: "refuses a non-staff role before reading epochs or claiming" | pr: #716 (ntk-reviewer APPROVED 00958b7a5a33)

## TAB-P0-12 Live status transports

- [COVERED] Booking-bearer capability read and drift refusal | src: src/modules/public-guest-live-queue-status/index.ts | test: tests/integration/public-guest-live-queue-status.test.ts :: "rejects permitted queue-entry association drift instead of reading the reassigned queue state" | pr: review: not audited
- [COVERED] Cookie SSE closes on terminal, no bearer in stream | src: src/modules/guest-status/index.ts | test: tests/api/guest-status-stream.test.ts :: "closes an already-terminal stream without transporting the snapshot or bearer"; tests/e2e/guest-status-sse-terminal.spec.ts :: "guest SSE change to terminal closes the stream and does not schedule fallback work" | pr: review: not audited
- [COVERED] Terminal state stops header polling permanently | src: src/app/guest | test: tests/e2e/guest-live-queue.spec.ts :: "a terminal booking/queue state stops polling permanently" | pr: review: not audited
- [COVERED] 15-minute fake-clock terminal grace at T0, T0+15m, T0+15m+epsilon | src: src/modules/public-guest-live-queue-status/index.ts | test: tests/integration/guest-status.test.ts :: "enforces the 15-minute terminal grace at T0, T0+15m and T0+15m+epsilon" | pr: #748 (merged; reviewer not audited)

## TAB-P0-13 Notification outbox and dead letters

- [COVERED] Versioned outbox, supersede pending only, idempotent retry | src: src/modules/notification-outbox/index.ts, db/migrations/0016_notification_outbox_foundation.sql | test: tests/integration/notification-outbox.test.ts :: "enqueues increasing versions and supersedes only the previous pending intent" | pr: review: not audited
- [COVERED] Dead-letter after exhaustion without aborting batch | src: src/modules/notification-outbox/observability.ts | test: tests/integration/notification-dispatch-resilience.test.ts :: "dead-letters an exhausted resolver failure without aborting the later batch item" | pr: review: not audited
- [COVERED] Material-change thresholds | src: src/modules/notification-domain | test: tests/unit/material-estimate-change.test.ts :: "marks a queue-position change at the default threshold as material" | pr: review: not audited
- [COVERED] Infrastructure faults never reported as delivered | src: src/modules/notification-outbox/dispatch-eligibility.ts | test: tests/unit/notification-fault-injection.test.ts :: "never reports delivered when inbox persistence throws an infrastructure fault" | pr: review: not audited
- [PARTIAL] Guest-link intent dispatch worker is COVERED (claim, decrypt-at-dispatch, bounded retry, dead letter, fenced leases); a real external provider adapter and staff escalation of failed deliveries beyond the notifications screen are not located (owner decision #730: in-app plus staff-assisted, no paid provider) | src: src/modules/guest-access/link-intents.ts | test: tests/integration/guest-link-intents.test.ts :: "decrypts only at dispatch and scrubs after delivery"; tests/integration/guest-link-intents.test.ts :: "dead-letters after max attempts and scrubs the ciphertext"; tests/integration/guest-link-intents.test.ts :: "fences a slow sender so a replaced worker cannot clobber the new claim" | pr: #746 (merged; reviewer not audited)
- [COVERED] Ciphertext scrub after delivered/terminal/expired outcomes, with database constraint against ciphertext on terminal rows | src: src/modules/guest-access/link-intents.ts, db/migrations/0048_guest_link_intents.sql | test: tests/integration/guest-link-intents.test.ts :: "scrubs ciphertext atomically on delivered and dead_letter, once"; tests/integration/guest-link-intents.test.ts :: "database rejects ciphertext on terminal rows and TTL above ten minutes" | pr: #744 (merged; reviewer not audited)

## TAB-P0-14 Arabic RTL / French LTR and accessibility

- [COVERED] Arabic mobile queue view recovers from stale conflict and switches to French | src: src/modules/localization | test: tests/e2e/queue-rtl-mobile.spec.ts :: "mobile Arabic queue view reloads safely after a stale reorder conflict and can switch back to F" | pr: review: not audited
- [COVERED] Receptionist keyboard/bilingual accessibility | src: src/app/operations | test: tests/e2e/receptionist-bilingual-accessibility.spec.ts :: "receptionist queue stays clinic-scoped, private, bilingual, and keyboard operable" | pr: review: not audited
- [PARTIAL] Doctor flows in both languages: no doctor-facing Playwright journey was located | src: src/app/operations | pr: none
- [PARTIAL] Screen-reader label and viewport-width coverage is per-spec, not asserted as a matrix | src: src/app | test: tests/e2e/public-discovery-browser-locale.spec.ts :: "Non-Arabic browser uses French directory and supports deliberate Arabic choice" | pr: review: not audited

## TAB-P0-15 Privacy/tenant security, migrations, release assurance

- [COVERED] Real migrator applies full chain and re-runs as a no-op | src: db/migrations/0001_platform_baseline.sql | test: tests/integration/migration-chain.test.ts :: "applies every committed migration through the real migrator and re-runs as a no-op" | pr: review: not audited
- [COVERED] Recovery rehearsal is opt-in and refuses production | src: scripts/db | test: tests/unit/recovery-rehearsal.test.ts :: "requires explicit opt-in and refuses production mode" | pr: review: not audited
- [COVERED] Two-clinic isolation under a synthetic clinic day | src: src/modules/queue/index.ts | test: tests/integration/release-clinic-day-isolation.test.ts :: "progresses two real clinic queues independently and rejects cross-clinic mutation" | pr: review: not audited
- [COVERED] Container image never bakes secrets | src: Dockerfile | test: tests/unit/container-image.test.ts :: "never sets a value on a secret-looking ENV or ARG" | pr: #736 (ntk-reviewer APPROVED d89d5fea3f06)
- [PARTIAL] Threat model is a delta document (`docs/release/release-threat-model-delta.md`); no penetration checklist or rollback drill was located | src: docs/release/release-threat-model-delta.md | pr: none
- [MISSING] Secret scan in CI (only `npm audit` found in `.github/workflows/ci.yml`) | src: .github/workflows/ci.yml | pr: none
- [PARTIAL] Inspection of notification ciphertext at rest and post-terminal scrub: database-level constraint and scrub are tested, but no release-time inspection procedure over a real database was located | src: src/modules/guest-access/link-intents.ts | test: tests/integration/guest-link-intents.test.ts :: "stores only envelope ciphertext, never the plaintext material" | pr: #744 (merged; reviewer not audited)

## Proposed status per row (owner decides; nothing here edits PRODUCT.md)

| Row | Proposed | Why |
| --- | --- | --- |
| TAB-P0-01 | VERIFY | cross-tenant IDOR matrix over all routes is PARTIAL |
| TAB-P0-02 | VERIFY | all criteria COVERED but review of pre-#600 PRs not audited |
| TAB-P0-03 | VERIFY | all COVERED; review evidence present for recent PRs only |
| TAB-P0-04 | VERIFY | all COVERED; ready once P0-01..03 pass |
| TAB-P0-05 | VERIFY | one PARTIAL (outbox atomicity per transition) |
| TAB-P0-06 | VERIFY | receipt cleanup PARTIAL |
| TAB-P0-07 | VERIFY | restore races COVERED (#759, restore-versus-call #761); priority move vs call/cancel races COVERED (#763) |
| TAB-P0-08 | VERIFY | envelope intents COVERED (#742); status-cookie cross-class negatives PARTIAL, review of pre-#600 PRs not audited |
| TAB-P0-09 | VERIFY | COVERED; review evidence not audited |
| TAB-P0-10 | VERIFY | COVERED; review evidence partly audited |
| TAB-P0-11 | VERIFY | COVERED with review evidence on #705/#709/#714/#716 |
| TAB-P0-12 | VERIFY | all criteria COVERED incl. #748 grace test; review of pre-#600 PRs not audited |
| TAB-P0-13 | VERIFY | scrub and dispatch worker COVERED (#744, #746); external provider and escalation PARTIAL |
| TAB-P0-14 | VERIFY | doctor flows PARTIAL |
| TAB-P0-15 | VERIFY | secret scan MISSING; ciphertext inspection procedure PARTIAL |

No row is proposed as VERIFIED: the protocol also requires per-row independent review of the full implementing history, which this matrix could only confirm for the recent PRs listed.

## Candidate follow-up issues (one is opened per run)

1. (done: #742) Envelope-encrypted exchange-link outbox intents with AAD binding (P0-08).
2. (done: #744, #746; external provider and escalation remain, see owner decision #730) Ciphertext scrub and provider worker lifecycle (P0-13).
3. Secret scan in CI and penetration checklist (P0-15).
4. Doctor-facing bilingual Playwright journey (P0-14).
5. (15-minute grace done: #748; restore-vs-cancel and priority-vs-transfer done: #759; restore-vs-call done: #761) Named restore race and terminal-grace tests (P0-07, P0-12).
6. Replay-receipt ciphertext retention/scrub audit (P0-06).
