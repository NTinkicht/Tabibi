# ChatGPT Handoff

## Current status

`HANDOFF_TO_CLAUDE` — PR #9 requires independent re-review after author-claimed fixes for TAB-OPS-001 through TAB-OPS-004 are committed and pushed.

PR #1 is merged. Issue #3, **Epic: Technical foundation, CI and deployment baseline**, is active. PR #10 is the implementation PR; required GitHub Actions CI has now been published through the authorized ChatGPT GitHub App and is running. Claude may perform an early non-gating review of PR #10 in parallel while PR #9 is reviewed.

The current operating model is `tri-agent-v4-executable-wakeups-consensus-fast-path`.

## PR #9 review scope

Claude must independently verify the pushed PR #9 head:

1. **TAB-OPS-001:** `CONSENSUS_FAST_PATH_CANDIDATE` authorizes exactly one bounded implementation attempt only after Codex independently checks every eligibility criterion. `CONSENSUS_FAST_PATH_ACCEPTED` is exclusively a post-implementation Claude verdict.
2. **TAB-OPS-002:** canonical contract text may be clarified only when the result is logically entailed by committed invariants and has one conservative deterministic interpretation. A new contract, materially different valid design, or security/privacy/authentication/authorization/tenant/data-ownership/policy choice routes to ChatGPT.
3. **TAB-OPS-003:** durable state reflects v4, merged PR #1, active Issue #3, and current PRs; no stale Round-8/PR-1 next action remains.
4. **TAB-OPS-004:** finding state no longer creates an exact-SHA circular merge gate. Concrete pushed fixes are recorded in `review_pending_findings`, while `open_blockers`/`open_majors` count only findings currently known to remain unresolved. Claude's `PASS`/`PASS_WITH_MINOR_FINDINGS` + `MERGE_READY` for the exact reviewed SHA resolves relevant review-pending findings for merge purposes without a post-review bookkeeping commit.
5. The hard no-idle invariant remains intact: every `HANDOFF_TO_CODEX` carries a supported executable `@codex ...` command, and a merge authorization carries `@codex merge this PR if gates pass`.

`review_pending_findings` is explicitly not acceptance. If Claude rejects a claimed resolution, no `MERGE_READY` exists and the next fixing commit must reopen the finding in `pending_findings` and the appropriate severity count.

## Executable continuation

If the reviewed head is acceptable, Claude posts `PASS` or `PASS_WITH_MINOR_FINDINGS`, `MERGE_READY`, and `HANDOFF_TO_CODEX`, names the exact reviewed SHA, and includes:

`@codex merge this PR if gates pass`

If a BLOCKER or MAJOR remains, Claude posts the stable finding and the appropriate handoff. A routine correction uses `HANDOFF_TO_CODEX` together with `@codex address that feedback`; a consequential or ambiguous contract decision uses `HANDOFF_TO_CHATGPT`.

## Parallel implementation review

PR #10 may be reviewed early while CI runs. Early review is non-gating: Claude may surface architecture/security/testability defects now, but final `MERGE_READY` for PR #10 waits for required CI to pass on the exact implementation head.
