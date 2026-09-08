# Tabibi Work Unit Template

Use this template for substantial product or infrastructure work units.

```yaml
work_unit: WUxx
issue: "#<number>"
goal: <one bounded outcome>

actors:
  orchestrator: chatgpt
  implementer: <actor>
  gate: <independent eligible actor>
  merge_executor: <actor>
  secondary_verifiers:
    - actor: <optional actor>
      overlay: <specialist overlay id>
      scope: <bounded orthogonal review question>
  experience_qa:
    - actor: <optional actor>
      overlay: persona-walkthrough
      scope: <bounded UX/localization/accessibility question>

role_overlays:
  orchestrator: <optional overlay id>
  implementer: <overlay id>
  gate: code-reviewer

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

- Every substantial work unit names all four mandatory leases: orchestrator, implementer, gating reviewer, and merge executor.
- Every active specialist or experience-QA lane names exactly one actor and one overlay. An overlay never creates or shares a lease by itself.
- Secondary verifiers are advisory unless separately promoted by binding governance. They receive no implementation authority from the overlay.
- The merge executor performs only the mechanical merge after a valid exact-head gate and green required CI.

## Overlay selection defaults

- Backend/domain/API work: `backend-architect` for implementer or orchestrator.
- PostgreSQL/concurrency/migration work: add one actor-backed `database-reliability` secondary verification lane.
- All code PR final gates: `code-reviewer`.
- Patient/receptionist UI: add one actor-backed `persona-walkthrough` experience-QA lane.
- External provider/realtime/deployment work: add one actor-backed `sre` secondary verification lane.
- External healthcare messaging/pilot proposals: `healthcare-innovation-strategist`.

Do not add overlays merely to increase reviewer count. Each overlay must answer a distinct question and have one explicit owner.
