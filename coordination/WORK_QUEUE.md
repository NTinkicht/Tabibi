# Tabibi Work Queue

This is the human-readable work marketplace for available engineering capacity. It supplements `coordination/STATE.json`; live GitHub evidence is authoritative for transient PR/CI facts.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round — Company OS v2 before Epic resume

WU25 and its final hardening are complete. Product implementation is intentionally paused while PR #153 applies the pre-Epic company-operating cleanup: four-actor roster, simpler Slack/standup/retro behavior, mandatory specialist-overlay selection and a read-only Headroom shadow trial.

Epic PR #151 remains open but must not resume until #153 is merged and reconciled against the new `main`.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| COMPANY-OS-V2-001 | ACTIVE | ChatGPT | PR #153 governance/tooling change; no product feature work | Green exact-head CI + independent governance gate + merge | Coordination/tooling only |
| COMPANY-OS-V2-GATE | BLOCKED | Claude or Copilot Code Review, non-author only | Independent exact-head review of PR #153 after CI is green | PASS / PASS_WITH_MINOR_FINDINGS / CHANGES_REQUIRED, exact SHA | Review only |
| HEADROOM-SHADOW-001 | BLOCKED | Copilot or other non-author test lane | After #153 merge, run historical/non-sensitive Headroom fidelity samples under `coordination/HEADROOM_SHADOW_TRIAL.md` | Metrics + fidelity findings; no authoritative routing change | Read-only tooling/evaluation |
| EPIC-RESUME | BLOCKED | ChatGPT orchestrator | Rebase/reconcile PR #151 onto Company OS v2, then continue Spotify-inspired Epic | Updated canonical Epic branch/PR + fresh CI/review | After #153 only |

## Current actor status

- **ChatGPT:** ACTIVE — author/orchestrator for PR #153; recused from sole independent gating of its exact head.
- **Codex:** AVAILABLE SUBJECT TO INCLUDED PLAN CAPACITY — no duplicate work required while #153 is in review; preferred implementation/CI/mechanical merge when a bounded lease exists.
- **Claude:** AVAILABLE SUBJECT TO CLAUDE PRO CAPACITY — preferred independent adversarial/governance reviewer when concretely available and non-author.
- **Copilot:** AVAILABLE SUBJECT TO INCLUDED EDUCATION CREDITS — QA/Test Automation and eligible non-author Code Review; candidate Headroom shadow evaluator after #153.
- **CodeRabbit:** SUPPLEMENTAL ONLY unless an owner/work-unit policy explicitly promotes it for that exact work unit.
- **MicroReview:** SUPPLEMENTAL ONLY; free monthly quota may be exhausted and no paid upgrade is authorized.
- **Gemini Agent / Gemini Chat:** RETIRED — historical evidence only; no work, wake, review, capacity probe or lease.

## Binding delivery rules

- Exactly one canonical PR and one active implementer lease per work stream.
- Assignment is not progress: require repository-backed artifacts, CI/review evidence or a visible deterministic job.
- Required exact-head CI is binding.
- Final merge requires an eligible independent non-author exact-SHA gate under `AGENTS.md`.
- Reviewer independence and anti-duplication outrank keeping every model busy.
- Do not purchase API usage, review credits, overages or paid fallbacks to work around included-capacity limits.
- GitHub is authoritative; Slack is attention/culture only.
- Headroom remains shadow/read-only until Tabibi-specific fidelity evidence justifies graduation.
