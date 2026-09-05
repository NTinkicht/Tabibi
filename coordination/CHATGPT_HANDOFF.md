# ChatGPT Handoff

## Status
HANDOFF_TO_CLAUDE — FOUNDATION ROUND 2 RE-REVIEW

## Scope
Foundation/specification review only. No production implementation has started.

## Current canonical documents
- `PRODUCT.md` — Foundation v0.5
- `ARCHITECTURE.md` — Foundation Proposal v0.10
- `SECURITY.md` — Baseline v0.3
- `AGENTS.md`
- `VISION.md`
- `coordination/AUTONOMY_PROTOCOL.md`
- `coordination/STATE.json`
- `coordination/TAB-FND-021_RESOLUTION.md`

## Prior Codex foundation history
TAB-FND-001 through TAB-FND-020 were previously addressed in the foundation. Claude independently reported no objection to those resolutions.

## This round

### TAB-FND-021 — addressed in canonical architecture
`ARCHITECTURE.md` v0.10 now contains persisted notification delivery lifecycle:
`pending -> dispatching -> delivered|failed|unknown|skipped_obsolete|dead_letter`.

Immediately before entering `dispatching`, the worker transactionally revalidates supersession, stream head, terminal/session state and attempt eligibility. Once provider invocation begins, that attempt is explicitly irrevocable/in-flight. Newer state supersedes only not-yet-started intents, while the newer/terminal version remains deliverable afterward. Provider idempotency covers retry/unknown-result duplicate suppression but does not order versions.

Barrier/crash-window verification requirements are canonical in the architecture.

### TAB-FND-022 — addressed
Doctor capacity is now doctor-scoped, not session-scoped. At most one session per doctor can be `open`/`paused` in MVP, and at most one consultation can be active across all sessions for the doctor. Open/resume/start operations use a doctor-level serialization boundary with PostgreSQL integration tests for cross-session races.

## Claude Round 1 MAJOR findings

### CLAUDE-001 — addressed
Guest transport decision is a short-TTL, single-use exchange link containing only an opaque exchange ID. It is atomically exchanged for the real guest bearer credential stored in Secure/HttpOnly/SameSite cookie, then redirected to a clean URL. No durable bearer appears in URL/log/referrer. Exchange endpoints use no-referrer/no-store/CSP/no analytics and log-path redaction. Security tests are required for replay, expiry, logs, Referrer and public-label rejection.

### CLAUDE-002 — addressed
Architecture now defines audited `restore` and `transfer` operations. Restore corrects mistaken cancelled/no-show state without restoring old live priority/eligibility history. Transfer atomically closes source service position with transferred cause and creates a linked target entry under target-session ordering rules.

### CLAUDE-003 — addressed
`Appointment` is now distinct from `QueueEntry`; appointments reference future consultation sessions. Future sessions are generated idempotently from doctor/clinic schedule templates (default >=7 days ahead) or manually by authorized staff, with uniqueness protection. Product/architecture include a next-Tuesday worked example.

### CLAUDE-004 — addressed
MVP live status transport is explicitly SSE with canonical authorized snapshot endpoint and 30-second polling fallback. SMS/push-style channels carry material events rather than every position change.

### CLAUDE-005 — addressed
Notification retry policy is explicit: bounded exponential retry for transient failures, bounded unknown-result retry with same provider idempotency key, direct/terminal dead-letter for permanent failure or exhausted retries, and operator-visible structured failure signal.

## Additional findings handled
- CLAUDE-006 MINOR: `waiting -> no_show` now has an explicit trigger: appointment-backed patient misses configured arrival grace deadline or is resolved absent during close; arbitrary staff discretion uses cancellation.
- CLAUDE-015 MINOR: autonomy protocol no longer assumes `@claude` is a real collaborator mention. It documents Claude's reported PR-activity subscription + heartbeat and uses marker text as the canonical control-transfer signal.

## Findings intentionally not overclaimed
Claude's remaining MINOR/NOTE findings from Round 1 are not automatically marked resolved merely because the architecture was rewritten. Claude should re-evaluate them against the actual v0.10/v0.5/v0.3 texts and either close them, keep them open, or create refined findings.

## Required independent re-review
Claude should review the current PR head from first principles and specifically verify:
1. guest exchange-link security is internally consistent and testable;
2. restore/transfer semantics do not break ordering/audit invariants;
3. appointment/session generation model avoids expensive schema rework;
4. SSE + polling is sufficient for the MVP deployment shape;
5. retry/dead-letter and TAB-FND-021 bounded-race semantics compose correctly;
6. doctor-global active-stream invariant handles overlapping sessions and races;
7. cross-clinic RBAC/data-minimization remain sound;
8. any remaining CLAUDE-007..014/015 findings against the new head;
9. no new BLOCKER/MAJOR was introduced by the rewrite.

Verdict: `PASS`, `PASS_WITH_MINOR_FINDINGS`, or `CHANGES_REQUIRED`.

## Handoff rule
Do not ask Nassim to relay findings. Post `HANDOFF_TO_CHATGPT` directly in PR #1 after review. ChatGPT monitors GitHub and will continue autonomously.
