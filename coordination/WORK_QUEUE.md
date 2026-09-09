# Tabibi Work Queue

This is the human-readable work marketplace for available engineering capacity. It supplements `coordination/STATE.json`; if the two conflict about canonical implementation/review state, live GitHub evidence wins.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round — post-WU12 reconciliation

WU12 / Issue #113 / PR #114 is merged and complete. There are currently no open pull requests and no active product implementation lease.

The previous WU9/WU10 coordination entries were stale and are retired. Do not resurrect their implementation leases.

The next product slice has not yet been formally scoped. The immediate canonical work is bounded architecture/backlog reconciliation against current `main`: select the smallest dependency-ready slice after appointment lifecycle synchronization, create its issue/acceptance contract, and only then assign one implementation lease.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| POST-WU12-ARCH-001 | ACTIVE | chatgpt | Reconcile current main, epics and dependencies; define next smallest bounded product work unit | New issue with explicit scope/exclusions/acceptance | No application edits |
| POST-WU12-IMPLEMENT-001 | BLOCKED | unassigned | Implement the next work unit after architecture contract exists | One canonical branch/PR + tests | Yes, after explicit lease only |
| POST-WU12-GATE-001 | BLOCKED | CodeRabbit | Binding independent exact-head gate while Codex/Claude are unavailable or limited | Full review with no unresolved BLOCKER/MAJOR findings | Review only |
| POST-WU12-MERGE-001 | BLOCKED | chatgpt | Mechanical merge after unchanged exact head has green CI and CodeRabbit gate | Merge + state reconciliation | Merge only |

## Current actor status

- **ChatGPT:** ACTIVE — CTO/orchestrator and state reconciler. Owns only POST-WU12-ARCH-001; no product-code lease yet.
- **Copilot:** AVAILABLE/UNASSIGNED — prior WU12 lease was released for inactivity and later superseded by ChatGPT takeover. No active lease.
- **CodeRabbit:** AVAILABLE AS BINDING GATE — independent PR gate for the next product PR. For a complete re-evaluation after incremental review, use `@coderabbitai full review`.
- **Codex:** LIMITED/UNASSIGNED — do not depend on it for implementation or gating until concrete capacity recovery is observed.
- **Claude:** LIMITED/UNASSIGNED — preserve as optional independent architecture/security review if capacity returns; not required while CodeRabbit is the binding gate.
- **Gemini Agent:** PAUSED/OFF-ROSTER by owner decision.
- **Gemini Chat:** PAUSED/OFF-ROSTER by owner decision.

## Binding delivery rules

- Exactly one canonical PR and one active implementer lease per work stream.
- An assignment is not evidence of progress: require heartbeat/checkpoint, commit, PR, CI, review artifact, or a visibly running deterministic job.
- A claimed active lease without observable progress for 30 minutes is stale unless a deterministic job is visibly progressing.
- Binding merge rule while Codex/Claude are unavailable or limited: green exact-head CI + CodeRabbit coverage of the exact head + no unresolved BLOCKER/MAJOR findings.
- `@coderabbitai review` is incremental. Use `@coderabbitai full review` when the entire PR must be re-evaluated after the latest commit has already been reviewed.
- Gemini Agent and Gemini Chat remain paused until the owner explicitly re-enables them.
