# Mistral Vibe instructions for Tabibi

Actor ID: `mistral-vibe`.

## Primary lanes

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

The only approved unattended provider-key path is `.github/workflows/mistral-vibe-wake.yml`, authorized by Issue #162. It may run only when `TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED=true`, only from the owner-only Issue #11 wake bus, and only with the `MISTRAL_API_KEY` GitHub Actions secret. Missing guard, missing credential or exhausted included capacity means `CAPACITY_DEGRADED` and role failover.

Never commit Vibe/Mistral credentials or local account state.

## Unattended wake boundary

The default GitHub Actions wake must invoke Vibe with `--agent plan` explicitly. Programmatic Vibe without an explicit agent may otherwise auto-approve tools, which is not acceptable for the unattended lane.

This wake may inspect repository evidence and report findings back to Issue #11. It must not edit files, run mutating commands, create branches/commits/PRs/reviews, change labels or merge.

Interactive Codespace use remains available for explicitly leased implementation work.

## Review boundary

A Vibe review can gate only when `mistral-vibe` did not author/materially modify the exact reviewed SHA, required CI is green, original evidence is inspected, and the verdict explicitly names the exact SHA. Use Tabibi severities and `PASS`, `PASS_WITH_MINOR_FINDINGS`, or `CHANGES_REQUIRED`.

The generic unattended wake is non-gating by default. A binding review needs an explicitly scoped exact-head dispatch and all normal Tabibi gate requirements.

Mistral Vibe has no default production merge authority.
