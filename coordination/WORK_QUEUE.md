# Tabibi Work Queue

This is the human-readable work marketplace for available engineering capacity. It supplements `coordination/STATE.json`; live GitHub evidence is authoritative for transient PR/CI facts.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round - post-WU25 infrastructure efficiency rollout

WU25 / Issue #148 / PR #149 is merged and complete. Final reviewed exact head `99d3cfebfe7655321b6aa2fdab07e8d21d5422e5` passed CI #687 / run `34623450232`; PR #149 merged to main as `9fe303f11aeb14f443660b185fae8d053032ffb7`.

The prior CodeRabbit Major on expired claimed-retry recovery was fixed, regression-covered and resolved. The final exact-head whole-PR review produced two MINOR findings only; both were explicitly deferred with rationale and are preserved below as follow-up work rather than being lost.

Owner-directed Issue #150 is now the canonical infrastructure/process stream: zero-extra-cost AI capacity governance plus deterministic-first context routing. This stream must not start a product WU in parallel merely to keep actors busy.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| INFRA-CONTEXT-001 | ACTIVE | ChatGPT | Implement Issue #150 on one canonical infrastructure branch/PR: budget governor, deterministic-first router, compact bootstrap, Claude read guard, safe optional Copilot/Luna path | Reviewed PR with green CI and no new paid-provider dependency | Infra/docs only |
| INFRA-CONTEXT-GATE-001 | BLOCKED | Claude or Copilot Code Review, non-author | Independent exact-head review of the context-router/governance change, including fail-closed budget behavior and governance preservation | PASS / PASS_WITH_MINOR_FINDINGS / MERGE_READY or concrete findings | Review only |
| WU25-FOLLOWUP-ORDER-001 | READY | Codex | Refine expired-claim eligibility ordering to use claim expiry as the eligibility timestamp so older creation time cannot unfairly consume a bounded batch ahead of an earlier-due retry | Focused production patch + PostgreSQL regression, in the next appropriate notification-dispatch hardening WU | Yes, only under a future explicit product lease |
| WU25-FOLLOWUP-TEST-001 | READY | Copilot | Strengthen deterministic ordering coverage with actual equal eligibility/creation timestamps so both persisted tie-breakers are proven | Test-only regression or test design attached to the next appropriate notification-dispatch hardening WU | Test-only under explicit lease |
| POST-WU13-GOV-001 | READY | ChatGPT | Evaluate whether MicroReview should ever become a permanent supplemental/conditional gate. WU13's substitution remains PR-scoped and must not silently generalize. | Separate governance decision/issue if still useful | No product edits |

## Current actor status

- **ChatGPT:** ACTIVE - owner-directed Issue #150 implementation/orchestration; author of the infra exact head and therefore ineligible to self-gate it.
- **Codex:** AVAILABLE subject to current included-plan capacity; reserve primarily for implementation/CI rather than bulk repository reading.
- **Claude:** preferred non-author adversarial/security/governance gate when current Claude Pro capacity is concretely available.
- **Copilot:** AVAILABLE for QA/test automation and eligible exact-head Code Review when non-author; optional Luna compression is infrastructure-only, disabled by default and governed by `AI_CAPACITY_POLICY.md`.
- **Gemini Agent:** PAUSED/OFF-ROSTER by owner decision.
- **Gemini Chat:** PAUSED/OFF-ROSTER by owner decision.

## Binding delivery rules

- Exactly one canonical PR and one active implementer lease per work stream.
- Assignment/heartbeat is not progress; require repository artifacts, CI, review evidence or a visibly running deterministic job.
- Required exact-head CI is binding.
- Final merge requires an eligible independent non-author exact-head gate.
- Every Medium+/Major+/High+/Critical/Blocker finding from every participating reviewer must be fixed or concretely adjudicated; Minor/Low/Note findings may be explicitly deferred with rationale when non-blocking.
- Additional paid AI/API usage is forbidden by `coordination/AI_CAPACITY_POLICY.md`.
- Deterministic repository retrieval precedes model compression; optional Copilot/Luna compression is disabled by default and has no authority.
- Gemini Agent and Gemini Chat remain paused until explicit owner reactivation.
