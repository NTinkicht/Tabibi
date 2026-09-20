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

The general unattended READ-ONLY key path is `.github/workflows/mistral-vibe-wake.yml`, authorized by Issue #162. A separate proposed DEFAULT-OFF parent-controlled proposal-to-code path `.github/workflows/mistral-scoped-code-adapter.yml` is allowed only after its independent review/merge, with the new `TABIBI_MISTRAL_CODE_ADAPTER_ENABLED=true` guard, owner-issued current-SHA canonical PR lease and explicit Issue #11 dispatch. The child remains read-only; the trusted parent alone may make bounded file edits, run tests and push a fast-forward onto the SAME PR. No implementation runtime proof is claimed before a live Mistral-authored, CI-green, non-Mistral-reviewed feature PR. It may run only when `TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED=true`, only from the owner-only Issue #11 wake bus, and only with the `MISTRAL_API_KEY` GitHub Actions secret. The wake must fail closed with a precise safe status: missing spend guard is `CONFIG_BLOCKED`, missing/rejected credential is `AUTH_BLOCKED`, rejected Vibe entitlement is `ENTITLEMENT_BLOCKED`, exhausted included allowance is `CAPACITY_DEGRADED`, and unrelated runtime failures must retain their own non-capacity classification. Every blocked state triggers role failover without paid fallback.

Never commit Vibe/Mistral credentials or local account state.

## Unattended wake boundary

The default GitHub Actions wake must enforce the read-only lane deterministically at runtime. Mistral documents `enabled_tools` / `--enabled-tools` as an allow-list for programmatic Vibe. The Tabibi wake therefore exposes **only** `grep` and `read_file`, both in the ephemeral Vibe config and on the CLI, and binds Vibe to the checked-out repository with `--workdir`. Shell, write/edit, MCP and other mutation-capable tools are not available in this lane.

Programmatic Vibe falls back to broad auto-approval when no agent is selected, so the unattended wake must explicitly pass `--agent plan`. Mistral documents `plan` as a read-only agent that auto-approves safe read tools while requests outside the current working directory still require confirmation. The Tabibi lane must never pass `--auto-approve` or `--yolo`. The read boundary is therefore layered: the built-in `plan` agent, the CLI `grep` + `read_file` allow-list, the matching config allow-list, and `--workdir "$GITHUB_WORKSPACE"`. Expanding those tools or weakening the approval mode requires a reviewed governance/code change before use.

The workflow may perform a non-inference Vibe entitlement check before model execution, but it must never print the provider response body or credential. Provider/runtime failures must be reduced to safe classified diagnostics and must not cause paid fallback. Before any model-authored result is posted publicly, the workflow must scrub the literal `MISTRAL_API_KEY` plus common bearer/key renderings as defense in depth.

This wake may inspect repository evidence and report findings back to Issue #11. It must not edit files, run mutating commands, create branches/commits/PRs/reviews, change labels or merge.

Interactive Codespace use remains available for explicitly leased implementation work.

## Trusted exact-head review dispatch (after rollout and live proof)

The GitHub-hosted Issue #11 wake remains read-only. A normal `@mistral-vibe` comment analyzes current `main` and is advisory; do not present that as a PR-head review. For a binding review, an owner-authored comment must contain `@mistral-vibe` plus one copy of the exact marker and fields:

```text
BINDING_EXACT_HEAD_REVIEW
review_pr: <existing canonical PR number>
review_sha: <40-character lowercase current head SHA>
material_authors: chatgpt,codex
```

The example authors are placeholders: identify the actual material actors on the entire reviewed head, not just its GitHub committer. Because owner-dispatched model commits may all appear under `NTinkicht` regardless of the material AI actor, GitHub committer metadata alone CANNOT independently prove model authorship. Binding reviews therefore require every PR commit to carry one explicit owner-committed `Material-Author: chatgpt` / `Material-Author: codex` / other actual actor trailer; trusted parent checks every commit via GitHub PR commits API against the owner dispatch's declared actor set and rejects missing, conflicting or Mistral-authored trailers. Legacy PRs without verifiable trailers may receive advisory Mistral analysis but NOT a binding Mistral gate; amend provenance only through the canonical implementer's legitimate new work, never rewrite a shared branch merely to fabricate history. Never dispatch Mistral to gate a Mistral-authored head. The trusted parent validates an open same-repository PR to main, its exact head, the author declaration and ALL THREE green CI jobs, checks out that SHA without persisted credentials, supplies a bounded actual PR diff and rechecks the PR head after execution. The verdict must be **exactly one standalone line**: `VERDICT: PASS`, `VERDICT: PASS_WITH_MINOR_FINDINGS`, or `VERDICT: CHANGES_REQUIRED`, alongside the complete SHA. A prose substring (for example, `tests passed`) is not a verdict. The verifier uses only the newest CI run/attempt for that SHA and creates evidence exclusively with no-follow, no-overwrite semantics. Any stale head, absent evidence, missing verdict/SHA, self-authorship or quota/entitlement failure blocks the gate. The only GitHub writes are scrubbed response comments to Issue #11 and, for a valid anchored review, the target PR. The model still gets only `plan`, `grep` and `read_file`; it has no commit/push/merge permission. Mistral can produce a review report, not override deterministic CI.

The separate coding/CI-repair adapter remains default OFF until a later reviewed WU implements scoped sole-implementer leases, restricted file ownership, parent-only commits/pushes, test/CI evidence and another actor's non-author gate. Do not represent this read-only review enhancement as the write adapter.

## Review boundary

A Vibe review can gate only when `mistral-vibe` did not author/materially modify the exact reviewed SHA, required CI is green, original evidence is inspected, and the verdict explicitly names the exact SHA. Use Tabibi severities and `PASS`, `PASS_WITH_MINOR_FINDINGS`, or `CHANGES_REQUIRED`.

The generic unattended wake is non-gating by default. A binding review needs an explicitly scoped exact-head dispatch and all normal Tabibi gate requirements.

Mistral Vibe has no default production merge authority.
## Default-off bounded model-to-parent code proposal

When the separate code adapter is enabled and an owner implementation lease is current, Vibe is limited to reading the explicitly named `src/` and `tests/` files and emitting one structured `BEGIN_TABIBI_PATCH_JSON` / `END_TABIBI_PATCH_JSON` object. Each edit names an existing allowed path and one exact unique original text followed by its replacement. Do not edit on disk or execute shell; do not invent test results. The trusted parent rejects model-reported unknown paths, symlinks, repeated paths, credential-bearing content, wrong current SHA, superseded actor lease, missing test edits, deterministic test failures, or oversized changes. Only the parent commits and pushes with an honest `Material-Author: mistral-vibe` trailer. All 3 exact-head CI jobs plus another actor's full independent review remain necessary to merge. No extra spend or routine owner PR approvals.
