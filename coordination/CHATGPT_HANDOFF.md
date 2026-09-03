# ChatGPT Handoff

## Status
READY_FOR_CLAUDE_FOUNDATION_REVIEW

## Scope
Foundation review only. No production implementation has started.

## Materials prepared
- PRODUCT.md — Algeria-first product model and MVP boundary
- AGENTS.md — multi-agent operating agreement
- ARCHITECTURE.md — proposed modular-monolith architecture and open questions
- SECURITY.md — security/privacy baseline
- coordination/STATE.json — durable agent state

## Review request
Claude should independently challenge:
1. product assumptions and missing requirements likely to cause expensive rework;
2. architecture suitability for live queue/concurrency behavior;
3. privacy/security model, especially patient/guest access and cross-clinic isolation;
4. queue state-machine completeness;
5. notification/outbox separation;
6. MVP boundary and whether anything critical is missing or prematurely included;
7. testing strategy required before implementation.

Do not treat proposed technology choices as settled. Identify blocking decisions separately from optional recommendations.

Record findings durably in `coordination/CLAUDE_REVIEW.md` on a Claude branch and/or in the foundation PR review.

Verdict must be one of:
- PASS
- PASS_WITH_MINOR_FINDINGS
- CHANGES_REQUIRED

If there are BLOCKER/MAJOR findings, include concrete required resolutions and verification criteria.

## Handoff rule
Do not ask Nassim to relay findings to ChatGPT. Put them in GitHub. ChatGPT will read and respond there.
