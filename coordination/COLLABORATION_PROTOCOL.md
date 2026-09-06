# Tabibi Collaboration, Heartbeat and Learning Protocol v1

This protocol is binding for ChatGPT, Codex Cloud, Claude, and Gemini. It supplements `AGENTS.md`, `coordination/AUTONOMY_PROTOCOL.md`, `coordination/ROLE_FAILOVER_PROTOCOL.md`, and `coordination/STATE.json`. Product, architecture, security, reviewer-independence, role-lease, and owner-authority rules remain unchanged.

## 1. Permanent Team Room

GitHub Issue #21 — **Team Room — Heartbeats, retrospectives, consensus and learning** — is the shared durable discussion space.

Use it for:
- activity heartbeats and checkpoints;
- cross-agent questions and answers;
- retrospectives;
- process-improvement proposals;
- explicit agreement/disagreement and consensus;
- reusable lessons;
- capacity/failover observations that affect teamwork.

Do not expose secrets, credentials, patient data, production tokens, or other sensitive content.

GitHub Actions mirrors the Team Room into `coordination/TEAM_INTERACTIONS.md` and derives `coordination/TEAM_STATUS.md` so the Product Owner can inspect the collaboration history without reconstructing conversations from many PRs.

## 2. Heartbeat obligation

An actor holding an active role lease must make its work visible.

Post a `HEARTBEAT` in Team Room:
1. when accepting or starting a role lease;
2. after every meaningful checkpoint such as a commit, CI result, review finding, merge, architecture decision, or discovered blocker;
3. at least about every 15 minutes during a long-running active session when that runtime permits periodic posting;
4. before releasing or handing off the role lease;
5. when work becomes blocked, including the exact blocker and failover action.

Short tasks that finish before 15 minutes need only start/checkpoint/final visibility. Do not manufacture empty timer messages.

Template:

```text
HEARTBEAT
actor: <chatgpt|codex|claude|gemini>
role: <leased role>
work_stream: <issue/pr/work unit>
status: <active|blocked|waiting_external|complete>
current_action: <concrete action>
last_artifact: <commit/pr/run/comment or none>
next_checkpoint: <observable next proof of progress>
blocker: <none or exact blocker>
```

A heartbeat is not a substitute for code, tests, review, or merge activity. It is visibility into real work.

## 3. Stale-work rule

The collaboration watchdog treats an active lease with no fresh heartbeat/checkpoint for 30 minutes as **stale** unless a known long-running deterministic job is still visibly progressing.

A stale marker is not automatic proof the agent failed. The orchestrator must reconcile GitHub state, CI, branch movement, and comments first. If the actor is truly idle/deadlocked, apply `ROLE_FAILOVER_PROTOCOL.md` rather than waiting for Nassim.

No agent should keep a lease while silently inactive.

## 4. Checkpoints

Use `CHECKPOINT` for meaningful intermediate evidence. Include:
- actor and role;
- exact work stream;
- what changed;
- evidence (SHA, PR, workflow run, finding IDs, test counts);
- next action and next actor when a handoff is involved.

Checkpoints should be factual and concise.

## 5. Retrospectives

Open a retrospective:
- after every merged bounded work unit;
- after a material coordination failure, duplicate stream, repeated stale handoff, quota-driven failover, or significant CI incident;
- when the orchestrator believes a repeated pattern should be corrected before the next work unit.

Use `RETRO_OPEN` in Team Room. Relevant agents then post `RETRO_ENTRY`:

```text
RETRO_ENTRY
actor: <actor>
work_stream: <scope>
liked: <what helped>
did_not_like: <friction, waste, risk, confusion>
change: <specific improvement>
lesson: <reusable lesson>
```

Retrospectives are expected to be candid but technical and respectful. Critique process, decisions, assumptions, and artifacts rather than personalities.

## 6. Discussion and consensus

Any agent may post `PROCESS_PROPOSAL` with:
- stable proposal ID, e.g. `PROC-001`;
- problem/evidence;
- proposed change;
- expected benefit;
- tradeoff/risk;
- how success will be measured;
- whether it is reversible/experimental.

Other agents respond with one of:
- `CONSENSUS_ACK <ID>` — agree, with reason;
- `CONSENSUS_AMEND <ID>` — agree only with a concrete amendment;
- `CONSENSUS_CHALLENGE <ID>` — disagree, with evidence or risk.

For routine reversible collaboration/process changes, consensus is reached when:
- the proposer plus at least two other independent agents agree; and
- no unresolved evidence-backed challenge remains from an available active agent after a reasonable bounded discussion window.

If only two AI runtimes are currently available because of provider limits, a reversible process experiment may proceed with both agreeing plus ChatGPT recording it as provisional. It must be revisited when another agent becomes available.

For consequential architecture/security/product/data-policy changes, this protocol does **not** replace existing authority. Follow `AGENTS.md`, `ARCHITECTURE.md`, `SECURITY.md`, and the technical-quorum/owner rules.

If routine process consensus cannot be reached after two bounded discussion rounds, ChatGPT records the disagreement and chooses a reversible experiment or the status quo. Nassim is not used as a routine tie-breaker.

## 7. Decision and learning records

Accepted process changes are recorded in `coordination/TEAM_LEARNING.md` with:
- decision/lesson ID;
- date;
- originating retro/proposal;
- consensus participants;
- adopted change;
- rationale;
- measurement/expiry/review date if experimental;
- result after review.

Retrospective summaries are recorded in `coordination/RETROSPECTIVES.md`.

The raw conversation remains visible in `coordination/TEAM_INTERACTIONS.md`; summaries must never rewrite history to hide disagreement.

## 8. Teach each other

Agents are expected to transfer useful knowledge, not merely hand off tasks.

When discovering a reusable technique, failure mode, test strategy, provider limitation, UX insight, or architecture pattern, post `LESSON_LEARNED` in Team Room. Another agent should acknowledge, challenge, or extend it when relevant.

Before beginning a similar future task, check `TEAM_LEARNING.md` and recent retrospectives so the team does not repeatedly rediscover the same lesson.

## 9. Capacity transparency

Provider/runtime limits must be visible in Team Room and `STATE.json` using existing capability-specific markers. A provider limit does not justify silent waiting.

Heartbeats from a limited actor should say exactly which capability is affected and whether the role lease was released or failed over.

## 10. Interaction-file integrity

`coordination/TEAM_INTERACTIONS.md` is generated from Team Room and should not be manually edited except to repair the sync mechanism. The source of truth for raw interaction is Issue #21.

`coordination/TEAM_STATUS.md` is also generated. It shows latest parsed heartbeat per actor and may lag GitHub by one sync cycle.

`TEAM_LEARNING.md` and `RETROSPECTIVES.md` are curated durable summaries and may be edited through normal reviewed coordination changes.

## 11. Agent-specific adoption

- **Codex:** `AGENTS.md` is authoritative; every Codex task must honor this protocol and post heartbeats/checkpoints while active.
- **Claude:** `CLAUDE.md` plus this protocol are authoritative for Claude-specific behavior; Claude participates in Team Room retrospectives and consensus even when its current role is reviewer rather than implementer.
- **Gemini:** `GEMINI.md` plus this protocol are authoritative; Gemini contributes UX/system lessons and retrospective feedback, not only pass/fail reviews.
- **ChatGPT:** ChatGPT must treat Team Room, `STATE.json`, CI, and branch/PR evidence as live orchestration state and post its own heartbeats/checkpoints when actively operating the project.

No actor is exempt because it is the orchestrator, reviewer, or fallback runtime.
