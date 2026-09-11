# Tabibi Collaboration, Heartbeat and Learning Protocol v4

This protocol is binding for **ChatGPT, Codex Cloud, Claude, and GitHub Copilot**. It supplements `AGENTS.md`, `coordination/AUTONOMY_PROTOCOL.md`, `coordination/ROLE_FAILOVER_PROTOCOL.md`, `coordination/COMPANY_OPERATING_SYSTEM.md`, `coordination/WORK_QUEUE.md`, and `coordination/STATE.json`.

Gemini Agent and Gemini Chat were retired from the active operating model by owner decision on 2026-09-11. Historical records remain part of project history, but no new Gemini heartbeat, lease, wake, review, gate or capacity probe is valid.

## 1. Permanent Team Room

GitHub Issue #21 is the durable Team Room and collaboration source of truth.

Use it for:

- heartbeats/checkpoints that expose real work;
- role lease, failover and capacity markers;
- cross-agent questions and answers;
- retrospectives and process proposals;
- reusable lessons and decisions;
- bounded task claims/proposals.

Do not expose secrets, credentials, patient data, production tokens or other sensitive content.

Generated files summarize Team Room, but Team Room/GitHub remains authoritative.

## 2. Heartbeats are visibility, not work

An actor with an active lease posts a `HEARTBEAT`:

1. when accepting/starting the lease;
2. after a meaningful artifact/result;
3. roughly every 15 minutes only during a genuinely long-running active session when the runtime naturally permits it;
4. before release/handoff/failover;
5. when blocked, with the exact blocker and failover action.

Do not manufacture timer messages and do not run external scheduled jobs just to create heartbeat traffic.

Template:

```text
HEARTBEAT
actor: <chatgpt|codex|claude|copilot>
role: <leased role>
work_stream: <issue/pr/work unit>
status: <active|blocked|waiting_external|complete>
current_action: <concrete action>
last_artifact: <commit/pr/run/comment or none>
next_checkpoint: <observable proof of progress>
blocker: <none or exact blocker>
```

## 3. Stale-work rule

An active lease with no heartbeat/checkpoint for 30 minutes is potentially stale unless a visible deterministic job is progressing.

Before failing over, reconcile branch movement, PR state, CI and comments. Assignment alone is not progress. Do not wake multiple actors to solve the same lease.

## 4. Checkpoints

Use `CHECKPOINT` for meaningful intermediate evidence. Include actor/role, exact stream, what changed, evidence, next action and next actor when handing off.

Keep checkpoints factual and concise.

## 5. Retrospectives

Open a retro after a merged bounded work unit or a material coordination/CI incident when there is a reusable lesson.

```text
RETRO_ENTRY
actor: <actor>
work_stream: <scope>
liked: <what helped>
did_not_like: <friction/waste/risk>
change: <specific improvement or no-change-needed rationale>
lesson: <reusable lesson>
```

A retrospective should produce a concrete improvement, test, task, rule or explicit conclusion that no process change is warranted. Avoid retrospective ceremony with no outcome.

The canonical retro lives in Team Room / `coordination/RETROSPECTIVES.md`. Slack `#retrospectives` is an outcome mirror only.

## 6. Discussion and consensus

Any actor may post `PROCESS_PROPOSAL` with a stable ID, evidence, proposed change, expected benefit, tradeoff, measurement and reversibility.

Responses:

- `CONSENSUS_ACK <ID>`
- `CONSENSUS_AMEND <ID>`
- `CONSENSUS_CHALLENGE <ID>`

For routine reversible process changes, the proposer plus two other independent active actors is sufficient when no evidence-backed challenge remains. If only two eligible AI actors are concretely available, both may approve a reversible experiment with ChatGPT recording it as provisional.

Consequential architecture/security/product/data-policy changes still follow `AGENTS.md`, `ARCHITECTURE.md`, `SECURITY.md` and owner/technical-quorum rules.

## 7. Decision and learning records

Accepted lessons go to `coordination/TEAM_LEARNING.md`; retro summaries go to `coordination/RETROSPECTIVES.md`; raw Team Room history remains in `coordination/TEAM_INTERACTIONS.md`.

Summaries must not rewrite history to hide disagreement.

## 8. Capacity transparency

Capacity is tracked per active actor and capability. A provider/runtime limit is recorded precisely and triggers bounded failover when necessary.

Do not repeatedly probe limited actors. Re-probe only when enough time has passed or new evidence suggests the capability may have recovered.

## 9. GitHub/Slack boundary

GitHub is the durable coordination bus. Slack is the attention/culture layer.

- Important Slack conclusions must be promoted to GitHub.
- Slack messages do not create leases or review authority.
- Standups are posted once in Team Room and summarized/mirrored to Slack rather than duplicated manually.
- Retro discussion happens in GitHub; Slack receives concise outcomes.
- `#coffee-corner` has no quotas or reminders.

## 10. Agent-specific adoption

- **ChatGPT:** orchestration/architecture/failover; must also expose its own active work.
- **Codex:** implementation/CI/mechanical merge preferred; must honor one-stream and independent-review rules.
- **Claude:** adversarial reviewer/gate preferred; participates in learning when materially involved.
- **Copilot:** QA/Test Automation and eligible non-author Code Review; coding-agent and Code Review identities are one actor for self-gating purposes.

No actor is exempt because it is “only” orchestrating, reviewing or testing.

## 11. Standups and work marketplace

`coordination/COMPANY_OPERATING_SYSTEM.md` defines the daily standup and work-marketplace behavior.

GitHub Actions generate `coordination/STANDUPS.md`, `coordination/ENGINEERING_CHAT.md`, `coordination/TEAM_INTERACTIONS.md` and `coordination/TEAM_STATUS.md` from Team Room. Current actor boards contain only `chatgpt`, `codex`, `claude`, and `copilot`; historical retired-actor entries may remain in archives.
