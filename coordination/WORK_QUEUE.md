# Tabibi Work Queue

This is the human-readable work marketplace for available engineering capacity. It supplements `coordination/STATE.json`; if the two conflict about the canonical implementation/review state, `STATE.json` and live GitHub evidence win.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Current company round — Issue #4 / Work Unit 5

Work Units 1–4 are merged. Work Unit 5 is the next bounded clinic-operations slice:

**Authorized queue priority/reorder with mandatory reason, deterministic ordering, idempotency and audit.**

This slice deliberately does **not** add ETA, notifications, appointment booking, public waiting-room screens, restore/transfer, or new clinical data. One canonical implementation stream only.

| Task ID | Status | Preferred actor | Scope | Expected artifact | Code allowed? |
| --- | --- | --- | --- | --- | --- |
| WU5-IMPLEMENT-001 | ACTIVE | codex | Implement authorized priority/reorder on current `main`: clinic-scoped permission checks; eligible queue states only; mandatory non-empty reason; deterministic persisted service order/priority; PostgreSQL serialization; idempotent retry receipt; metadata-only audit; API + receptionist UI; regression/concurrency tests | One canonical branch/PR + exact-SHA handoff | Yes — sole implementation lease |
| WU5-RISK-001 | ACTIVE | claude | Adversarial pre-mortem and later independent exact-SHA gate: authorization, tenant isolation, fairness/state-machine abuse, concurrency, idempotency, audit completeness, stale commands, priority starvation and deterministic ordering | `RISK_CALL`/test recommendations now; findings or `MERGE_READY` on final exact head | Review only; no application edits while gating |
| WU5-UX-001 | ACTIVE | gemini_chat | Algeria-realistic UX/system lane: receptionist mental model, urgent/priority reason capture, Arabic/French/RTL/mobile, accessibility, low-connectivity retries, clear indication that reorder is exceptional and audited | `UX_NOTE` + scenario/test matrix; later complementary exact-head verification | No implementation unless explicitly failed over |
| WU5-QA-001 | READY | gemini_agent | One bounded capacity check. If recovered, independently design system/concurrency QA for reorder races, duplicate retries, stale views and cross-clinic attempts without duplicating Gemini Chat | `CAPACITY_RECOVERED` + QA matrix, or one precise capacity-degraded report | No implementation unless explicitly failed over |
| WU5-REF-001 | READY | chatgpt/codex after implementation checkpoint | Identify only low-risk refactors revealed by WU5 that reduce duplication in queue command validation/audit/retry handling without broadening the PR | `REFACTOR_IDEA` with file-level evidence and whether defer/fold-in | Only if implementer decides it is required for WU5 |
| WU5-GATE-001 | BLOCKED | claude | Independent exact-SHA merge gate after Codex implementation and green CI | Stable findings or `PASS/MERGE_READY` | Review only |
| WU5-SECONDARY-001 | BLOCKED | gemini_chat / gemini_agent | Complementary UX/system verification of WU5 exact head | Scenario evidence/findings | Review only |
| WU5-MERGE-001 | BLOCKED | codex → chatgpt fallback | Mechanical merge only after unchanged exact head has green CI and valid independent `MERGE_READY` | Merge commit + state reconciliation | Merge only |

### WU5 acceptance requirements

- Only authorized clinic staff may reorder/priority-adjust queue entries; cross-clinic IDs never widen access.
- Reorder/priority is allowed only for committed eligible queue states; called/in-consultation/terminal entries cannot be silently reshuffled.
- Every successful priority/reorder mutation requires a non-empty operational reason and creates metadata-only audit evidence containing actor, clinic/session/entry identifiers, prior ordering data, resulting ordering data and reason — no diagnosis/clinical justification fields.
- Concurrent reorder/retry operations are serialized in PostgreSQL and yield a deterministic committed order; duplicate retries do not create duplicate side effects/audit rows.
- Existing immutable registration order remains preserved as historical evidence; service/priority order is a separate mutable operational concept.
- Ordinary call-next/service selection remains deterministic after priority changes and must not strand or duplicate queue entries.
- Arabic/French/RTL/mobile receptionist UI clearly exposes priority/reorder as an exceptional audited action, requires reason before submission, and reports conflict/stale-state outcomes safely.
- Real-PostgreSQL tests cover authorization, tenant isolation, eligible/ineligible states, repeated idempotent request, simultaneous reorder races, stale-version conflict and deterministic resulting order. Browser coverage includes at least one mobile/RTL priority adjustment flow.
- Full lint/typecheck/unit/integration/build/security-audit/CI remain green.

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
