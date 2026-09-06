# Tabibi Collaboration, Heartbeat and Learning Protocol v3

This protocol is binding for **ChatGPT, Codex Cloud, Claude, Gemini Agent, and Gemini Chat**. It supplements `AGENTS.md`, `coordination/AUTONOMY_PROTOCOL.md`, `coordination/ROLE_FAILOVER_PROTOCOL.md`, `coordination/COMPANY_OPERATING_SYSTEM.md`, `coordination/WORK_QUEUE.md`, and `coordination/STATE.json`. Product, architecture, security, reviewer-independence, role-lease, and owner-authority rules remain unchanged.

Gemini Agent (`gemini_agent`) and Gemini Chat (`gemini_chat`) are distinct actors. They may share a model family, but they do not share identity, role leases, heartbeats, authored changes, findings, review authority, or accountability. Historical `actor: gemini` Team Room entries are interpreted as Gemini Agent.

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
actor: <chatgpt|codex|claude|gemini_agent|gemini_chat>
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

A stale marker is not automatic proof the actor failed. The orchestrator must reconcile GitHub state, CI, branch movement, and comments first. If the actor is truly idle/deadlocked, apply `ROLE_FAILOVER_PROTOCOL.md` rather than waiting for Nassim.

No actor should keep a lease while silently inactive.

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

Use `RETRO_OPEN` in Team Room. Relevant available actors then post `RETRO_ENTRY`:

```text
RETRO_ENTRY
actor: <actor>
work_stream: <scope>
liked: <what helped>
did_not_like: <friction, waste, risk, confusion>
change: <specific improvement>
lesson: <reusable lesson>
```

Retrospectives are candid but technical and respectful. Critique process, decisions, assumptions, and artifacts rather than personalities.

Gemini Chat is expected to participate as a peer when available, not merely observe other agents' retrospectives.

## 6. Discussion and consensus

Any actor may post `PROCESS_PROPOSAL` with:
- stable proposal ID, e.g. `PROC-001`;
- problem/evidence;
- proposed change;
- expected benefit;
- tradeoff/risk;
- how success will be measured;
- whether it is reversible/experimental.

Other actors respond with one of:
- `CONSENSUS_ACK <ID>` — agree, with reason;
- `CONSENSUS_AMEND <ID>` — agree only with a concrete amendment;
- `CONSENSUS_CHALLENGE <ID>` — disagree, with evidence or risk.

For routine reversible collaboration/process changes, consensus is reached when:
- the proposer plus at least two other independent available actors agree; and
- no unresolved evidence-backed challenge remains after a reasonable bounded discussion window.

Do not count Gemini Agent and Gemini Chat as automatically corroborating one another merely because they come from the same model family; each must reason independently. For consequential technical questions, model-family diversity is preferred when available.

If only two AI runtimes are available because of provider limits, a reversible process experiment may proceed with both agreeing plus ChatGPT recording it as provisional. It must be revisited when another actor becomes available.

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

Actors are expected to transfer useful knowledge, not merely hand off tasks.

When discovering a reusable technique, failure mode, test strategy, provider limitation, UX insight, or architecture pattern, post `LESSON_LEARNED` in Team Room. Another actor should acknowledge, challenge, or extend it when relevant.

Before beginning a similar future task, check `TEAM_LEARNING.md` and recent retrospectives so the team does not repeatedly rediscover the same lesson.

## 9. Capacity transparency

Provider/runtime limits must be visible in Team Room and `STATE.json` using existing capability-specific markers. A provider limit does not justify silent waiting.

Capacity is tracked per **actor and capability**. In particular:
- Gemini Agent capacity does not automatically determine Gemini Chat capacity;
- Gemini Chat capacity does not automatically determine Gemini Agent capacity;
- if evidence later shows a genuinely shared provider/project-level quota, record that explicitly rather than assuming it.

Heartbeats from a limited actor should say exactly which capability is affected and whether the role lease was released or failed over.

## 10. Interaction-file integrity

`coordination/TEAM_INTERACTIONS.md` is generated from Team Room and should not be manually edited except to repair the sync mechanism. The source of truth for raw interaction is Issue #21.

`coordination/TEAM_STATUS.md` is also generated. It shows latest parsed heartbeat per actor and may lag GitHub by one sync cycle.

`TEAM_LEARNING.md` and `RETROSPECTIVES.md` are curated durable summaries and may be edited through normal reviewed coordination changes.

## 11. Agent-specific adoption

- **Codex:** `AGENTS.md` is authoritative; every Codex task must honor this protocol and post heartbeats/checkpoints while active.
- **Claude:** `CLAUDE.md` plus this protocol are authoritative for Claude-specific behavior; Claude participates in Team Room retrospectives and consensus even when its current role is reviewer rather than implementer.
- **Gemini Agent:** `GEMINI.md` plus this protocol are authoritative; Gemini Agent contributes UX/system lessons and retrospective feedback, not only pass/fail reviews.
- **Gemini Chat:** `GEMINI_CHAT.md` plus this protocol are authoritative. Gemini Chat identifies itself as `gemini_chat`, may hold any transferable role lease, and never impersonates Gemini Agent.
- **ChatGPT:** ChatGPT must treat Team Room, `STATE.json`, CI, and branch/PR evidence as live orchestration state and post its own heartbeats/checkpoints when actively operating the project.

No actor is exempt because it is the orchestrator, reviewer, conversational collaborator, or fallback runtime.


## 12. Company-mode standups, chat and work marketplace

`coordination/COMPANY_OPERATING_SYSTEM.md` is the binding team-culture and resource-utilization layer. It adds daily/as-active `STANDUP` reporting, engineering conversation markers (`THOUGHT`, `QUESTION`, `ANSWER`, `REFACTOR_IDEA`, `PEER_FEEDBACK`, `RISK_CALL`, `UX_NOTE`, `TEST_IDEA`, `NEWS_NOTE`, `WATERCOOLER`), and the `coordination/WORK_QUEUE.md` work marketplace.

Available model capacity should create useful non-conflicting value. An actor without an active delivery lease checks the work queue for compatible `READY` work, claims it with `TASK_CLAIM`, or proposes a bounded useful task with `TASK_PROPOSAL`. This never authorizes duplicate implementation, competing PRs, self-gating, or scope expansion. Reviewer independence and the one-canonical-stream rule take precedence over utilization.

GitHub Actions generate `coordination/STANDUPS.md` and `coordination/ENGINEERING_CHAT.md` from Team Room. Humor and informal conversation are welcome only within the safety/culture rules in the company operating system and must not replace engineering evidence.
