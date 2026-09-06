# Tabibi Team Learning Register

This file records accepted collaboration/process lessons and experiments. Raw discussion remains in `TEAM_INTERACTIONS.md` / GitHub Issue #21.

## Entry template

### TL-XXX — Short title
- Date:
- Origin: retro/proposal ID and Team Room comment(s)
- Consensus: actors
- Change adopted:
- Rationale:
- Measurement / review condition:
- Status: experimental | adopted | reverted | superseded
- Outcome:

## Initial lessons

### TL-001 — Assigned work is not progress
- Date: 2026-09-06
- Origin: repeated idle handoffs during Issue #4 coordination
- Consensus: provisional owner-requested baseline; retrospective confirmation pending
- Change adopted: active actors must emit heartbeats/checkpoints and the orchestrator evaluates real artifacts (branch movement, commits, CI, findings, merges) rather than treating role assignment as progress.
- Rationale: several valid handoffs still resulted in idle periods because no observable execution followed.
- Measurement / review condition: review after the next two bounded work units; target is no silent active lease longer than 30 minutes without visible deterministic progress or a recorded blocker.
- Status: experimental
- Outcome: pending

### TL-002 — Retrospectives are part of delivery
- Date: 2026-09-06
- Origin: Product Owner request for cross-agent learning and consensus
- Consensus: provisional owner-requested baseline; retrospective confirmation pending
- Change adopted: every merged bounded work unit and material coordination incident opens a Team Room retrospective; accepted process improvements are tracked here.
- Rationale: fixes to the product are not enough if the same orchestration failure repeats.
- Measurement / review condition: verify that retrospectives produce concrete accepted/rejected proposals and that later work references prior lessons.
- Status: experimental
- Outcome: pending

### TL-003 — A private agent journal is memory, not shared truth
- Date: 2026-09-06
- Origin: RETRO-002; `coordination/STATE.json` was found stale (`open_majors: 0`, no pending findings) after Claude had already posted a completed `CHANGES_REQUIRED` verdict on PR #20, with the findings recorded in Claude's own `coordination/CLAUDE_REVIEW.md` on branch `claude/algeria-medical-queue-onboard-6rdzyj`
- Consensus: owner-directed correction; open for team consensus
- Change adopted: an actor's persistent private journal/branch (e.g. Claude's `CLAUDE_REVIEW.md`) is valid for continuity and detailed evidence, but a conclusion only becomes shared project truth once it is also posted to the relevant PR, to Team Room, and reflected in `STATE.json` where applicable. Nobody should infer project state from another actor's private journal alone.
- Rationale: the team otherwise has no way to know a review, decision, or blocker exists, and shared state silently drifts from reality.
- Measurement / review condition: no future finding/verdict should exist only in a private journal for more than one coordination cycle without also landing on the PR/Team Room/STATE.json.
- Status: experimental
- Outcome: pending

### TL-004 — A completed verdict must immediately reconcile STATE.json, the PR, and Team Room
- Date: 2026-09-06
- Origin: RETRO-002, same incident as TL-003
- Consensus: owner-directed correction; open for team consensus
- Change adopted: whichever actor completes a gating review, CI remediation, or other terminal action for a work stream updates `STATE.json` (open findings, verdict, next actor/action, lease status) as part of finishing that action, not as a separate later step.
- Rationale: a verdict that exists only as a comment, with stale shared state pointing elsewhere, causes other actors (and the owner) to work from the wrong picture of project status.
- Measurement / review condition: after each gating verdict, `STATE.json`'s `open_majors`/`open_minors`/`pending_findings`/`next_actor` should match the verdict within the same turn that posts it.
- Status: experimental
- Outcome: pending

### TL-005 — Agent scratch/journal branches are continuity aids, not canonical streams
- Date: 2026-09-06
- Origin: RETRO-002
- Consensus: owner-directed correction; open for team consensus
- Change adopted: a branch used by one actor for its own persistent memory (far behind `main`, never intended for merge) must be explicitly documented as such in that actor's operating instructions (see `CLAUDE.md`, "Persistent review branch"), so other actors do not mistake pushes to it for implementation activity or canonical state.
- Rationale: an unexplained long-lived branch that looks like an implementation branch but isn't creates ambiguity about what is and isn't part of the real work stream.
- Measurement / review condition: no actor should need to ask what a persistent journal branch is for; it should be self-evident from that actor's operating doc.
- Status: experimental
- Outcome: pending

### TL-006 — Findings discovered outside the shared bus must be propagated immediately
- Date: 2026-09-06
- Origin: RETRO-002; reinforces TL-001's evidence-over-assignment principle from the review side rather than the implementer side
- Consensus: owner-directed correction; open for team consensus
- Change adopted: a finding, verdict, or blocker discovered by any actor — whether from direct code inspection, local reproduction, or another actor's automated review bot — is propagated to the PR and Team Room as soon as it's confirmed, not batched or left implicit in a private record.
- Rationale: coordination correctness depends on every actor working from the same visible finding set; delay or private-only recording defeats the independent-review and failover model even when the underlying technical work is sound.
- Measurement / review condition: time between a finding being confirmed and it appearing on the relevant PR/Team Room should be effectively immediate (same turn/session), not deferred.
- Status: experimental
- Outcome: pending

### TL-007 — A verdict travels with a diff, not a PR number
- Date: 2026-09-06
- Origin: RETRO-003; PR #26's exact head changed twice after Claude's PASS/MERGE_READY verdict, once from Claude's own base-drift merge and once from Codex's further integration
- Consensus: smooth Codex/Claude failover, no disagreement; open for wider team consensus
- Change adopted: when a base-branch drift changes a PR's exact head after a gating verdict, the reviewer never assumes the verdict does or doesn't carry over. It runs a path-scoped `git diff --stat <originally_reviewed_head> <new_head> -- <application paths>` (source, tests, migrations, dependency lockfiles/config) and re-confirms CI is green on the *actual* new `head_sha` (not a cached/superseded run). An empty application diff means the same verdict applies to the new head; any non-empty diff means the changed lines get a fresh independent look before the verdict is reused. Either way, the decision is stated with the evidence, not assumed.
- Rationale: an author of an integration/merge commit correctly cannot self-gate it (same rule as authoring the original diff), so drift always demands a reviewer decision — but re-running the full review from scratch on a head that only picked up coordination-doc noise wastes cycles and delays merges for no safety benefit. The diff-emptiness check gives a cheap, verifiable way to tell which situation applies.
- Measurement / review condition: after any base-drift head change on a gated PR, the reviewer's next comment states the diff-emptiness result and the CI `head_sha` it checked, before stating whether the verdict is reused or redone.
- Status: experimental
- Outcome: pending
