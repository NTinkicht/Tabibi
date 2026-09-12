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
- **Gemini CLI (`gemini-cli`):** only the owner's already-configured free/non-billable local allowance. A local API key is acceptable only when its project cannot generate a bill; uncertainty about billing makes the actor unavailable.
- **Mistral Vibe (`mistral-vibe`):** the owner's existing Mistral subscription allowance only. PAYG/overage must remain disabled.
- **Headroom:** local read-only shadow compression under `HEADROOM_SHADOW_TRIAL.md`.
- **Shell/Git/CI:** first choice for search, indexing, diffs, tests and logs.

## Credential boundary

Gemini/Mistral credentials are local runtime credentials, not repository assets.

- Never commit API keys, OAuth material, `.gemini/`, `.vibe/`, `.mistral/` or generated auth files.
- Active GitHub workflows must not reference `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `MISTRAL_API_KEY`, Vertex AI or other billable Gemini/Mistral routes.
- Unattended provider automation using those credentials requires a separate explicit owner decision and deterministic spend controls.
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

- Gemini quota/billing uncertainty -> `CAPACITY_DEGRADED`; do not switch to paid Gemini/Vertex.
- Mistral allowance exhausted -> `CAPACITY_DEGRADED`; PAYG stays off.
- Copilot compression unavailable -> deterministic retrieval/Headroom/targeted reads.
- Codex implementation limited -> fail over to already-included eligible implementation capacity.
- Claude review limited -> another eligible independent non-author reviewer; never weaken a security/concurrency gate.
- Any provider limit -> deterministic evidence, another included actor, bounded scope reduction or wait for reset.

Never turn `CAPACITY_DEGRADED` into a paid-provider call.

## Copilot context allowance

Copilot context compression remains a finite included resource. Local budget state lives under `.tabibi/`, is gitignored and must be valid/positive before invocation. Units are reserved atomically; concurrent callers cannot consume the same final unit. Ordinary invocation failure refunds under the reservation lock; hard crash remains fail-closed.

## Scheduled-task budget

Scheduled tasks consume capacity. Use event-driven state and shared cooldown/lease signals rather than multiple staggered polling tasks. Quiet Git history alone is not proof of idleness when CI/tests or an active lease exist.

## Data/security exclusions

No model/compression route may receive credentials/tokens/private keys, production or patient records/fixtures/exports, notification/webhook/provider payloads containing sensitive operational content, database dumps/backups or other secret-bearing artifacts.

Security/privacy/authorization decisions, architecture verdicts and merge-gate verdicts belong to eligible strong actors plus deterministic original evidence.

## Metrics

Allowed local metrics include request type, files/bytes examined, excerpt size, compression invocation, token estimates, cache status, latency and fallback reason. Do not store full prompts, patient data, secrets or delegated source in metrics.

## Owner authority

Changing this policy to permit additional spending requires a new explicit owner decision. Upgrade/credit/overage offers are not authorization.
