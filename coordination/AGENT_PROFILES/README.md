# Tabibi Specialist Role Overlays

Role overlays define **how an existing engineering actor should think and review for a bounded task**. They do not create new autonomous actors, implementation streams, PRs, or authority.

## Source provenance

The initial profiles are adapted for Tabibi from `NTinkicht/agency-agents`, pinned to upstream commit:

`647c8baa42b6842afb4a97bf2c0950d45ba88e8b`

The upstream repository is MIT licensed. Tabibi overlays are intentionally shorter and product-specific; upstream changes never alter Tabibi behavior until explicitly reviewed and repinned.

## Identity separation

Actor identity and role identity are separate:

- actor: `chatgpt`, `codex`, `claude`, `copilot`, or another explicitly enabled actor;
- overlay: a professional lens such as `backend-architect` or `database-reliability`.

An actor may wear one primary overlay and zero or more specialist-review overlays for a bounded work unit, but every active lane still requires an explicit actor lease.

## Binding rules

1. Existing governance always wins: one canonical PR, one implementation lease, exact-SHA gating, material-authorship independence, no duplicate implementation, owner authority, and failover rules remain unchanged.
2. An overlay cannot make an ineligible actor eligible to self-gate its own work.
3. Specialist reviews should be orthogonal. Do not ask five overlays to perform the same generic review.
4. Findings use the canonical Tabibi severities: `BLOCKER`, `MAJOR`, `MINOR`, `NOTE`.
5. Binding verdicts use only `PASS`, `PASS_WITH_MINOR_FINDINGS`, or `CHANGES_REQUIRED`.
6. Healthcare strategy overlays do not create clinical authority. Tabibi remains an operations product unless the owner explicitly expands scope.
7. Persona walkthroughs generate qualitative hypotheses, not empirical user evidence.
8. Profiles may shape reasoning and deliverables but cannot override repository contracts or invent requirements.

## Initial curated set

- `backend-architect.md` — backend/domain/API architecture and migration safety.
- `database-reliability.md` — PostgreSQL concurrency, integrity, migration and recovery adversary.
- `code-reviewer.md` — general independent exact-SHA correctness/security gate.
- `sre.md` — production reliability, failure modes, observability and operational readiness.
- `persona-walkthrough.md` — Algeria-realistic receptionist/patient UX simulation.
- `healthcare-innovation-strategist.md` — external healthcare narrative and evidence discipline.
- `sovereign-health-systems.md` — registered but dormant public-sector/sovereign-health strategy profile; activate only for a concrete approved need.

## Work-unit declaration

Every new substantial work unit should use the canonical structure from `coordination/WORK_UNIT_TEMPLATE.md`, for example:

```yaml
actors:
  implementer: copilot
  gate: codex
  merge_executor: chatgpt
  secondary_verifiers:
    - actor: claude
      overlay: database-reliability
      scope: PostgreSQL concurrency and migration safety
  experience_qa:
    - actor: copilot
      overlay: persona-walkthrough
      scope: receptionist Arabic/French/mobile usability

role_overlays:
  implementer: backend-architect
  gate: code-reviewer
```

This means Copilot implements while operating as Backend Architect, Codex independently gates while operating as Code Reviewer, and each specialist lane has an explicit actor-backed lease.

## Review output

Specialist reviews should produce a compact artifact:

```text
SPECIALIST_REVIEW
actor: <actor>
overlay: <overlay-id>
pr: <number>
work_unit: <issue/pr>
exact_sha: <sha or n/a for pre-mortem>
verdict: PASS | PASS_WITH_MINOR_FINDINGS | CHANGES_REQUIRED
merge_ready: yes | no
findings:
- BLOCKER | MAJOR | MINOR | NOTE: ...
```

Only a reviewer who is independently eligible under the existing exact-SHA and material-authorship governance may issue the binding merge gate.
