# Tabibi Work Queue

This is the human-readable work marketplace for available engineering capacity. It supplements `coordination/STATE.json`; live GitHub evidence is authoritative for transient PR/CI facts, while committed binding protocols govern reviewer eligibility, merge gates, and role ownership.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round — post-WU12 reconciliation

WU12 / Issue #113 / PR #114 is merged and complete. PR #115 merged the post-WU12 coordination checkpoint, but Issue #116 / its corrective PR is now the canonical coordination stream because the merged queue incorrectly promoted CodeRabbit to a binding gate and ChatGPT to the default merge executor. There is no active product implementation lease while this correction is in flight.

The previous WU9/WU10 coordination entries are stale and retired. Do not resurrect their implementation leases.

The immediate product-facing work remains bounded architecture/backlog reconciliation against current `main`: select the smallest dependency-ready slice after appointment lifecycle synchronization, create its issue/acceptance contract, and only then assign exactly one implementation lease.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| POST-WU12-POLICY-FIX | ACTIVE | chatgpt | Restore coordination policy to binding `AGENTS.md` and `AUTONOMY_PROTOCOL.md` after PR #115 | Issue #116 + one coordination-only corrective PR + exact-head CI/gate | Coordination only |
| POST-WU12-ARCH-001 | READY | chatgpt | Reconcile current main, epics and dependencies; define next smallest bounded product work unit immediately after the corrective PR merges | New issue with explicit scope/exclusions/acceptance | No application edits |
| POST-WU12-IMPLEMENT-001 | BLOCKED | codex | Implement the next work unit after architecture contract exists; Codex has owner-confirmed current capacity | One canonical branch/PR + tests | Yes, after explicit lease only |
| POST-WU12-GATE-001 | BLOCKED | eligible non-author reviewer | Binding exact-head gate under `AGENTS.md`; prefer Claude, Codex, or Copilot Code Review when eligible and concretely available | `PASS` or `PASS_WITH_MINOR_FINDINGS` on the exact head, with no unresolved BLOCKER/MAJOR | Review only |
| POST-WU12-MERGE-001 | BLOCKED | codex | Mechanical merge after unchanged exact head satisfies `AUTONOMY_PROTOCOL.md`; ChatGPT may execute only as explicit safe merge-execution failover when Codex is concretely unavailable | Merge + state reconciliation | Merge only |

## Current actor status

- **ChatGPT:** ACTIVE — CTO/orchestrator and state reconciler. Owns the coordination corrective and subsequent architecture selection; no product-code lease.
- **Copilot:** AVAILABLE/UNASSIGNED — primary QA/Test Automation and bounded implementation/integration when explicitly leased. Eligible as a binding reviewer only through explicit Copilot Code Review on an exact non-authored head under `AGENTS.md`.
- **Codex:** AVAILABLE/UNASSIGNED — owner confirmed current capacity. Preferred production/CI/mechanical merge actor and preferred implementer for the next product work unit once its contract is opened.
- **Claude:** CAPABILITY-CONDITIONAL/UNASSIGNED — principal architecture/security/adversarial reviewer and preferred independent gate when eligible and concretely available.
- **CodeRabbit:** SUPPLEMENTAL REVIEW SIGNAL — useful for findings and full-PR re-evaluation, but not a binding gate under the exhaustive `AGENTS.md` independent-review list.
- **Gemini Agent:** PROBATION FAILED/PAUSED — the single owner-authorized read-only capacity probe produced no qualifying `CAPACITY_RECOVERED` artifact. No implementation, review-gate, or wake authority. A successful probe would have demonstrated runtime capacity only; permanent reactivation always requires a later explicit owner decision by Nassim.
- **Gemini Chat:** PROBATION FAILED/PAUSED — the single owner-authorized read-only capacity probe produced no qualifying `CAPACITY_RECOVERED` artifact. No implementation, review-gate, or wake authority. A successful probe would have demonstrated runtime capacity only; permanent reactivation always requires a later explicit owner decision by Nassim.

## Binding delivery rules

- Exactly one canonical PR and one active implementer lease per work stream.
- An assignment is not evidence of progress: require heartbeat/checkpoint, commit, PR, CI, review artifact, or a visibly running deterministic job.
- A claimed active lease without observable progress for 30 minutes is stale unless a deterministic job is visibly progressing.
- Binding review eligibility comes from `AGENTS.md`: Claude, ChatGPT, Codex, Copilot Code Review, Gemini Chat, or Gemini Agent only when that actor did not author/materially modify the exact reviewed head. Operationally paused actors cannot be selected until Nassim explicitly reactivates that actor; a capacity probe alone never grants normal work or gating authority.
- Merge gates and mechanical merge ownership come from `coordination/AUTONOMY_PROTOCOL.md`. Required deterministic checks must pass, and any explicit protocol exception remains authoritative.
- CodeRabbit may identify or clear supplemental findings but does not replace the required eligible non-author verdict.
- Codex is the preferred mechanical merge executor when concretely available; ChatGPT may perform the same expected-head mechanical merge only as a transparent failover after all binding gates already pass.
- Gemini Agent and Gemini Chat are paused again after their one unsuccessful probationary wake. Do not probe or assign them again unless Nassim explicitly re-enables the relevant actor.
