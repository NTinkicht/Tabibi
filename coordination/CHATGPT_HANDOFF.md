# ChatGPT Handoff

## Status
READY_FOR_CLAUDE_FOUNDATION_REVIEW_ROUND_1

## Scope
Foundation review only. No production implementation has started.

## Materials prepared
- PRODUCT.md — Algeria-first product model and MVP boundary
- AGENTS.md — multi-agent operating agreement
- ARCHITECTURE.md — proposed modular-monolith architecture and open questions
- SECURITY.md — security/privacy baseline
- coordination/STATE.json — durable agent state

## Independent Codex review history

### Round A — resolved
- TAB-FND-001 MAJOR — defined waiting vs checked-in call eligibility and estimator behavior.
- TAB-FND-002 MAJOR — defined safe session closure semantics.
- TAB-FND-003 MAJOR — separated public queue labels from secret guest credentials.
- TAB-FND-004 MINOR — added `called -> cancelled` and kept no-show distinct.

### Round B — resolved
- TAB-FND-005 MAJOR — removed late-arrival ambiguity. Queue entries now keep immutable `registration_order` for audit, while normal service uses `eligibility_order` assigned transactionally at `waiting -> checked_in`. A late arrival joins behind the current normal checked-in cohort and cannot overtake patients who were already present unless an explicit authorized priority override applies. Concurrent check-in/call behavior must be covered by PostgreSQL tests.
- TAB-FND-006 MAJOR — defined whole-session cancellation. Cancellation requires authorization/reason, is rejected while an entry is `in_consultation`, serializes against queue mutation, atomically moves remaining `waiting`/`checked_in`/`called` entries to `cancelled`, terminates estimates, writes audit records and durable `session_cancelled` notification intents, and requires concurrency tests.
- TAB-FND-007 MINOR — standardized canonical persisted/API queue states as snake_case: `waiting`, `checked_in`, `called`, `in_consultation`, `completed`, `cancelled`, `no_show`.

Claude must independently validate these resolutions rather than assuming Codex was correct.

## Review request
Claude should independently challenge:
1. product assumptions and missing requirements likely to cause expensive rework;
2. architecture suitability for live queue/concurrency behavior;
3. privacy/security model, especially patient/guest access and cross-clinic isolation;
4. queue state-machine completeness;
5. notification/outbox separation;
6. MVP boundary and whether anything critical is missing or prematurely included;
7. testing strategy required before implementation;
8. all Codex resolutions above, especially whether the dual-order model or session-cancellation transaction introduces new edge cases.

Do not treat proposed technology choices as settled. Identify blocking decisions separately from optional recommendations.

Record findings durably in `coordination/CLAUDE_REVIEW.md` on a Claude branch and/or in the foundation PR review.

Verdict must be one of:
- PASS
- PASS_WITH_MINOR_FINDINGS
- CHANGES_REQUIRED

If there are BLOCKER/MAJOR findings, include concrete required resolutions and verification criteria.

## Handoff rule
Do not ask Nassim to relay findings to ChatGPT. Put them in GitHub. ChatGPT will read and respond there.
