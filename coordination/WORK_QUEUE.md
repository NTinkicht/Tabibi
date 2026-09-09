# Tabibi Work Queue

This is the human-readable work marketplace for available engineering capacity. It supplements `coordination/STATE.json`; live GitHub evidence is authoritative for transient PR/CI facts, while committed binding protocols govern role and merge policy.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round — post-WU12 reconciliation

WU12 / Issue #113 / PR #114 is merged and complete. PR #115 is the canonical coordination-only reconciliation PR; there is no active product implementation lease.

The previous WU9/WU10 coordination entries are stale and retired. Do not resurrect their implementation leases.

The immediate canonical work is bounded architecture/backlog reconciliation against current `main`: select the smallest dependency-ready slice after appointment lifecycle synchronization, create its issue/acceptance contract, and only then assign one implementation lease.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| POST-WU12-ARCH-001 | ACTIVE | chatgpt | Reconcile current main, epics and dependencies; define next smallest bounded product work unit | New issue with explicit scope/exclusions/acceptance | No application edits |
| POST-WU12-IMPLEMENT-001 | BLOCKED | unassigned | Implement the next work unit after architecture contract exists | One canonical branch/PR + tests | Yes, after explicit lease only |
| POST-WU12-GATE-001 | BLOCKED | eligible non-author reviewer | Binding exact-head gate under `AGENTS.md`; prefer Claude, Codex, or Copilot Code Review when eligible and concretely available | PASS / PASS_WITH_MINOR_FINDINGS on exact head; no unresolved BLOCKER/MAJOR | Review only |
| POST-WU12-MERGE-001 | BLOCKED | codex | Mechanical merge after unchanged exact head satisfies `AUTONOMY_PROTOCOL.md`; ChatGPT may execute only as explicit merge-execution failover when Codex is concretely unavailable | Merge + state reconciliation | Merge only |

## Current actor status

- **ChatGPT:** ACTIVE — CTO/orchestrator and state reconciler. Owns POST-WU12-ARCH-001; no product-code lease.
- **Copilot:** AVAILABLE/UNASSIGNED — primary QA/Test Automation and eligible independent gate only on a non-authored exact head under `AGENTS.md`.
- **Codex:** CAPABILITY-CONDITIONAL/UNASSIGNED — preferred production/CI/mechanical merge actor when concrete capacity is observed; do not spam repeated probes after a demonstrated limit.
- **Claude:** CAPABILITY-CONDITIONAL/UNASSIGNED — principal architecture/security/adversarial reviewer and preferred independent gate when eligible and concretely available.
- **CodeRabbit:** SUPPLEMENTAL REVIEW SIGNAL — useful for findings and full-PR re-evaluation, but not a binding gate under the exhaustive `AGENTS.md` independent-review list.
- **Gemini Agent:** PAUSED/OFF-ROSTER by owner decision.
- **Gemini Chat:** PAUSED/OFF-ROSTER by owner decision.

## Binding delivery rules

- Exactly one canonical PR and one active implementer lease per work stream.
- An assignment is not evidence of progress: require heartbeat/checkpoint, commit, PR, CI, review artifact, or a visibly running deterministic job.
- A claimed active lease without observable progress for 30 minutes is stale unless a deterministic job is visibly progressing.
- Binding review eligibility comes from `AGENTS.md`: Claude, ChatGPT, Codex, Copilot Code Review, Gemini Chat, or Gemini Agent only when that actor did not author/materially modify the exact reviewed head; paused actors remain ineligible operationally until re-enabled.
- Merge gates and mechanical merge ownership come from `coordination/AUTONOMY_PROTOCOL.md`. Required deterministic checks must pass; preserve any explicit protocol exception rather than redefining a stricter or weaker rule here.
- CodeRabbit may identify or clear supplemental findings but does not replace the required eligible non-author verdict.
- Gemini Agent and Gemini Chat remain paused until the owner explicitly re-enables them.
