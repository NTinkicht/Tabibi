# ChatGPT Handoff

## Current operating model

Tabibi uses the capability-resilient four-agent mesh defined by `AGENTS.md`, `coordination/AUTONOMY_PROTOCOL.md`, `coordination/ROLE_FAILOVER_PROTOCOL.md`, and `coordination/COLLABORATION_PROTOCOL.md`.

GitHub Issue #21 is the permanent Team Room. ChatGPT must post its own `HEARTBEAT` / `CHECKPOINT` messages when actively orchestrating or implementing, participate in retrospectives, record process consensus, and reconcile stale leases rather than silently waiting.

## Current engineering stream

Issue #4 Work Unit 2 / PR #15 is merged.

Issue #4 Work Unit 3 — walk-in/guest patient intake and atomic `waiting` QueueEntry materialization — is active in the single canonical draft PR #20 on branch `claude/issue-4-work-unit-3-walkin-queue`.

ChatGPT currently owns the implementation/CI-remediation lease after no-idle failover from Claude. Because ChatGPT materially authors this stream, an eligible non-author reviewer must provide the eventual exact-SHA gating verdict.

Current known deterministic CI state from run `34028241002` at head `7826a177ebea7f30d5f49b0123e8687c5170cb3e`:
- PostgreSQL integration: PASS;
- Quality/build: failed only at Prettier check on four Work Unit 3 files;
- Browser job reached production build and failed TypeScript because `vitest.config.ts` uses unsupported `fileParallelism` in project config.

These are active remediation items, not external blockers. ChatGPT should fix them on the same canonical branch, rerun CI, and continue without asking Nassim.

## Team-learning duties

Before material action, inspect:
- `coordination/STATE.json`;
- Team Room Issue #21 and generated `TEAM_STATUS.md`;
- recent `TEAM_LEARNING.md` and `RETROSPECTIVES.md`;
- current PR/CI evidence.

After each meaningful checkpoint, post to Team Room. If an active actor's heartbeat/artifacts are stale beyond the collaboration threshold, reconcile and fail over according to protocol.

After every merged bounded work unit or material coordination incident, ensure a retrospective opens and produces explicit proposals/consensus or a recorded disagreement.

## Owner boundary

Nassim is Product Owner, not a routine scheduler, relay, reviewer coordinator, or merge operator. Escalate only genuine owner-only matters defined in `AGENTS.md`.
