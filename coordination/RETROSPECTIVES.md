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
