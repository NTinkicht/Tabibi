# Tabibi Work Queue

This is the human-readable work marketplace. Live GitHub evidence is authoritative for transient PR/CI/review facts.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round - product delivery after Epic

Epic restructuring is **DONE**.

- PR #151 / `EPIC-CONTEXT-001` merged as `d935e5f72c74126f8b01e6a7688a3a96be7c0723`.
- PR #158 / `EPIC-ORG-002` + `EPIC-ACTORS-003` merged as `a7660d5581507f7f243d5ec7a8b18c18f59c98c4` after green exact-head CI and an eligible independent non-author PASS/MERGE_READY gate.
- Issues #154 and #155 are completed.
- WU25 deferred ordering/test hardening was completed in PR #152, merged as `27ab7b4e9499db2087f454f7a1f562129dddeaa8`.

The company is now back in normal product-delivery mode under Company OS v3. The next product action is to decompose the remaining Issue #6 scope into the smallest dependency-ready bounded work unit, then establish exactly one canonical implementation lease/branch/PR.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| EPIC-CONTEXT-001 | DONE | ChatGPT | Zero-extra-cost context router/capacity governor | PR #151 merged (`d935e5f…`) | Complete |
| EPIC-ORG-002 | DONE | ChatGPT | Spotify-inspired squads/chapters/guilds + deterministic six-actor routing | PR #158 merged (`a7660d5…`) | Complete |
| EPIC-ACTORS-003 | DONE | ChatGPT | Activate `gemini-cli` and `mistral-vibe` as zero-extra-spend actors | Activation evidence + PR #158 merged | Complete |
| WU25-FOLLOWUP-ORDER-001 | DONE | Codex | Expired-claim eligibility ordering hardening | PR #152 merged (`27ab7b4…`) | Complete |
| WU25-FOLLOWUP-TEST-001 | DONE | Copilot | Deterministic ordering regression coverage | PR #152 merged (`27ab7b4…`) | Complete |
| PRODUCT-CONTINUATION-001 | READY | Actor router | Reconcile remaining Issue #6 scope after WU25; define the next smallest dependency-ready bounded slice with deterministic acceptance/tests | One canonical issue/lease/branch/PR for the next product work unit | Yes, after explicit lease |
| HEADROOM-SHADOW-001 | READY | Copilot or other non-author test lane | Historical/non-sensitive fidelity samples under shadow rules | Metrics + fidelity findings | Read-only evaluation |

## Current actor status

- **ChatGPT:** AVAILABLE - orchestration/architecture/state reconciliation and bounded implementation when leased.
- **Codex:** AVAILABLE subject to included-plan capacity - preferred implementation/CI/mechanical merge; non-author review only when eligible.
- **Claude:** AVAILABLE subject to Claude Pro capacity - preferred independent adversarial review/gate when concretely available and non-author.
- **Copilot:** AVAILABLE subject to included education entitlement - QA/Test Automation and eligible non-author Code Review.
- **Gemini CLI (`gemini-cli`):** AVAILABLE - activation probe passed; scouting/research/long-context/QA/overflow review; free/non-billable allowance only.
- **Mistral Vibe (`mistral-vibe`):** AVAILABLE - activation probe passed; bounded coding/docs/design/QA/overflow review; existing subscription allowance only, PAYG forbidden.
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
- Retired Gemini Agent/Gemini Chat identities remain retired; `gemini-cli` is a distinct active actor.
