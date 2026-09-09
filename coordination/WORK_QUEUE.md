# Tabibi Work Queue

This is the human-readable work marketplace for available engineering capacity. It supplements `coordination/STATE.json`; live GitHub evidence is authoritative for transient PR/CI facts.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round — WU14 active

WU13 / Issue #120 / PR #121 is merged and complete. The reviewed exact head was `dfe015bd83d16e8924f5bfe649cf7394525b2c59`; latest exact-head CI run #437 (`34392789350`) passed Quality/build, PostgreSQL integration, and Browser smoke. MicroReview exact-head risk 16/100 (MEDIUM) was technically adjudicated as non-blocking under the owner-approved WU13-only substitution, and PR #121 merged with expected-head protection as main commit `4fcc15337fbfa41029ae7e7ce82469d0259ace96`.

The canonical product stream is now WU14 / Issue #122 — appointment restore and transfer re-link synchronization. The implementation contract and deterministic PostgreSQL QA matrix are already published on Issue #122. Exactly one production implementation lease is active.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| WU14-IMPLEMENT-001 | ACTIVE | Codex | Implement Issue #122 restore + transfer appointment/queue re-link synchronization on one canonical branch/PR | Repository-backed commit + canonical PR + focused tests | Yes |
| WU14-QA-001 | ACTIVE | Copilot | Complementary deterministic PostgreSQL QA/test automation against the published WU14 contract; do not duplicate production implementation | Test design/evidence and, only when explicitly safe, test-only artifacts | Test-only by explicit lease |
| WU14-GATE-001 | BLOCKED | Claude or Copilot Code Review, non-author only | Independent exact-SHA correctness/concurrency/data-integrity gate after required CI is green | PASS / PASS_WITH_MINOR_FINDINGS / MERGE_READY or concrete findings | Review only |
| WU14-MERGE-001 | BLOCKED | ChatGPT | Mechanical expected-head merge only after unchanged exact head has green required CI and an eligible independent non-author gate | Merge + state reconciliation + retro | Merge only |
| POST-WU13-GOV-001 | READY | ChatGPT | Evaluate whether MicroReview should become a permanent eligible supplemental or conditional independent gate; update AGENTS.md only through a separately reviewed governance change | Governance issue/decision; no silent generalization from WU13 | No product edits |

## Current actor status

- **ChatGPT:** ACTIVE — CTO/orchestrator, architecture, state reconciliation, and mechanical merge control. No WU14 product implementation lease.
- **Codex:** ACTIVE — sole WU14 production implementer. Recent repository-read/review activity is concrete; first production proof must be a repository-backed commit/PR/test artifact or a precise capability failure.
- **Copilot:** ACTIVE/COMPLEMENTARY — WU14 QA/Test Automation. Eligible as final exact-head gate only if it did not author/materially modify that exact head.
- **Claude:** LIMITED/UNASSIGNED — preferred adversarial reviewer/gate if concrete capacity returns and it is non-author.
- **CodeRabbit:** SUPPLEMENTAL ONLY — never binding under the current owner policy.
- **MicroReview:** SUPPLEMENTAL pending separate governance decision. The WU13 owner substitution was PR-scoped and does not automatically apply to WU14.
- **Gemini Agent:** PAUSED/OFF-ROSTER by owner decision.
- **Gemini Chat:** PAUSED/OFF-ROSTER by owner decision.

## Binding delivery rules

- Exactly one canonical PR and one active implementer lease per product work stream.
- Assignment is not progress: require heartbeat/checkpoint, repository-backed commit/PR, CI, review artifact, or a visibly running deterministic job.
- An active lease with no observable progress for 30 minutes is stale unless a deterministic job is visibly progressing.
- Required exact-head CI is always binding.
- Final merge requires an eligible independent non-author exact-SHA gate under `AGENTS.md`; authoring/materially modifying the exact head makes that actor ineligible to self-gate it.
- CodeRabbit remains supplemental only. MicroReview is not generalized as a permanent gate until a separately reviewed governance decision changes `AGENTS.md`.
- ChatGPT may execute the mechanical expected-head merge after all binding gates pass.
- Gemini Agent and Gemini Chat remain paused until the owner explicitly re-enables them.
