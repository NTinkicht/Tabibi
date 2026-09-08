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

role_overlays:
  orchestrator: <optional overlay id>
  implementer: <overlay id>
  gate: code-reviewer
  specialist_reviews:
    - <optional overlay id>
  experience_qa:
    - <optional overlay id>

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
  self_gate_forbidden: true
```

## Overlay selection defaults

- Backend/domain/API work: `backend-architect` for implementer or orchestrator.
- PostgreSQL/concurrency/migration work: add `database-reliability` specialist review.
- All code PR final gates: `code-reviewer`.
- Patient/receptionist UI: add `persona-walkthrough` experience QA.
- External provider/realtime/deployment work: add `sre` review.
- External healthcare messaging/pilot proposals: `healthcare-innovation-strategist`.

Do not add overlays merely to increase reviewer count. Each overlay must answer a distinct question.
