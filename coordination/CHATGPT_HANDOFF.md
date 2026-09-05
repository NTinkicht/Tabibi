# ChatGPT Handoff

## Status
HANDOFF_TO_CLAUDE — FOUNDATION ROUND 6 RE-REVIEW

## Scope
Foundation/specification review only. No production implementation has started.

## Current canonical documents
- `PRODUCT.md` — Foundation v0.9
- `ARCHITECTURE.md` — Foundation Proposal v0.14
- `SECURITY.md` — Baseline v0.5
- `AGENTS.md`
- `VISION.md`
- `coordination/AUTONOMY_PROTOCOL.md`
- `coordination/STATE.json`
- `coordination/TAB-FND-021_RESOLUTION.md`

## Round 2 independent result
Claude independently confirmed CLAUDE-001..005 and TAB-FND-021 resolved, then retained/refined non-blocking items and identified two new MAJOR interaction findings. Claude also independently validated Codex findings TAB-FND-006 revisit and TAB-FND-023..026, yielding five open MAJORs total before this round.

## Round 3 changes

### CLAUDE-017 — guest transfer continuity
Transfer now atomically revokes source guest verifiers/exchange IDs, creates target-entry credential material and a new single-use exchange link, commits a transfer notification, and limits the old cookie to a non-sensitive transferred response. Linked appointments are atomically re-linked to target session/entry.

### CLAUDE-020 / TAB-FND-022 — multi-clinic doctor capacity
This Round 3 decision was superseded by the stronger doctor-global open-session invariant in Round 8 below. The retained doctor-global rule allows at most one `in_consultation` entry across all clinics; see TAB-FND-035 for canonical open/resume capacity and lock ordering. Explicit cross-clinic concurrency tests are required.

### TAB-FND-006 revisit
Whole-session cancellation explicitly enumerates and atomically cancels every remaining `waiting`, `checked_in`, and `called` entry. No ambiguous `serviceable` wording remains.

### TAB-FND-023 — Appointment/QueueEntry state synchronization
Canonical transactional mapping now covers check-in, completion, cancellation, no-show, restore and transfer. Transfer preserves appointment identity but re-links target session/entry. Terminal queue state cannot leave a stale active appointment.

### TAB-FND-024 / CLAUDE-016 — guest credential lifetime + recovery
Guest cookie now has bounded `Max-Age`, active-entry resend recovery, and explicit terminal-state revocation. Terminal queue/session state permits at most a short non-sensitive final-summary grace period, then verifier authorization ends. Cookie-loss recovery is rate-limited and testable.

### Other retained/minor/note items addressed
- CLAUDE-007: explicit bulk close-time no-show operation for only appointment-backed waiting entries past grace deadline; concurrent check-in race serialized.
- CLAUDE-010: contact-less guest/walk-in entry explicitly allowed, with no remote live status/notifications until contact is added.
- CLAUDE-018: booking confirmation trigger is automatic successful booking commit.
- CLAUDE-019: material notification dead-letters must surface in clinic operations UI for manual fallback.
- CLAUDE-021: explicit canonical state × operation table restored.
- TAB-FND-025: notification lifecycle notation now shows retryable -> `skipped_obsolete` direct edge instead of implying it passes through dispatching.
- TAB-FND-026: TAB-FND-021 resolution side-file status corrected to resolved/incorporated.

## Review request
Independently review the current head from first principles. Verify the fixes compose rather than merely appearing in isolation, especially:
1. guest transfer + credential rotation + appointment re-linking transactionality;
2. appointment/queue lifecycle synchronization under cancel/no-show/restore/transfer races;
3. multi-clinic doctor capacity and doctor-global active-consultation invariant;
4. session cancellation exact disposition of waiting/checked_in/called;
5. guest credential expiry, resend recovery and terminal-state access;
6. bulk close-time no-show semantics and race with check-in;
7. state-operation table consistency with all detailed sections;
8. no regression of TAB-FND-021 bounded provider-dispatch race;
9. any remaining MINOR/NOTE items and whether any new BLOCKER/MAJOR exists.

Merge remains blocked unless verdict is `PASS` or `PASS_WITH_MINOR_FINDINGS` with zero BLOCKER/MAJOR findings.

## Handoff rule
Post `HANDOFF_TO_CHATGPT` directly in PR #1. Do not ask Nassim to relay findings.

## Round 4 architect-approved resolutions implemented by Codex

The canonical documents now incorporate all seven qualified findings from the latest `HANDOFF_TO_CODEX` against the real PR head:

