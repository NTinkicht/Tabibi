# Tabibi Work Unit Template

Use this template for substantial product or infrastructure work units.

```yaml
work_unit: WUxx
issue: "#<number>"
goal: <one bounded outcome>

actors:
  orchestrator: chatgpt
  implementer: <chatgpt|codex|claude|copilot|gemini-cli|mistral-vibe>
  gate: <independent eligible chatgpt|codex|claude|copilot|gemini-cli|mistral-vibe>
  merge_executor: <chatgpt|codex|claude|copilot>
  secondary_verifiers:
    - actor: <optional active actor>
      overlay: <specialist overlay id>
      scope: <bounded orthogonal review question>
  experience_qa:
    - actor: <optional active actor>
      overlay: persona-walkthrough
      scope: <bounded UX/localization/accessibility question>

role_overlays:
  selection_required: true
  orchestrator: <overlay id | none-with-reason>
  implementer: <overlay id | none-with-reason>
  gate: code-reviewer
  rationale: <why this is the smallest useful overlay set>

scope:
  include:
    - <explicit behavior>
  exclude:
    - <explicit non-goal>

invariants:
  - <state/data/security invariant>

acceptance_evidence:
  - <test/CI/browser/migration/review evidence>

review_independence:
  exact_sha_required: true
  material_authorship_check_required: true
  self_gate_forbidden: true
```

## Lease rules

- Every substantial work unit names all four mandatory leases: orchestrator, implementer, gating reviewer and merge executor.
- Active actors are `chatgpt`, `codex`, `claude`, `copilot`, `gemini-cli`, and `mistral-vibe`, subject to `coordination/ACTOR_REGISTRY.json`, capability evidence, current included-plan availability, and authorship independence. Retired actors are not valid lease targets.
- `gemini-cli` and `mistral-vibe` have no default production merge authority; merge execution remains restricted to actors that explicitly declare `merge_execution` capability in `coordination/ACTOR_REGISTRY.json`.
- Every active specialist/experience-QA lane names one actor and one overlay. An overlay never creates/shares a lease by itself.
- Secondary verifiers cannot issue the authoritative `MERGE_READY` verdict and receive no implementation authority from an overlay. Known-open `BLOCKER`/`MAJOR` findings from any verifier still invalidate merge readiness until reconciled.
- The merge executor performs only the mechanical merge after every gate in `coordination/AUTONOMY_PROTOCOL.md` passes.

## Overlay selection is mandatory

For every substantial work unit, choose the smallest useful overlay set before implementation begins.

`none` is allowed only when the work-unit contract gives a concrete reason, for example a purely mechanical docs/metadata change with no meaningful specialist lens. Omitting the field is not equivalent to `none`.

Defaults:

- Backend/domain/API work: `backend-architect` for implementer or orchestrator.
- PostgreSQL/concurrency/migration work: add one actor-backed `database-reliability` secondary verification lane.
- All code PR final gates: `code-reviewer`.
- Patient/receptionist UI: add one actor-backed `persona-walkthrough` experience-QA lane.
- External provider/realtime/deployment work: add one actor-backed `sre` secondary verification lane.
- External healthcare messaging/pilot proposals: `healthcare-innovation-strategist`.

Do not add overlays merely to increase reviewer count. Each overlay must answer a distinct question and have one explicit actor owner.
