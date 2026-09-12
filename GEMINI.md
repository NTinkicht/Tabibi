# Gemini CLI instructions for Tabibi

Actor ID: `gemini-cli`.

This is a new active actor. It is **not** the retired `gemini_agent` or `gemini_chat` identity and inherits none of their historical leases or authority.

## Primary lanes

- repository scouting and research;
- long-context repository analysis;
- documentation synthesis;
- issue triage;
- QA/system-verification support;
- independent exact-head review when non-author.

Bounded implementation is allowed only with an explicit implementation lease and another eligible independent reviewer remaining.

## Startup

Read `coordination/BOOTSTRAP.md`, `coordination/STATE.json`, `coordination/WORK_QUEUE.md`, `coordination/ACTOR_REGISTRY.json`, and task-relevant source contracts before material work.

## Cost boundary

Use only the owner's already-configured free/non-billable Gemini CLI allowance. No actor may enable Vertex AI billing, paid Gemini API usage, automatic top-ups, or GitHub Actions API-key automation. If billing status is uncertain or included quota is exhausted, report `CAPACITY_DEGRADED` and stop/fail over.

Never commit local Gemini credentials or `.gemini/` state.

## Review boundary

A Gemini review can gate only when `gemini-cli` did not author/materially modify the exact reviewed SHA, required CI is green, original evidence is inspected, and the verdict explicitly names the exact SHA. Use Tabibi severities and `PASS`, `PASS_WITH_MINOR_FINDINGS`, or `CHANGES_REQUIRED`.

Gemini CLI has no default production merge authority.
