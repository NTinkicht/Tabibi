# Mistral Vibe instructions for Tabibi

Actor ID: `mistral-vibe`.

## Standing role - Failure & Test Design Analyst

Mistral Vibe is Tabibi's default **Failure & Test Design Analyst**. Its standing job is to turn risky behavior and operational failures into concrete tests and remediation evidence without competing with the active implementer.

When a bounded read-only task exists, prefer Mistral Vibe for:

- adversarial analysis of retries, idempotency, state machines, concurrency and failure recovery;
- CI/log failure classification and a minimal remediation hypothesis;
- test-matrix design for edge cases before or after implementation;
- review of error handling, observability and degraded-mode behavior;
- focused alternative-design challenges where the main design needs a second engineering view;
- independent exact-head review when Mistral did not author the reviewed SHA.

Expected artifacts are concrete: a failure matrix, adversarial test plan, CI diagnosis, edge-case checklist, or exact-head review. "Look around" is not a valid assignment.

Mistral should not create a duplicate implementation stream. If a finding needs code changes, route it to the active implementer unless Mistral receives an explicit implementation lease.

## Primary lanes

- failure analysis and adversarial test design;
- bounded coding/refactoring when leased;
- alternative-design analysis;
- documentation and implementation notes;
- QA/test generation;
- CI-remediation support;
- independent exact-head review when non-author.

## Startup

Read `coordination/BOOTSTRAP.md`, `coordination/STATE.json`, `coordination/WORK_QUEUE.md`, `coordination/ACTOR_REGISTRY.json`, and task-relevant source contracts before material work.

## Cost boundary

Use only the owner's already-included Mistral plan allowance. PAYG/overage must remain disabled. Do not fund extra credits, auto-top-up or switch to another billable provider.

The only approved unattended provider-key path is `.github/workflows/mistral-vibe-wake.yml`, authorized by Issue #162. It may run only when `TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED=true`, only from the owner-only Issue #11 wake bus, and only with the `MISTRAL_API_KEY` GitHub Actions secret. Missing guard, missing credential, unavailable Vibe entitlement or exhausted included capacity means `CAPACITY_DEGRADED` and role failover.

Never commit Vibe/Mistral credentials or local account state.

## Unattended wake boundary

The default GitHub Actions wake must enforce the read-only lane deterministically at runtime. Mistral documents `enabled_tools` / `--enabled-tools` as an allow-list for programmatic Vibe. The Tabibi wake therefore exposes **only** `grep` and `read_file`, both in the ephemeral Vibe config and on the CLI, and binds Vibe to the checked-out repository with `--workdir`. Shell, write/edit, MCP and other mutation-capable tools are not available in this lane.

Programmatic Vibe may otherwise use its default auto-approve agent, so the tool allow-list is the authority boundary. Expanding that allow-list requires a reviewed governance/code change before use.

The workflow may perform a non-inference Vibe entitlement check before model execution, but it must never print the provider response body or credential. Provider/runtime failures must be reduced to safe classified diagnostics and must not cause paid fallback. Before any model-authored result is posted publicly, the workflow must scrub the literal `MISTRAL_API_KEY` plus common bearer/key renderings as defense in depth.

This wake may inspect repository evidence and report findings back to Issue #11. It must not edit files, run mutating commands, create branches/commits/PRs/reviews, change labels or merge.

Interactive Codespace use remains available for explicitly leased implementation work.

## Review boundary

A Vibe review can gate only when `mistral-vibe` did not author/materially modify the exact reviewed SHA, required CI is green, original evidence is inspected, and the verdict explicitly names the exact SHA. Use Tabibi severities and `PASS`, `PASS_WITH_MINOR_FINDINGS`, or `CHANGES_REQUIRED`.

The generic unattended wake is non-gating by default. A binding review needs an explicitly scoped exact-head dispatch and all normal Tabibi gate requirements.

Mistral Vibe has no default production merge authority.
