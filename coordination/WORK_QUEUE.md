# Tabibi Work Queue

This is the human-readable work marketplace for available engineering capacity. It supplements `coordination/STATE.json`; if the two conflict about canonical implementation/review state, live GitHub evidence and `STATE.json` win.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round — Epic #5 / Work Unit 9

WU6 privacy-preserving waiting-room identifiers, WU7 doctor-delay hardening, and WU8 receptionist operations dashboard are merged.

The primary product stream is now **Issue #96 — WU9: deterministic queue ETA snapshot v1**.

This slice is backend-first and explainable. It deliberately excludes notifications, patient/public ETA delivery, appointment changes, ML/AI inference, clinical data, and queue-order mutation.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| WU9-ARCH-001 | ACTIVE | chatgpt | Product/architecture ownership, bounded scope enforcement, state reconciliation, merge orchestration | Issue #96 contract + coordination decisions | No application edits unless explicit failover |
| WU9-IMPLEMENT-001 | ACTIVE | copilot | Implement deterministic staff-only ETA snapshot per Issue #96 from committed queue/session state; one canonical branch/PR | Canonical PR + tests + exact-SHA handoff | Yes — sole WU9 implementation lease |
| WU9-RISK-001 | ACTIVE | claude | Adversarial pre-mortem covering determinism, ETA range math, fallback prior, delay effects, state exclusion, tenancy, stale/concurrent reads | Risk/test matrix on #96 | Review only |
| WU9-GATE-001 | BLOCKED | claude | Independent non-author exact-SHA gate after implementation and green CI | PASS/MERGE_READY or findings | Review only |
| WU9-QA-001 | READY | chatgpt / available non-author actor | Complementary deterministic test-oracle review after first implementation checkpoint without editing WU9 code | TEST_IDEA / QA matrix | No implementation |
| WU9-MERGE-001 | BLOCKED | chatgpt | Mechanical merge only after unchanged exact head has green CI and valid independent gate | Merge commit + state reconciliation | Merge only |

## Parallel bounded cleanup — Issue #94

TAB-WU8-003 is a non-blocking follow-up from Claude's WU8 re-review. It is independent from WU9 and may proceed in parallel without touching ETA code.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| WU8-FOLLOWUP-003 | ACTIVE_PENDING_CAPACITY | codex | Keep failure-induced stale state latched until next success (or equivalent failed-poll OR time-stale model); tighten e2e timestamp fixture | One bounded PR for Issue #94 + focused browser regression | Yes, only if Codex confirms capacity |
| WU8-FOLLOWUP-003-GATE | BLOCKED | eligible non-author reviewer | Independent exact-head review after green CI | PASS/MERGE_READY or findings | Review only |

## Capacity and anti-duplication rules

- Exactly one canonical PR and one active implementer lease per work stream.
- Copilot owns WU9 implementation. Codex must not modify WU9 unless an explicit failover releases Copilot first.
- Codex owns Issue #94 only if it confirms recovered capacity; otherwise the task remains pending failover.
- Claude is review-only on WU9 and must author no WU9 application code while retaining gating independence.
- Gemini Agent and Gemini Chat remain paused until the owner explicitly re-enables them.
- An assignment is not evidence of work. HEARTBEAT/CHECKPOINT, commits, PRs, CI, or review artifacts are required before an actor is treated as active.

## Claim protocol

Before taking a `READY` item, post in Team Room:

```text
TASK_CLAIM <task-id>
actor: <actor>
work_stream: <issue/work unit>
planned_artifact: <what you will produce>
conflict_check: <why this does not duplicate an active implementation/review lease>
```

When done:

```text
TASK_DONE <task-id>
actor: <actor>
artifact: <comment/pr/commit/report>
key_result: <one-line result>
follow_up: <next proposed task/handoff>
```

## Standing opportunistic tasks

These may be proposed/claimed when they do not interfere with active delivery:

- `REF-*` targeted refactoring analysis;
- `TEST-*` missing deterministic tests or scenario design;
- `UX-*` Algeria/Arabic/French/RTL/mobile/accessibility verification;
- `SEC-*` threat/risk review of upcoming scope;
- `OBS-*` observability/failure-diagnosis improvement;
- `DOC-*` reproducibility/operability documentation;
- `PERF-*` bounded performance/load hypotheses and test plans;
- `BACKLOG-*` decomposition of a future product slice.
