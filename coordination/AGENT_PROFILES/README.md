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

An actor may wear one primary overlay and zero or more specialist-review overlays for a bounded work unit.

## Binding rules

1. Existing governance always wins: one canonical PR, one implementation lease, exact-SHA gating, no duplicate implementation, owner authority, and failover rules remain unchanged.
2. An overlay cannot make an ineligible actor eligible to self-gate its own exact SHA.
3. Specialist reviews should be orthogonal. Do not ask five overlays to perform the same generic review.
4. Findings use severity: `BLOCKER`, `SHOULD_FIX`, `FOLLOW_UP`, `NIT`.
5. `BLOCKER` is reserved for correctness, security/privacy, data integrity, dangerous concurrency, destructive migration, or binding product-contract failure.
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

Later overlays such as sovereign-health strategy, UX architecture, technical writing, or incident command may be added only when there is a concrete Tabibi need.

## Work-unit declaration

Every new substantial work unit should include an overlay block such as:

```yaml
role_overlays:
  implementer: backend-architect
  qa: database-reliability
  gate: code-reviewer
  optional:
    - persona-walkthrough
```

The actor assignment is recorded separately. Example:

```yaml
actors:
  implementer: copilot
  gate: codex
```

This means Copilot implements while operating as Backend Architect, and Codex independently gates while operating as Code Reviewer.

## Review output

Specialist reviews should produce a compact artifact:

```text
SPECIALIST_REVIEW
actor: <actor>
overlay: <overlay-id>
work_unit: <issue/pr>
exact_sha: <sha or n/a for pre-mortem>
verdict: PASS | PASS_WITH_FINDINGS | CHANGES_REQUIRED
findings:
- BLOCKER: ...
- SHOULD_FIX: ...
- FOLLOW_UP: ...
- NIT: ...
```

Only a reviewer who is independently eligible under the existing governance may issue the binding merge gate.
