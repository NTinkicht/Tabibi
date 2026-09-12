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

Use only Nassim's existing Mistral subscription allowance. PAYG/overage must remain disabled. Do not add Mistral API-key automation, fund credits, auto-top-up, or switch to a billable fallback. Quota exhaustion means `CAPACITY_DEGRADED` and role failover.

Never commit Vibe/Mistral credentials or local account state.

## Review boundary

A Vibe review can gate only when `mistral-vibe` did not author/materially modify the exact reviewed SHA, required CI is green, original evidence is inspected, and the verdict explicitly names the exact SHA. Use Tabibi severities and `PASS`, `PASS_WITH_MINOR_FINDINGS`, or `CHANGES_REQUIRED`.

Mistral Vibe has no default production merge authority.
