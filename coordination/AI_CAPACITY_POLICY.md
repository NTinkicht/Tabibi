# Tabibi AI Capacity Policy

## Purpose

Tabibi operates under a fixed owner-approved AI budget. Only capabilities already included in Nassim's active subscriptions/entitlements may be used. Capacity exhaustion is an engineering constraint, not permission to spend more money.

## Financial circuit breaker

The following are binding unless Nassim makes a new explicit owner decision:

- additional paid AI usage: **forbidden**;
- OpenAI API / pay-as-you-go credits: **forbidden**;
- Anthropic API / Claude usage credits: **forbidden**;
- OpenRouter or another metered model gateway: **forbidden**;
- GitHub Copilot paid overage / additional usage: **forbidden**;
- automatic top-ups, paid fallbacks, or silent model substitutions that can incur cost: **forbidden**.

No workflow, script, scheduled task, hook, or agent may create a billing commitment on the owner's behalf. If included capacity is exhausted, use deterministic tooling, verified local Headroom shadow compression, another already-included actor/capability, a bounded reduction in scope, or wait for reset.

## Capacity roles

- **ChatGPT Plus / ChatGPT:** orchestration, architecture, state reconciliation, bounded failover, and consequential cross-agent decisions.
- **Codex included with ChatGPT:** primary implementation, deterministic CI remediation, refactors, tests, and mechanical merge work.
- **Claude Pro / Claude Code:** adversarial exact-head review, security/privacy/authorization, concurrency/data-integrity analysis, architecture challenge, and difficult debugging.
- **GitHub Copilot education entitlement:** normal coding assistance, QA/test automation, eligible independent review when non-author, and optional bounded context compression through the CLI.
- **Headroom fork:** local read-only shadow compression only under `coordination/HEADROOM_SHADOW_TRIAL.md`; no provider call, no authority.
- **Local shell/Git/CI:** first choice for search, indexing, diffs, file profiling, tests, logs, and other deterministic work.

Subscription ownership never weakens reviewer independence, exact-head CI, security, privacy, or product invariants.

## Deterministic-first retrieval budget

Use the cheapest safe level that preserves evidence:

1. **L0 - cache/index:** reuse fresh local metadata or a content-addressed result.
2. **L1 - deterministic retrieval:** `git grep`/`rg`, path/symbol lookup, `git diff`, metadata, bounded slices, deterministic CI/log queries.
3. **L1.5 - verified local Headroom shadow:** optional non-sensitive local compression under its pinned-revision/fidelity rules. It is convenience context, never evidence.
4. **L2 - optional Copilot/Luna compression:** only when L0/L1/L1.5 cannot efficiently answer a genuinely broad read question. Explicit opt-in, read-only, disabled by default.
5. **L3 - strong subscribed actor:** give ChatGPT/Codex/Claude the smallest evidence set adequate for real reasoning, implementation, or review.

A strong actor may always request more original source evidence when correctness requires it.

## Copilot context allowance

Copilot context compression is a finite included resource, not an unlimited API. Local budget state lives under `.tabibi/` and is never committed.

- **0-60% used:** normal bounded use after cheaper retrieval fails;
- **60-80%:** conservation mode;
- **80-100%:** reserve mode;
- **100% used or unknown budget state:** compression disabled.

The router must atomically reserve a unit before invoking Copilot. Concurrent callers may not consume the same final unit. Ordinary invocation failures refund while the exclusive reservation lock is held. A hard process crash is fail-closed: the reserved unit remains consumed; a stale lock may be recovered later without refunding that unit.

The repository must never configure paid overage.

## Fail-closed degradation

- Copilot compression unavailable -> deterministic retrieval -> verified Headroom shadow when suitable -> targeted strong-model reads.
- Codex implementation limited -> safe failover to already-included capacity or non-conflicting work.
- Claude review limited -> another eligible independent non-author reviewer for ordinary risk; never weaken a security/concurrency gate.
- ChatGPT/Codex plan pressure -> minimize repeated context and prefer deterministic repository evidence.

Never turn `CAPACITY_DEGRADED` into a paid-provider call.

## Scheduled-task budget

Scheduled tasks are capacity consumers. A watchdog inspects only the smallest durable state needed to decide whether intervention is required. Multiple staggered watchdogs require a shared cooldown/lease signal. `No commit for 15 minutes` is not sufficient evidence of idleness; running CI/tests, an active lease, or a recent checkpoint can explain quiet periods.

## Data and security exclusions

No model-compression path may receive:

- `.env` files, credentials, tokens, secrets, private keys, or secret-bearing provider configuration;
- production or patient records/data/fixtures/exports;
- notification, webhook, or provider payloads/responses containing patient-sensitive or operational content;
- database dumps/backups or other sensitive operational artifacts.

The deterministic router validates both the requested repository path and its real resolved target, so an in-repository symlink cannot bypass repository-containment or sensitive-path controls.

The compression layer may inspect repository source code, tests, and non-sensitive documentation only. Security/privacy/authorization decisions, architecture verdicts, and merge-gate verdicts belong to eligible strong actors plus deterministic evidence.

## Metrics

Allowed local metrics include request type, files/bytes examined, excerpt size, whether compression was invoked, token estimates, cache hit/miss, latency, and fallback reason. Do not store prompts, patient data, secrets, or full delegated source in metrics.

## Owner authority

Changing this policy to permit additional spending requires a new explicit owner decision. Upgrade/credit/overage offers are not authorization.
