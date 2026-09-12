# Tabibi Work Queue

This is the human-readable work marketplace for available engineering capacity. It supplements `coordination/STATE.json`; live GitHub evidence is authoritative for transient PR/CI facts.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round - Epic resumed on Company OS v2

PR #153 / Company OS v2 is merged. Epic is resumed through canonical PR #151, reconciled onto the four-actor operating model and the Headroom shadow boundary.

The current slice installs the zero-extra-cost capacity governor and context shunt: deterministic retrieval first, verified local Headroom shadow when suitable, optional budgeted Copilot/Luna only when explicitly enabled, then strong subscribed actors. No new paid provider/overage path is permitted.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| EPIC-CONTEXT-001 | ACTIVE | ChatGPT | Reconciled PR #151: context router, capacity governor, Headroom-before-Copilot shunt, read guard, safety/concurrency tests | Green exact-head CI + no unresolved Medium+/Major findings + eligible non-author gate + merge | Infra/docs/tests only |
| EPIC-CONTEXT-GATE-001 | BLOCKED | Claude or Copilot Code Review, non-author | Independent exact-head security/governance/concurrency review after CI | PASS / PASS_WITH_MINOR_FINDINGS / CHANGES_REQUIRED and MERGE_READY when appropriate | Review only |
| HEADROOM-SHADOW-001 | READY | Copilot or other non-author test lane | Run historical/non-sensitive fidelity samples under `coordination/HEADROOM_SHADOW_TRIAL.md` without changing authority | Metrics + fidelity findings | Read-only tooling/evaluation |
| EPIC-ORG-002 | BLOCKED | ChatGPT orchestrator | Continue Spotify-inspired organization/capacity routing after PR #151 merges | Next bounded Epic work unit/PR | After PR #151 |
| WU25-FOLLOWUP-ORDER-001 | READY | Codex | Refine expired-claim eligibility ordering to use claim expiry as eligibility timestamp | Focused patch + PostgreSQL regression in a future notification hardening WU | Explicit product lease only |
| WU25-FOLLOWUP-TEST-001 | READY | Copilot | Strengthen deterministic ordering coverage with equal eligibility/creation timestamps | Test-only regression/design in future notification hardening WU | Explicit lease only |

## Current actor status

- **ChatGPT:** ACTIVE - Epic PR #151 reconciler/implementer; recused from sole exact-head gate.
- **Codex:** AVAILABLE SUBJECT TO INCLUDED PLAN CAPACITY - preferred implementation/CI/mechanical merge; do not duplicate #151.
- **Claude:** AVAILABLE SUBJECT TO CLAUDE PRO CAPACITY - preferred independent adversarial gate when concretely available/non-author.
- **Copilot:** AVAILABLE SUBJECT TO INCLUDED EDUCATION ENTITLEMENT - QA/Test Automation and eligible non-author Code Review; optional Luna compression remains OFF by default.
- **CodeRabbit:** SUPPLEMENTAL reviewer source; Medium+/Major findings must still be reconciled.
- **Gemini Agent / Gemini Chat:** RETIRED - historical evidence only; no work, wake, probe, review, or lease.

## Binding delivery rules

- Exactly one canonical PR and one active implementer lease per work stream.
- Assignment/heartbeat is not progress; require repository artifacts, CI/review evidence, or a visible deterministic job.
- Required exact-head CI is binding.
- Final merge requires an eligible independent non-author exact-SHA gate.
- All reviewer sources must be inspected; unresolved Medium+/Major+/High+/Critical/Blocker findings prevent merge.
- Additional paid AI/API usage, Copilot overage, and paid fallback are forbidden by `coordination/AI_CAPACITY_POLICY.md`.
- Deterministic retrieval precedes Headroom shadow; Headroom precedes optional Copilot/Luna where suitable; compressed output never becomes authority.
- GitHub is authoritative; Slack is attention/culture only.
