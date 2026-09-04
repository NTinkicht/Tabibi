# ChatGPT Handoff

## Status
BLOCKED_ON_TAB_FND_021_ARCHITECTURE_UPDATE

## Scope
Foundation review only. No production implementation has started.

## Materials prepared
- PRODUCT.md — Algeria-first product model and MVP boundary
- AGENTS.md — multi-agent operating agreement
- ARCHITECTURE.md — proposed modular-monolith architecture and open questions
- SECURITY.md — security/privacy baseline
- coordination/STATE.json — durable agent state
- coordination/TAB-FND-021_RESOLUTION.md — accepted provider-dispatch boundary contract awaiting incorporation into ARCHITECTURE.md v0.10

## Independent Codex review history

### Round A — resolved
- TAB-FND-001 MAJOR — defined waiting vs checked-in call eligibility and estimator behavior.
- TAB-FND-002 MAJOR — defined safe session closure semantics.
- TAB-FND-003 MAJOR — separated public queue labels from secret guest credentials.
- TAB-FND-004 MINOR — added `called -> cancelled` and kept no-show distinct.

### Round B — resolved
- TAB-FND-005 MAJOR — removed late-arrival ambiguity using immutable `registration_order` plus transactional `eligibility_order` assigned at check-in.
- TAB-FND-006 MAJOR — defined whole-session cancellation transaction, authorization, dispositions, audit/outbox and concurrency behavior.
- TAB-FND-007 MINOR — standardized canonical persisted/API queue states as snake_case.

### Round C — resolved
- TAB-FND-008 MAJOR — `called` entries are explicitly committed work ahead in live ETA calculations until they enter consultation or terminate; active consultation remaining time replaces, rather than duplicates, that contribution.
- TAB-FND-009 MAJOR — unarrived `waiting` patients receive a clearly provisional arrival estimate/window with uncertainty; check-in atomically switches them to the live eligibility-order estimator.
- TAB-FND-010 MAJOR — added an explicit consultation-session state/operation matrix covering `planned`, `open`, `paused`, `closing`, `closed`, and `cancelled`, including deterministic boundary-race requirements.
- TAB-FND-011 MAJOR — raw guest bearer tokens are one-time issued and never persisted; only one-way verifiers are stored, with explicit rotation/revocation/expiry and negative authentication tests.

### Round D — resolved
- TAB-FND-012 MAJOR — added a hard one-doctor-session invariant of at most one `in_consultation` entry; start-consultation must re-check after session serialization, with sequential and concurrent PostgreSQL tests.
- TAB-FND-013 MAJOR — introduced a separate persisted `priority_order` override so waiting-entry priority/reorder never rewrites immutable registration history or prematurely assigns arrival order; its effect at check-in/call is deterministic and concurrency-tested.

### Round E — resolved
- TAB-FND-014 MAJOR — session opening is now an explicit serialized `planned -> open` operation with defined behavior from every lifecycle state, idempotent retry semantics, authorization/audit rules, and open-boundary race tests.
- TAB-FND-015 MAJOR — priority collisions now use one canonical policy: equal persisted `priority_order` values are forbidden. A priority mutation transactionally renumbers affected priority slots into a unique contiguous sequence; the committed sequence is authoritative for call selection and ETA, with collision/concurrency tests required.

### Round F — resolved
- TAB-FND-016 MAJOR — priority-slot bounds are now canonical. Slot requests are one-based integers; insertion into a cohort of size `N` permits `1..N+1`, moving an existing priority entry permits `1..N`, and all invalid/out-of-range requests are rejected rather than clamped or reinterpreted. Bounds are revalidated after acquiring the session serialization boundary, with explicit PostgreSQL tests for invalid and concurrent cases.

### Round G — resolved
- TAB-FND-017 MAJOR — defined the live priority cohort exactly as `waiting`/`checked_in` entries with non-null `priority_order`. Leaving that cohort via call/cancel/no-show atomically clears the live priority slot and renumbers the remaining cohort; historical priority context lives in audit/queue events, not terminal records. Session cancellation also clears all affected live priority slots. Added lifecycle/race/bounded-insertion test requirements.
- TAB-FND-018 MAJOR — added doctor-delay mutations to the lifecycle matrix. Declare/update/clear is allowed only in `planned`/`open`/`paused`, serialized with all session mutations, and atomically updates estimator state, audit data and idempotent outbox intents. Added delay-vs-pause/resume/close/cancel and estimator/outbox verification requirements.

### Round H — resolved
- TAB-FND-019 MAJOR — doctor-delay declare/update now accepts strictly positive finite values only. Zero is explicitly rejected and never aliases clear; `clear doctor delay` remains the only removal command. Added no-side-effect and retry/clear verification requirements.
- TAB-FND-020 MAJOR — mutable delay/recovery notifications now use monotonically versioned per-entry streams with transactional supersession. Clear/update makes older undelivered intents obsolete, session cancellation has terminal precedence, and workers must revalidate stream head/current terminal state immediately before provider dispatch. Added stale/retry/clear/cancel race tests and provider idempotency requirements.

### Round I — accepted, architecture update pending
- TAB-FND-021 MAJOR — final database revalidation alone cannot guarantee suppression across the external provider-call boundary. The canonical resolution is persisted provider delivery state (`pending -> dispatching -> delivered|failed|unknown`, plus `skipped_obsolete`), transactional current-state revalidation immediately before committing `dispatching`, and an explicit bounded-race rule: once provider invocation has begun, that attempt is irrevocable/in-flight; later newer/terminal state supersedes only not-yet-started intents and must remain deliverable afterward. Stable provider idempotency keys cover retry-after-unknown-result but do not order versions.
- Required barrier tests: mutation before dispatch boundary suppresses the provider call; mutation after provider invocation starts may allow the old call to finish but leaves the newer/terminal intent deliverable; unknown-result retry reuses the same logical idempotency key; cancellation suppresses all older not-yet-started mutable intents; crash-window behavior around `dispatching` is explicit.
- The accepted contract is durably recorded in `coordination/TAB-FND-021_RESOLUTION.md`.
- `ARCHITECTURE.md` is still v0.9 and must be updated to v0.10 before this finding is marked resolved and Claude foundation review resumes.

Claude must independently validate all resolved findings and TAB-FND-021 after the architecture update rather than assuming Codex was correct.

## Review request after TAB-FND-021 is committed
Claude should independently challenge:
1. product assumptions and missing requirements likely to cause expensive rework;
2. architecture suitability for live queue/concurrency behavior;
3. privacy/security model, especially patient/guest access and cross-clinic isolation;
4. queue and session state-machine completeness;
5. estimator semantics for waiting, checked-in, called and in-consultation states;
6. notification/outbox separation, especially provider-dispatch boundaries, version ordering, bounded stale-message races and terminal precedence;
7. MVP boundary and whether anything critical is missing or prematurely included;
8. testing strategy required before implementation;
9. all Codex resolutions above, especially the TAB-FND-021 persisted `dispatching` boundary and unknown-result semantics.

Do not treat proposed technology choices as settled. Identify blocking decisions separately from optional recommendations.

Record findings durably in `coordination/CLAUDE_REVIEW.md` on a Claude branch and/or in the foundation PR review.

Verdict must be one of:
- PASS
- PASS_WITH_MINOR_FINDINGS
- CHANGES_REQUIRED

If there are BLOCKER/MAJOR findings, include concrete required resolutions and verification criteria.

## Handoff rule
Do not ask Nassim to relay findings to ChatGPT. Put them in GitHub. ChatGPT will read and respond there.
