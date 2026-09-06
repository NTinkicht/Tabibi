# ChatGPT Handoff

## Durable reconciliation

PR #12, Issue #4 bounded work unit 1, was independently accepted and merged into
`main` at merge commit `a4f0ceb3f12f830fa412b6823196f585cebeee7c`.
Claude reviewed exact head `c897d68d01fc222f5963b18d96099d9bb743c1a9`,
all required CI jobs passed, and no BLOCKER or MAJOR finding remains. The two
review notes (32-bit advisory-hash collision can only over-serialize, and IANA
timezone validation is deferred) are non-blocking and do not expand the next
work unit.

Issue #4 remains the clinic-operations epic even if GitHub automatically closed
it when PR #12 merged. Work unit 2 below is architecturally approved.

## Approved work unit 2: receptionist operational session controls

Implement one bounded PR from current `main` with these requirements:

1. Add an authenticated, clinic-scoped server/API surface for listing sessions,
   manually creating a `planned` session, opening, pausing, resuming, normally
   closing, cancelling, and declaring/updating/clearing doctor delay.
2. Manual creation accepts an associated clinic doctor, service date, and bounded
   start/end instants. It must validate the clinic/doctor association, `ends_at >
   starts_at`, and reject an exact duplicate through a deterministic database
   identity or explicit idempotency key. It creates only `planned` sessions and
   does not create an implicit schedule, patient, appointment, or queue entry.
3. Use explicit commands rather than a generic client-selected status update.
   Enforce the canonical state-by-operation table in `ARCHITECTURE.md`.
   `planned -> open`, `open -> paused`, `paused -> open`, `open|paused -> closed`,
   and `planned|open|paused -> cancelled` are the only non-retry lifecycle paths.
   An exact retry of a successful command returns the committed result without a
   duplicate audit event; a different or stale command receives a typed conflict.
4. Preserve the doctor-global open-session invariant. Open and resume acquire the
   doctor-global boundary before the session boundary, re-read committed state,
   and rely on PostgreSQL defense in depth. Do not replace this with an in-memory
   lock. Ensure the existing open/open and open/resume race coverage remains
   green and add lifecycle-versus-lifecycle race tests for the new command API.
5. Add persisted delay state sufficient for a strictly positive finite whole
   number of minutes and its monotonically increasing version. Declare/update and
   clear are separate commands, allowed only in `planned|open|paused`; zero,
   negative, fractional, non-finite, malformed, and unreasonably large values are
   rejected without side effects. Choose and document a conservative operational
   maximum in code. Exact retries are idempotent. Every successful change records
   metadata-only audit (`from`, `to`, and version), never patient or free-form
   clinical data. Notification and estimator fan-out are deferred until those
   modules exist.
6. Authorization is server-side and clinic-scoped. `receptionist` and
   `clinic_admin` may perform all commands in this unit. A `doctor` may operate
   only their own associated sessions. `platform_admin` has no implicit clinic
   access. Cross-clinic session or doctor IDs return the established non-leaking
   not-found/conflict shape.
7. Add a small receptionist session-control page using the existing application
   conventions. It must show loading, empty, error, current-state, and pending
   mutation states; expose only state-valid actions; prevent accidental duplicate
   submission; remain usable on narrow/mobile and desktop widths; externalize
   user-facing Arabic and French strings; and preserve RTL layout. Do not add a
   patient list or pretend queue-dependent data exists.
8. Add unit, API, real-PostgreSQL integration, and browser-smoke coverage for role
   boundaries, tenant isolation, manual-create retry/duplicate handling, all
   lifecycle commands and exact retries, invalid/stale transitions, delay
   validation/versioning/idempotency, concurrent open/resume behavior, audit
   cardinality, and the principal Arabic/French receptionist flow.

### Explicit exclusions

Do not add `QueueEntry`, patient/guest/contact data, `Appointment`, check-in,
call/consultation progression, priority, restore, transfer, bulk no-show, ETA,
SSE, guest credentials, or notification delivery in this PR. Because no queue
table exists yet, normal close and whole-session cancellation have no queue rows
to inspect or dispose of; do not create fake precondition/disposal behavior.
Their queue-coupled transactional semantics must be completed in the later queue
work unit before the end-to-end clinic-day milestone is claimed.

### Merge gates and continuation

Run formatting, lint, typecheck, unit/API tests, PostgreSQL integration tests,
migrations twice for checksum/idempotency, dependency audit, production build,
and browser smoke. Open one PR to `main`; then post `HANDOFF_TO_CLAUDE` with its
exact head SHA and CI evidence and mirror a concise dispatch to Issue #11. Merge
is forbidden until Claude gives an exact-SHA `MERGE_READY` and all required CI is
green.

`HANDOFF_TO_CODEX`

@codex implement this issue now

next_actor: codex_cloud

next_action: implement only Issue #4 bounded work unit 2 above from current
`main`, open one PR, verify all required checks, and hand the exact head to Claude.
