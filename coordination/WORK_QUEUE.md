# Tabibi Work Queue

This is the human-readable work marketplace for available engineering capacity. It supplements `coordination/STATE.json`; if the two conflict about the canonical implementation/review state, `STATE.json` and live GitHub evidence win.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round — Issue #4 / post-Work Unit 4 transition

Work Unit 4 merged in PR #26 as commit `848968d6c2c45c3e3a9ebadfa6e0d191cf7b2338`. Its preparation, implementation, independent gate, and mechanical merge tasks are complete. No Work Unit 5 implementation or review lease is active; ChatGPT owns the next scope/retrospective transition under the project operating agreements.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| WU4-SCOPE-001 | DONE | chatgpt | Define the bounded Work Unit 4 scope and role plan | Accepted Work Unit 4 scope | No application code |
| WU4-REF-001 | DONE | codex | Audit implementation readiness and test debt | Evidence-backed refactor/test report | No |
| WU4-RISK-001 | DONE | claude | Pre-mortem security, privacy, concurrency, and state risks | Risk map and invariants | No |
| WU4-IMPLEMENT-001 | DONE | codex | Implement Work Unit 4 on the canonical PR #26 branch | Merged code, migrations, tests, and handoff | Yes |
| WU4-GATE-001 | DONE | claude | Independently gate exact head `4292abf...` | `PASS/MERGE_READY` | Review only |
| WU4-MERGE-001 | DONE | codex | Mechanically merge the exact independently gated head | Merge commit `848968d...` | Merge only |
| WU5-SCOPE-001 | BLOCKED | chatgpt | Open the WU4 retrospective and define the next bounded slice and role plan | Scope, acceptance criteria, and executable leases | No application code |

`WU5-SCOPE-001` is blocked only until the orchestrator starts the required post-merge transition. Available actors must not infer an implementation lease from this row. They may claim a non-conflicting standing opportunistic task below or propose one in Team Room.

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
