# Tabibi Work Queue

This is the human-readable work marketplace for available engineering capacity. It supplements `coordination/STATE.json`; live GitHub evidence is authoritative for transient PR/CI facts.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round — post-WU12 reconciliation

WU12 / Issue #113 / PR #114 is merged and complete. PR #115 is the canonical coordination-only reconciliation PR; there is no active product implementation lease.

The previous WU9/WU10 coordination entries are stale and retired. Do not resurrect their implementation leases.

The immediate canonical work is bounded architecture/backlog reconciliation against current `main`: select the smallest dependency-ready slice after appointment lifecycle synchronization, create its issue/acceptance contract, and only then assign one implementation lease.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| POST-WU12-ARCH-001 | ACTIVE | chatgpt | Reconcile current main, epics and dependencies; define next smallest bounded product work unit | New issue with explicit scope/exclusions/acceptance | No application edits |
| POST-WU12-IMPLEMENT-001 | BLOCKED | unassigned | Implement the next work unit after architecture contract exists | One canonical branch/PR + tests | Yes, after explicit lease only |
| POST-WU12-GATE-001 | BLOCKED | CodeRabbit | Binding independent exact-head gate while Codex and Claude are unavailable or limited | Full review on exact head; no unresolved BLOCKER/MAJOR | Review only |
| POST-WU12-MERGE-001 | BLOCKED | chatgpt | Mechanical expected-head merge only after unchanged exact head has green required CI and the binding CodeRabbit gate is clean | Merge + state reconciliation | Merge only |

## Current actor status

- **ChatGPT:** ACTIVE — CTO/orchestrator and state reconciler. Owns POST-WU12-ARCH-001; no product-code lease.
- **Copilot:** AVAILABLE/UNASSIGNED — primary QA/Test Automation and bounded implementation/integration when explicitly leased. No current product or gate lease.
- **Codex:** LIMITED/UNASSIGNED — no current lease; do not depend on implementation, review, or merge capacity until concrete recovery evidence appears.
- **Claude:** LIMITED/UNASSIGNED — no current lease; optional architecture/security/adversarial review only if concrete capacity returns.
- **CodeRabbit:** BINDING INDEPENDENT GATE — required on the exact PR head while Codex and Claude remain unavailable or limited.
- **Gemini Agent:** PAUSED/OFF-ROSTER by owner decision.
- **Gemini Chat:** PAUSED/OFF-ROSTER by owner decision.

## Binding delivery rules

- Exactly one canonical PR and one active implementer lease per work stream.
- An assignment is not evidence of progress: require heartbeat/checkpoint, commit, PR, CI, review artifact, or a visibly running deterministic job.
- A claimed active lease without observable progress for 30 minutes is stale unless a deterministic job is visibly progressing.
- While Codex and Claude are unavailable or limited, the binding merge rule is: required exact-head CI green + CodeRabbit coverage of that exact head + no unresolved CodeRabbit BLOCKER/MAJOR findings.
- This temporary gate assignment is the owner's current operating directive for the limited-capacity period and must not be silently overridden by stale coordination text.
- `@coderabbitai review` is incremental. When the latest commit was already reviewed but the entire PR must be re-evaluated, use `@coderabbitai full review`.
- ChatGPT may execute the mechanical expected-head merge after all binding gates pass.
- Gemini Agent and Gemini Chat remain paused until the owner explicitly re-enables them.
