# Tabibi Work Queue

This is the human-readable work marketplace for available engineering capacity. It supplements `coordination/STATE.json`; if the two conflict about the canonical implementation/review state, `STATE.json` and live GitHub evidence win.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round — Issue #4 / Work Unit 4 preparation

Work Unit 3 is merged. Before opening the next implementation PR, the team will use available models in parallel to shape a stronger Work Unit 4 without creating duplicate code streams.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| WU4-SCOPE-001 | ACTIVE | chatgpt | Synthesize Issue #4's next bounded slice from current product/architecture/security contracts and peer inputs | Final Work Unit 4 scope + acceptance criteria + role plan | No application code |
| WU4-REF-001 | READY | codex | Audit current `main` for implementation-readiness/refactoring/test debt relevant to the next queue-operations slice; identify concrete low-risk refactors and missing regression hooks | `REFACTOR_IDEA`/`TEST_IDEA` report with file-level evidence and priority | No code unless later separately leased |
| WU4-RISK-001 | READY | claude | Pre-mortem the likely next queue-operations slice for security, privacy, tenant isolation, state-machine, concurrency, idempotency, audit and failure-recovery risks | Risk map + recommended invariants/tests + challenge to proposed scope | No code |
| WU4-UX-001 | READY | gemini_chat | Build an Algeria-realistic receptionist/doctor workflow map for the likely next queue progression slice; cover Arabic/French/RTL/mobile/accessibility and low-connectivity/guest realities | UX scenario matrix + acceptance recommendations + refactor/system observations | No code |
| WU4-QA-001 | READY | gemini_agent | Perform one bounded capacity check; if recovered, produce a complementary system-QA/edge-case matrix for the next queue progression slice without duplicating Gemini Chat | Capacity report or QA matrix | No code |
| WU4-IMPLEMENT-001 | BLOCKED | codex | Implement the final bounded Work Unit 4 on one canonical branch/PR | Code + migrations/tests + exact-SHA handoff | Yes, only after WU4 scope is approved |
| WU4-GATE-001 | BLOCKED | claude | Independent exact-SHA gate for WU4 if Claude remains non-author | Findings or `MERGE_READY` | Review only |
| WU4-SECONDARY-001 | BLOCKED | gemini_chat / gemini_agent | Complementary UX/system verification of WU4 exact head | Scenario evidence/findings | Review only |

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

If no `READY` task fits your available capability, post a bounded `TASK_PROPOSAL` instead of remaining silently idle.

## Standing opportunistic tasks

These may be proposed/claimed when they do not interfere with an active delivery stream:

- `REF-*` — targeted refactoring analysis with evidence;
- `TEST-*` — missing deterministic test or scenario design;
- `UX-*` — Algeria/Arabic/French/RTL/mobile/accessibility verification;
- `SEC-*` — threat/risk review of upcoming scope;
- `OBS-*` — observability/failure-diagnosis improvement;
- `DOC-*` — documentation needed to make a feature reproducible/operable;
- `PERF-*` — bounded performance/load hypothesis and test plan;
- `BACKLOG-*` — decomposition of a future product slice under existing contracts.

Standing tasks are not permission to broaden scope or create a second implementation PR. The claimant must still post `TASK_CLAIM` and preserve reviewer independence.
