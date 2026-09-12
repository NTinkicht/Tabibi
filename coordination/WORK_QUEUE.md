# Tabibi Work Queue

This is the human-readable work marketplace. Live GitHub evidence is authoritative for transient PR/CI/review facts.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round - Epic six-actor Company OS

PR #151 / `EPIC-CONTEXT-001` is **DONE**, merged as `d935e5f72c74126f8b01e6a7688a3a96be7c0723` after green exact-head CI and Claude's independent PASS/MERGE_READY gate.

The canonical active implementation stream is PR #158 on `epic/six-actor-capacity-routing`, combining `EPIC-ORG-002` (#154) and `EPIC-ACTORS-003` (#155). No competing implementation branch is authorized.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| EPIC-CONTEXT-001 | DONE | ChatGPT | Zero-extra-cost context router/capacity governor | PR #151 merged (`d935e5f…`) | Complete |
| EPIC-ORG-002 | ACTIVE | ChatGPT | Spotify-inspired squads/chapters/guilds + deterministic six-actor routing | PR #158, green exact-head CI, independent non-author gate, merge | Governance/tooling/tests |
| EPIC-ACTORS-003 | ACTIVE | ChatGPT | Activate `gemini-cli` and `mistral-vibe` as zero-extra-spend actors | Activation evidence + PR #158 integration | Governance/tooling/tests |
| HEADROOM-SHADOW-001 | READY | Copilot or other non-author test lane | Historical/non-sensitive fidelity samples under shadow rules | Metrics + fidelity findings | Read-only evaluation |
| WU25-FOLLOWUP-ORDER-001 | READY | Codex | Refine expired-claim eligibility ordering | Focused future notification-hardening patch + PostgreSQL regression | Explicit lease only |
| WU25-FOLLOWUP-TEST-001 | READY | Copilot | Strengthen deterministic ordering coverage | Test-only future notification-hardening regression | Explicit lease only |

## Current actor status

- **ChatGPT:** ACTIVE - orchestrator/material author for PR #158; recused from sole exact-head gate.
- **Codex:** AVAILABLE subject to included-plan capacity - preferred implementation/CI/mechanical merge; do not duplicate #158.
- **Claude:** AVAILABLE subject to Claude Pro capacity - preferred independent adversarial gate when concretely available/non-author.
- **Copilot:** AVAILABLE subject to included education entitlement - QA/Test Automation and eligible non-author Code Review.
- **Gemini CLI (`gemini-cli`):** AVAILABLE - harmless activation probe passed; scouting/research/long-context/QA/overflow review; free/non-billable local allowance only.
- **Mistral Vibe (`mistral-vibe`):** AVAILABLE - harmless activation probe passed and workspace remained clean; existing Pro subscription only, PAYG forbidden.
- **CodeRabbit:** SUPPLEMENTAL reviewer source; material findings still require reconciliation.
- **Gemini Agent / Gemini Chat:** RETIRED historical identities - never route/wake/probe/lease.

## Binding delivery rules

- Exactly one canonical PR and one active implementer per work stream.
- Required exact-head CI is binding.
- Final merge requires an eligible independent non-author exact-SHA gate.
- All reviewer sources are inspected; unresolved BLOCKER/MAJOR/Medium+/High+/Critical findings prevent merge.
- Actor selection uses `coordination/ACTOR_REGISTRY.json` plus live capability/authorship evidence.
- Paid Gemini/Vertex routes, Mistral PAYG, OpenRouter, paid API credits, Copilot overage and other paid fallback are forbidden by `AI_CAPACITY_POLICY.md`.
- GitHub is authoritative; Slack is attention/culture only.
