# L5 State Machine v1.1 - Claude Hostile Contract

This is the deterministic safety contract for four identical peer controllers operating `NTinkicht/Tabibi`, `NTinkicht/OneCompany`, and `NTinkicht/veritas-atlas`.

## Trust boundary
The LLM may diagnose, plan, implement, repair, and triage. It never supplies gate evidence. Gate evidence comes only from structured GitHub, CI, security, reviewer, and controller-ledger state. A controller instance never qualifies as its own independent reviewer.

## Run machine
`BOOT -> HALT_CHECK -> GOVERNANCE_AUDIT -> REPOSITORY_MODE -> INTENT_RECOVERY -> INVENTORY -> CLASSIFY -> SELECT -> ACQUIRE_CAS_LEASE -> RECONCILE_ITEM -> WRITE_INTENT -> FENCE_CHECK -> ACTION`

Every invocation has a unique run ID and reconstructs truth from live evidence. No previous execution position is trusted. A run never waits for CI or review; it exits into a named WAIT state and a later invocation reconciles from scratch.

## Durable controller ledger
Authoritative cross-run coordination state is stored at `.l5/controller-ledger.json` on branch `l5/controller-ledger`. Writers must read the current blob SHA and use that exact SHA as the GitHub Contents update precondition. Document revision, lease version, budget version, mode version, and lease epoch are monotonic. A stale CAS loses and performs no write.

The ledger contains repository mode, leases/intents, shared budgets, and observations. If the ledger is unreadable or contradictory, the repository enters `AUTOMATION_DEGRADED` and no dangerous autonomous write is allowed.

## Coordination and fencing
Leases are ownership/deduplication, never authorization. Each material write requires a live lease, monotonically increasing epoch, PENDING write-ahead intent, unchanged observed head/base/WU identity, sufficient TTL, and a resource-level expected ref/SHA where GitHub supports one. Expired leases with PENDING intents enter `INTENT_RECOVERY` before reassignment. Ambiguous write responses are read back by detection key before any retry.

A repo-wide `REPO_MERGE_LOCK` permits at most one merge in flight. It remains held through post-merge verification. Replenishment requires a numbered `CAPACITY_SLOT_n` lease so concurrent controllers cannot overshoot WIP.

## Derived PR states
`GOVERNANCE_CHANGE`, `WAIT_CI`, `CI_MISSING`, `CI_RED_INFRA`, `CI_RED_DETERMINISTIC`, `BEHIND_BASE`, `CI_GREEN_UNREVIEWED`, `FINDINGS_OPEN`, `DISPUTED_FINDING`, `BLOCK_HUMAN`, `WAIT_DEPENDENCY`, `MERGE_ELIGIBLE`, `MERGE_QUEUED`, `MERGE_OUTCOME_UNKNOWN`, `MERGED_UNVERIFIED`, `MERGED_VERIFIED`, `MAIN_BROKEN`, `REVERT_PENDING`, `SUPERSEDED`, `PARKED`, `WAIT_PROVIDER`, `IMPLEMENT`, `IDLE`.

States are derived from live evidence plus the ledger and are not persisted as workflow position.

## Repository modes
`NORMAL`, `MERGE_LOCKED`, `MAIN_BROKEN`, `MAIN_BROKEN_ENV`, `AUTOMATION_DEGRADED`, `PROVIDER_THROTTLED`, `GOVERNANCE_DRIFT`, `SECURITY_INTEGRITY_FAILURE`, `CONTROLLER_INTEGRITY`, `HALTED`, `ARCHIVED_PERMISSION_LOST`.

`HALTED`, `CONTROLLER_INTEGRITY`, `SECURITY_INTEGRITY_FAILURE`, and `GOVERNANCE_DRIFT` require human clearance. Main that lacks qualifying branch protection/ruleset enforcement is `GOVERNANCE_DRIFT`.

## MERGE_OK
Autonomous merge is allowed only when a single fresh snapshot proves all clauses true: repository mode is `NORMAL`; repo merge lock/fence/intent are valid; exact PR/head/base identity and base currency hold; platform governance is at least pinned and controller is not admin/bypass; governed paths/test weakening are absent; required CI/security sources are pinned by app ID and workflow path, exact-head and exact-base with latest-attempt success and no assertion failure on any attempt; code scanning and secret hygiene pass; exact-head full-diff independent nonauthor review passes with no later change request; findings/threads/holds/dependencies are resolved; credential isolation is proven. Unknown, stale, partial, skipped, unpinned, timeout, 403 or 5xx evidence is never PASS.

## Budgets and post-merge
CI infrastructure reruns max 2 per head/check; fix iterations max 5; review rounds max 3; lease acquisitions are bounded. Exhaustion enters `PARKED`. Merge uses expected-head protection. Ambiguous response becomes `MERGE_OUTCOME_UNKNOWN`. Successful merge becomes `MERGED_UNVERIFIED` under `MERGE_LOCKED` until healthy-main verification; attributable breakage enters `MAIN_BROKEN`, environmental breakage `MAIN_BROKEN_ENV`.

## Certification and activation
Release certification runs Claude scenarios S1-S30 with at least 1,000 traces per scenario, then shadow mode. Only after certification, shadow mode, active platform enforcement, human clearance of `GOVERNANCE_DRIFT`, and human merge of governed controller/workflow changes may the four 15-minute scheduled controllers be enabled. All four execute this exact contract; staggering distributes load and is never mutual exclusion.
