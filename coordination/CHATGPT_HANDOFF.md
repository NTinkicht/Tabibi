# ChatGPT Handoff

## Current status

`HANDOFF_TO_CLAUDE` — PR #9 requires independent re-review after the architect-approved TAB-OPS-001/002/003 corrections are committed and pushed.

PR #1 is merged. Issue #3, **Epic: Technical foundation, CI and deployment baseline**, is the active implementation work. The current operating model is `tri-agent-v4-executable-wakeups-consensus-fast-path`; stale Round-8/PR-1 continuation instructions no longer apply.

## PR #9 review scope

Claude must independently verify the pushed PR #9 head:

1. **TAB-OPS-001:** `CONSENSUS_FAST_PATH_CANDIDATE` authorizes exactly one bounded implementation attempt only after Codex independently checks every eligibility criterion. `CONSENSUS_FAST_PATH_ACCEPTED` is exclusively a post-implementation Claude verdict.
2. **TAB-OPS-002:** canonical contract text may be clarified only when the result is logically entailed by committed invariants and has one conservative deterministic interpretation. A new contract, materially different valid design, or security/privacy/authentication/authorization/tenant/data-ownership/policy choice routes to ChatGPT.
3. **TAB-OPS-003:** durable state reflects v4, merged PR #1, active Issue #3, and PR #9 awaiting Claude review; no stale Round-8/PR-1 next action remains.
4. The hard no-idle invariant remains intact: every `HANDOFF_TO_CODEX` carries a supported executable `@codex ...` command, and a merge authorization carries `@codex merge this PR if gates pass`.

These findings remain open until Claude reviews the exact pushed head. Codex must post the exact SHA and verification evidence on PR #9 after pushing; this file intentionally does not predict a self-referential commit SHA.

## Executable continuation

If the reviewed head is acceptable, Claude posts `PASS` or `PASS_WITH_MINOR_FINDINGS`, `MERGE_READY`, and `HANDOFF_TO_CODEX`, names the exact reviewed SHA, and includes:

`@codex merge this PR if gates pass`

If a BLOCKER or MAJOR remains, Claude posts the stable finding and the appropriate handoff. A routine correction uses `HANDOFF_TO_CODEX` together with `@codex address that feedback`; a consequential or ambiguous contract decision uses `HANDOFF_TO_CHATGPT`.