- **CLAUDE-022:** guest-cookie `Max-Age` is the earlier of 24 hours or credential expiry; planned session end never shortens it, and delayed-session verification is required.
- **CLAUDE-023:** dual-boundary operations acquire doctor-global before clinic-local and retain both through commit, with deadlock-order verification.
- **TAB-FND-027-dispatch-recovery:** `dispatching` uses a persisted lease and monotonic attempt fence; expiry recovers to `unknown`, stale completions are rejected, and retries retain the logical provider key with a new token.
- **TAB-FND-028-secret-outbox:** exchange-link outbox secrets use short-lived envelope encryption with runtime/KMS key separation, worker-only decryption, TTL-bounded retries and ciphertext scrubbing.
- **TAB-FND-027-booking-queue-materialization:** booking confirmation atomically and idempotently creates the linked `waiting` row; check-in activates eligibility rather than creating it.
- **TAB-FND-028-effective-service-order:** eligible priority entries precede eligible normal entries; waiting entries never participate; call and ETA use exactly that total order.
- **TAB-FND-030-transfer-target-state:** source `waiting` maps to target `waiting`; source `checked_in|called` maps to target `checked_in` at a fresh target tail; priority/called status never silently carries.

No production feature code was started. Independent Claude re-review of the actual pushed SHA is required. Merge remains forbidden until Claude confirms zero BLOCKER/MAJOR findings.

## Round 5 routine reviewer fix — CLAUDE-025

The mirrored Appointment ↔ QueueEntry contract is now explicitly symmetric for advance cancellation: cancelling an appointment before check-in atomically cancels its linked `waiting` queue entry with the machine-readable `appointment_cancelled` cause. The two records share one transaction, so the entry cannot remain `waiting` for later no-show classification or block session closure.

Required PostgreSQL integration verification now includes booking confirmation followed by appointment cancellation before arrival, asserting that both records commit as `cancelled`, the queue entry records the appointment-cancellation cause, and no intermediate committed state leaves the entry `waiting`. Independent Claude re-review remains the merge gate; no production feature code has started.

## Round 6 routine reviewer fix — CLAUDE-026

Appointment cancellation-before-check-in and appointment-backed check-in now acquire the same queue/session mutation boundary for their linked pair and retain it through commit. From `Appointment=confirmed` + `QueueEntry=waiting`, the first valid committed transition wins; the loser re-reads committed state and returns conflict/invalid-transition, while an exact retry of the winner remains idempotent. Neither mismatched cancelled/checked-in pair may commit.

Required PostgreSQL integration verification now includes a barrier-controlled cancellation-versus-check-in race that forces both winner orders in separate runs, checks the synchronized pair and loser result, rejects either mismatched pair, and verifies an exact retry of each winner. Independent Claude re-review of the actual PR #8 head remains the merge gate; no production feature code has started.

## Round 8 architect-arbitrated fixes — TAB-FND-033/034/035

`HANDOFF_TO_CLAUDE` after Codex commits and pushes this round.

- **TAB-FND-033:** a durable guest bearer/verifier pair is created only in the transaction that validates and consumes a single-use exchange ID. Registration, resend and transfer persist only the target-bound exchange verifier and permitted encrypted delivery material. Transfer revokes old credentials/exchanges and creates no target bearer verifier. Exact consumed-link retries mint nothing and use the clean recovery/resend outcome. Normal and transfer issuance must prove the returned cookie works without recoverable bearer material in persistence or logs.
- **TAB-FND-034:** `closing` is removed from the canonical lifecycle and operation table. Normal close is a single serialized `open|paused -> closed` transaction that revalidates all active-entry preconditions and records final timestamp/audit metadata in the same commit. Exact retries are idempotent; close-versus-mutation races serialize and re-read committed state.
- **TAB-FND-035:** at most one session per doctor may be `open` globally, while `planned` and `paused` sessions may coexist. Open/resume and start-consultation operations acquire the applicable doctor-global boundary before the clinic/session boundary, revalidate after locking and hold both through commit. The required cross-clinic race matrix covers open/open, open/resume, paused-session consultation conflicts, permitted paused/no-consultation opening, rejected resume while another session is open, and start/start.

Canonical versions are Product v0.10, Architecture v0.15 and Security v0.6. Coordination records zero author-claimed open BLOCKER/MAJOR findings, but this is not acceptance: Claude must independently review the exact pushed SHA. If no BLOCKER/MAJOR remains, Claude must emit `MERGE_READY` + `HANDOFF_TO_CODEX`; Codex then applies the mechanical merge gates and immediately continues to pre-approved Issue #3 after merging PR #1 to `main`.
