# Tabibi AI Capacity Policy

## Purpose

Tabibi operates under a fixed owner-approved AI budget. Only capabilities already included in Nassim's active subscriptions/entitlements or explicitly non-billable free allowance may be used. Capacity exhaustion is an engineering constraint, not permission to spend more.

## Financial circuit breaker

Unless Nassim makes a new explicit owner decision, the following are forbidden:

- additional paid AI usage;
- OpenAI API/pay-as-you-go credits;
- Anthropic API/usage credits;
- OpenRouter or another metered model gateway;
- GitHub Copilot paid overage/additional usage;
- paid Gemini API/Vertex AI billing;
- Mistral PAYG/overage or separately funded API credits;
- automatic top-ups, paid fallbacks or silent substitutions that can incur cost.

No workflow, script, scheduled task, hook or actor may create a billing commitment on the owner's behalf.

## Approved capacity

- **ChatGPT Plus / ChatGPT:** orchestration, architecture, state reconciliation and failover.
- **Codex included capacity:** primary implementation, tests, refactors, CI remediation and merge execution.
- **Claude Pro / Claude Code:** adversarial review, security/privacy/authorization, concurrency/data-integrity analysis and difficult debugging.
- **GitHub Copilot education entitlement:** coding assistance, QA/Test Automation, eligible non-author Code Review and explicitly budgeted local context compression.
- **Gemini CLI (`gemini-cli`):** only the owner's already-configured free/non-billable allowance. A Gemini API key may be used by the dedicated owner-only wake workflow only when `TABIBI_GEMINI_ZERO_BILLING_CONFIRMED=true`; no Vertex AI or paid Gemini tier is authorized.
- **Mistral Vibe (`mistral-vibe`):** the owner's existing included Mistral plan allowance only. The dedicated owner-only wake workflow may use a Vibe/API credential only when `TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED=true`; PAYG/overage must remain disabled.
- **Headroom:** local read-only shadow compression under `HEADROOM_SHADOW_TRIAL.md`.
- **Shell/Git/CI:** first choice for search, indexing, diffs, tests and logs.

## Credential boundary

Gemini/Mistral credentials are runtime credentials, not repository assets.

- Never commit API keys, OAuth material, `.gemini/`, `.vibe/`, `.mistral/` or generated auth files.
- `GEMINI_API_KEY` is permitted only in `.github/workflows/gemini-cli-wake.yml`, guarded by `TABIBI_GEMINI_ZERO_BILLING_CONFIRMED=true` and an owner-only Issue #11 event trigger.
- `MISTRAL_API_KEY` is permitted only in `.github/workflows/mistral-vibe-wake.yml`, guarded by `TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED=true` and an owner-only Issue #11 event trigger.
- `GOOGLE_API_KEY`, Vertex AI and other billable Gemini routes remain forbidden in active workflows.
- The dedicated unattended wake workflows are read-only actor lanes: they may inspect repository evidence and return findings, but may not edit, commit, push, merge, label, create reviews or mutate GitHub state.
- Issue #162 is the scoped owner authorization for these two unattended wake paths only; it is not blanket authorization for provider-key automation elsewhere.
- Do not paste credentials into issues, PRs, Team Room, Slack or model prompts.

## Deterministic-first context budget

Use the cheapest safe evidence level:

1. cache/index;
2. deterministic Git/`rg`/diff/path/symbol/bounded slices;
3. verified local Headroom shadow for non-sensitive context when suitable;
4. optional explicitly enabled included-capacity compression;
5. strong subscribed actor with the smallest adequate evidence set.

A strong actor may always request more original evidence when correctness requires it.

## Fail-closed degradation

- Gemini guard missing, quota exhausted, credential unavailable or billing uncertainty -> `CAPACITY_DEGRADED`; do not switch to paid Gemini/Vertex.
- Mistral guard missing, allowance exhausted or credential unavailable -> `CAPACITY_DEGRADED`; PAYG stays off.
- Copilot compression unavailable -> deterministic retrieval/Headroom/targeted reads.
- Codex implementation limited -> fail over to already-included eligible implementation capacity.
- Claude review limited -> another eligible independent non-author reviewer; never weaken a security/concurrency gate.
- Any provider limit -> deterministic evidence, another included actor, bounded scope reduction or wait for reset.

Never turn `CAPACITY_DEGRADED` into a paid-provider call.

## Copilot context allowance

Copilot context compression remains a finite included resource. Local budget state lives under `.tabibi/`, is gitignored and must be valid/positive before invocation. Units are reserved atomically; concurrent callers cannot consume the same final unit. Ordinary invocation failure refunds under the reservation lock; hard crash remains fail-closed.

## Scheduled-task budget

Scheduled tasks consume capacity. Use event-driven state and shared cooldown/lease signals rather than multiple staggered polling tasks. Quiet Git history alone is not proof of idleness when CI/tests or an active lease exist.

Gemini CLI and Mistral Vibe unattended wakes are deliberately event-driven only. They must not add polling or cron schedules without another explicit owner decision.

## Data/security exclusions

No model/compression route may receive credentials/tokens/private keys, production or patient records/fixtures/exports, notification/webhook/provider payloads containing sensitive operational content, database dumps/backups or other secret-bearing artifacts.

Security/privacy/authorization decisions, architecture verdicts and merge-gate verdicts belong to eligible strong actors plus deterministic original evidence.

## Metrics

Allowed local metrics include request type, files/bytes examined, excerpt size, compression invocation, token estimates, cache status, latency and fallback reason. Do not store full prompts, patient data, secrets or delegated source in metrics.

## Owner authority

Changing this policy to permit additional spending requires a new explicit owner decision. Upgrade/credit/overage offers are not authorization.
