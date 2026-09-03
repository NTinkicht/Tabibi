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

## Independent Codex review already resolved
Codex reviewed the initial foundation and raised four findings. ChatGPT accepted all four and updated the specification/architecture before Claude's independent review:

- TAB-FND-001 MAJOR — unarrived entries and call eligibility were ambiguous. Resolved by explicitly defining `waiting` as not call-eligible, `checked_in` as eligible, preventing unarrived entries from blocking arrived patients, and defining estimate behavior plus required concurrency/state-machine tests.
- TAB-FND-002 MAJOR — session closing behavior with active entries was undefined. Resolved by defining session lifecycle/normal close preconditions, atomic close semantics, deterministic handling of concurrent close operations, and deferring force-close from MVP.
- TAB-FND-003 MAJOR — public display labels could be confused with guest bearer credentials. Resolved by requiring distinct fields/security semantics and tests proving public labels never authorize guest access.
- TAB-FND-004 MINOR — `called -> cancelled` was missing. Resolved by explicitly allowing cancellation before consultation begins and keeping `no_show` semantically distinct.

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
8. the four Codex resolutions above, including whether they introduce new edge cases.

Do not treat proposed technology choices as settled. Identify blocking decisions separately from optional recommendations.

Record findings durably in `coordination/CLAUDE_REVIEW.md` on a Claude branch and/or in the foundation PR review.

Verdict must be one of:
- PASS
- PASS_WITH_MINOR_FINDINGS
- CHANGES_REQUIRED

If there are BLOCKER/MAJOR findings, include concrete required resolutions and verification criteria.

## Handoff rule
Do not ask Nassim to relay findings to ChatGPT. Put them in GitHub. ChatGPT will read and respond there.
