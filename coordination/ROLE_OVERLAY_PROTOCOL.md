# Tabibi Role Overlay Protocol v1

This protocol makes `coordination/AGENT_PROFILES/` operational inside the Tabibi Company OS.

It supplements `AGENTS.md`, `coordination/COMPANY_OPERATING_SYSTEM.md`, `coordination/AUTONOMY_PROTOCOL.md`, `coordination/ROLE_FAILOVER_PROTOCOL.md`, and `coordination/COLLABORATION_PROTOCOL.md`. If any rule conflicts, the stricter product/security/reviewer-independence rule wins.

## 1. Actor vs role

An **actor** is a model/tool identity with capacity, authorship and gating eligibility. A **role overlay** is a bounded professional lens applied to that actor for one task.

Role overlays never:

- create capacity;
- create a lease;
- grant repository permissions;
- grant clinical authority;
- override authorship;
- make self-review independent.

## 2. Selection

For every new substantial work unit, the orchestrator selects the smallest useful overlay set using `coordination/WORK_UNIT_TEMPLATE.md`.

Default mapping:

| Work characteristic | Primary / specialist overlay |
| --- | --- |
| backend/domain/API | `backend-architect` |
| PostgreSQL/concurrency/migration | `database-reliability` |
| binding code gate | `code-reviewer` |
| realtime/external provider/deployment | `sre` |
| receptionist/patient UI | `persona-walkthrough` |
| external healthcare narrative | `healthcare-innovation-strategist` |

The same actor may perform multiple non-conflicting advisory overlays, but every active specialist lane must be backed by an explicit actor lease and a binding gate must remain independently eligible.

## 3. Orthogonal review rule

Parallel specialist reviews must answer different questions. Example for a transfer feature:

- implementer with `backend-architect`: is the design internally coherent?
- secondary verifier with `database-reliability`: can concurrent state transitions corrupt it?
- gate with `code-reviewer`: does the exact implementation satisfy the full contract?
- experience QA with `persona-walkthrough`: can receptionist/patient users understand the resulting flow?

Do not create multiple generic reviews for reviewer-count theater.

## 4. Severity normalization

Overlay reviews use the canonical Tabibi finding severities from `AGENTS.md`:

- `BLOCKER` — unsafe to merge: severe correctness, security, privacy, data-loss, or direct core-spec violation.
- `MAJOR` — material defect requiring resolution before acceptance.
- `MINOR` — real issue that does not invalidate the feature.
- `NOTE` — suggestion, ambiguity, or future improvement.

No alternate severity vocabulary may be used in a binding review artifact. Required CI failures remain independently blocking.

## 5. Exact-SHA and material-authorship gating

A binding gate must include:

- PR number;
- exact head SHA;
- overlay id;
- reviewer actor;
- canonical verdict (`PASS`, `PASS_WITH_MINOR_FINDINGS`, or `CHANGES_REQUIRED`);
- whether merge is ready.

Any code-changing commit invalidates a previous exact-SHA binding gate. Documentation-only changes may use existing zero-drift rules only when governance evidence explicitly proves no reviewed product/test drift.

Reviewer independence is based on **material authorship**, not commit metadata alone. Before assigning a failover gate, orchestration must check whether the candidate authored or materially modified the reviewed diff. Replayed/cherry-picked/equivalent patches do not launder authorship: if a candidate authored a commit whose tree or stable patch content is materially equivalent to the current head changes, that candidate is ineligible to be the sole binding reviewer even when the literal head SHA or committer differs. When provenance is ambiguous, treat the candidate as non-independent and select another reviewer.

## 6. Failover

When an actor is unavailable, orchestration may move the task to another eligible actor while preserving the same overlay.

Example:

`claude + code-reviewer` unavailable -> `codex + code-reviewer` only if Codex neither authored nor materially modified the reviewed diff under the material-authorship rule above.

If no eligible actor remains, supplemental tools (CodeRabbit/Qodo/council) may advise, but they do not silently become binding gates unless the owner/governance explicitly promotes them for that work unit.

## 7. Persona acceptance

For patient/receptionist UI, use the default personas in `persona-walkthrough.md` unless the feature requires a more specific one. A persona finding becomes a product blocker only when it identifies a concrete usability, accessibility, privacy, localization or recoverability failure against the work-unit contract.

## 8. Healthcare boundary

Healthcare overlays are strategic/evidence disciplines, not medical decision-makers. Tabibi must not add diagnosis, clinical triage, treatment recommendation or medical priority rules merely because a healthcare profile suggests them. Any expansion into clinical decision support requires a separately approved product/safety/regulatory workstream.

## 9. Provenance and updates

The curated overlays are adapted from `NTinkicht/agency-agents` pinned at commit `647c8baa42b6842afb4a97bf2c0950d45ba88e8b`.

Upstream changes are opt-in. To update:

1. inspect upstream diff;
2. decide whether behavior helps Tabibi;
3. adapt rather than blindly copy;
4. update `registry.json` commit;
5. review the governance change through a normal PR.

## 10. Definition of done for overlay adoption

The system is considered adopted when:

- curated profiles and registry are on `main`;
- the mandatory startup path requires this protocol and the selected profile(s) to be read;
- new substantial work units declare actor-backed overlay assignments plus all mandatory role leases;
- specialist findings use canonical Tabibi severities and verdicts;
- binding review respects exact-SHA and material-authorship independence;
- no overlay creates duplicate implementation streams.
