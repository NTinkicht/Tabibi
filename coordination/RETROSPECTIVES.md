# Tabibi Retrospective Summaries

Raw retrospective conversation lives in GitHub Issue #21 and is mirrored into `TEAM_INTERACTIONS.md`. This file stores concise durable summaries after discussion reaches a terminal state.

## Retro template

### RETRO-XXX — Scope
- Date:
- Trigger:
- Participants:
- What worked:
- What did not work:
- Proposals discussed:
- Consensus / disagreements:
- Changes accepted:
- Changes rejected/deferred:
- Lessons added to `TEAM_LEARNING.md`:
- Follow-up measurement:

## RETRO-001 — Coordination visibility and idle handoffs
- Date: 2026-09-06
- Trigger: repeated periods where a role had been assigned but no agent activity was visible and work appeared stalled.
- Participants: open; Team Room discussion pending
- What worked: capability-specific failover, single canonical PR, independent-review rule, CI as deterministic referee.
- What did not work: role assignment was sometimes mistaken for active progress; no shared periodic status surface; retrospectives and process-learning were not institutionalized; owner had to notice idle periods manually.
- Proposals discussed: heartbeat/checkpoint protocol, permanent Team Room, automatic interaction mirror/status board, stale-heartbeat watchdog, structured consensus and learning register.
- Consensus / disagreements: owner requested immediate adoption; AI-team retrospective and amendments remain open in Team Room.
- Changes accepted: collaboration protocol v1 and Team Room infrastructure established as provisional binding process.
- Changes rejected/deferred: none yet.
- Lessons added to `TEAM_LEARNING.md`: TL-001, TL-002.
- Follow-up measurement: next two bounded work units; check for silent leases, retro participation, and whether accepted lessons are reused.

## RETRO-002 — Stale shared state after a completed review, and an undocumented journal branch
- Date: 2026-09-06
- Trigger: Claude completed independent gating review of PR #20 (exact head `b27a072ec4f4099ec93265853759d7002ea3d3d4`) with verdict `CHANGES_REQUIRED` and four findings (`CLAUDE-027`, `TAB-REVIEW-001` MAJOR; `TAB-REVIEW-002`, `TAB-REVIEW-003` MINOR), recorded in detail in Claude's own `coordination/CLAUDE_REVIEW.md` on branch `claude/algeria-medical-queue-onboard-6rdzyj` and posted to the PR and Team Room — but `coordination/STATE.json` still read `open_majors: 0`, `pending_findings: []`, and "waiting for independent review", inconsistent with the completed verdict. Separately, the long-lived, far-behind-main branch carrying Claude's review journal was not explained anywhere, risking confusion with a real implementation stream.
- Participants: Claude (reconciliation); open to ChatGPT/Codex/Gemini Agent/Gemini Chat for consensus
- What worked: the underlying review itself was thorough and independently verified (CLAUDE-027 reproduced 3x locally against real Postgres rather than trusted from one green CI run; TAB-REVIEW-001 verified against the actual committed `ARCHITECTURE.md`/`SECURITY.md` text before being accepted, not taken on the automated bot's word).
- What did not work: the verdict's existence in a PR comment and a private review branch did not automatically update `STATE.json`, so shared project state briefly said something false about the project's readiness; the review journal branch had no documented role, so its purpose (and non-canonical status) was implicit rather than stated.
- Proposals discussed: require immediate `STATE.json` reconciliation as part of completing any verdict; explicitly document any actor's persistent scratch/journal branch in that actor's own operating instructions; treat private journals as memory, never as the sole location of authoritative findings.
- Consensus / disagreements: owner-directed correction adopted immediately; open for `CONSENSUS_ACK`/`CONSENSUS_AMEND`/`CONSENSUS_CHALLENGE` from other actors in Team Room.
- Changes accepted: `STATE.json` reconciled to the actual verdict (open findings, severities, next actor/action, merge-executor block); `CLAUDE.md` now documents `claude/algeria-medical-queue-onboard-6rdzyj` as Claude's non-canonical review/journal branch.
- Changes rejected/deferred: none yet.
- Lessons added to `TEAM_LEARNING.md`: TL-003, TL-004, TL-005, TL-006.
- Follow-up measurement: no future gating verdict should leave `STATE.json` inconsistent with the PR/Team Room record for more than the turn that posts it.

## RETRO-003 — A verdict travels with a diff, not a PR number: base drift after a completed gate
- Date: 2026-09-06
- Trigger: after Claude posted PASS/MERGE_READY on PR #26 (Work Unit 4, queue lifecycle) at exact head `68c39fb8`, `main` moved forward twice before merge — first from Claude's own `STATE.json` reconciliation plus an unrelated large coordination restructuring (Company Operating System/Engineering Chat/Standups/Work Queue docs), then from Codex's own base-integration commit — each time putting PR #26 in a non-mergeable or "gate invalidated" state and requiring a fresh decision about whether the existing verdict still applied.
- Participants: Claude (conflict resolution + re-gate), Codex (base integration, explicit self-recusal from self-gating), owner-scheduled heartbeat (surfaced the drift)
- What worked: Codex correctly recognized it could not self-gate its own integration commit and explicitly asked for independent re-verification instead of assuming the prior verdict carried over. Claude did not simply re-stamp the old verdict onto the new SHA either — for both drift events, verified with `git diff --stat <reviewed_head> <new_head> -- src/ tests/ db/ package.json package-lock.json vitest.config.ts` that the application diff was byte-for-byte empty before treating the original review as still valid, and separately confirmed CI was green on the *actual* new `head_sha` (not a stale/cached run) before re-confirming.
- What did not work: nothing broke, but the same PR needed three separate `STATE.json` reconciliation commits (verdict, mechanical-merge head, re-gated final head) across roughly 30 minutes because coordination-bot commits and a large doc restructuring kept landing on `main` in between — the underlying two-writer race flagged by the still-open PROC-007 proposal made each reconciliation step immediately stale to a new bot sync commit, though never incorrect.
- Proposals discussed: formalize "when base drift changes a PR's exact head, the reviewer verifies applic­ation-code diff emptiness before either re-stamping or re-reviewing — never assume either" as a named step in the review protocol; consider batching coordination-bot sync commits less frequently, or giving them a distinct commit author/marker so a reviewer can filter them out of a diff at a glance without needing an explicit path-scoped `git diff --stat`.
- Consensus / disagreements: none required — this was a smooth failover with no disagreement between Codex and Claude; recorded so the pattern is documented rather than only in Claude's private journal (per TL-003).
- Changes accepted: the diff-emptiness-check pattern is now documented as TL-007. No process/tooling change adopted yet for the bot-commit-noise proposal — deferred.
- Changes rejected/deferred: reducing coordination-bot sync commit frequency or tagging — deferred, no consensus needed yet since it caused extra reconciliation steps but no incorrect state.
- Lessons added to `TEAM_LEARNING.md`: TL-007.
- Follow-up measurement: the next time base drift invalidates a gated PR's exact head, resolution should take at most one reconciliation cycle beyond what's caused by genuinely new coordination-bot commits landing mid-resolution — not additional confusion about whether the verdict still applies.
