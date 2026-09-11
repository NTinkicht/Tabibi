# Tabibi AI Capacity Policy

## Purpose

Tabibi operates under a fixed owner-approved AI budget. The project may use only capabilities already included in Nassim's active subscriptions/entitlements. Capacity exhaustion is an engineering constraint, not permission to spend more money.

## Financial circuit breaker

The following rules are binding:

- additional paid AI usage: **forbidden**;
- OpenAI API / pay-as-you-go credits: **forbidden**;
- Anthropic API / Claude usage credits: **forbidden**;
- OpenRouter or another metered model gateway: **forbidden**;
- GitHub Copilot paid overage / additional usage: **forbidden**;
- automatic top-ups, paid fallbacks, or silent model substitutions that can incur cost: **forbidden**.

No repository workflow, script, scheduled task, hook, or agent may request a billing commitment on the owner's behalf. If an included allowance is exhausted, the valid outcomes are deterministic tooling, another already-included actor/capability, a bounded reduction in scope, or waiting for the allowance to reset.

## Capacity roles

Use included capacity for the work where it creates the most engineering value:

- **ChatGPT Plus / ChatGPT:** orchestration, architecture, state reconciliation, bounded failover, and consequential cross-agent decisions.
- **Codex included with ChatGPT:** primary implementation, deterministic CI remediation, refactors, tests, and mechanical merge work. Do not spend Codex context on repository-wide bulk reading when deterministic discovery can identify the relevant slice first.
- **Claude Pro / Claude Code:** adversarial exact-head review, security/privacy/authorization, concurrency/data-integrity analysis, architecture challenge, and difficult debugging. Do not use Claude as a routine file finder or log summarizer.
- **GitHub Copilot Education/Pro entitlement:** normal coding assistance, QA/test automation, eligible independent review when non-author, and optional bounded context compression through the CLI.
- **Local shell/Git/CI:** first choice for search, indexing, diffs, file profiling, test execution, and other deterministic work.

Subscription ownership never weakens reviewer-independence, exact-head CI, security, privacy, or product invariants.

## Deterministic-first retrieval budget

Every repository-context request should start at the cheapest safe level:

1. **L0 - cache/index:** reuse fresh local metadata or a content-addressed result when available.
2. **L1 - deterministic retrieval:** `git grep`/`rg`, path/symbol lookup, `git diff`, file metadata, bounded line slices, and deterministic CI/log queries.
3. **L2 - optional Copilot compression:** use GPT-5.6 Luna only when L0/L1 cannot efficiently answer a genuinely broad read question. This layer is explicitly opt-in, read-only, and must be disabled by default.
4. **L3 - strong subscribed actor:** give ChatGPT/Codex/Claude the smallest evidence set needed for real reasoning, implementation, or review.

A strong actor may always request more source evidence when correctness requires it. Token efficiency never outranks correctness or safety.

## Copilot context allowance

Copilot context compression is a finite prepaid resource, not an unlimited API. The router uses percentages rather than assuming a permanent account-specific monthly credit number:

- **0-60% of the owner-designated context allowance:** normal bounded use after deterministic retrieval fails;
- **60-80%:** conservation mode; only genuinely large multi-file questions may use compression;
- **80-100%:** reserve mode; deterministic retrieval is the default and compression is for clear high-value cases only;
- **100% or unknown budget state:** compression is disabled.

The owner may set the local allowance to match the current included entitlement. The repository must never configure a paid-overage budget. Local budget/metrics state belongs under `.tabibi/` and is never committed.

## Fail-closed degradation

When a capability is unavailable or quota-limited:

- Copilot compression unavailable -> L0/L1 deterministic retrieval -> targeted strong-model reads if necessary.
- Codex implementation limited -> continue non-conflicting review/test/design work; fail implementation to an eligible already-included actor only when needed.
- Claude review limited -> use another eligible independent non-author reviewer for ordinary risk; do not weaken a security/concurrency gate merely to keep throughput high.
- ChatGPT/Codex plan pressure -> keep orchestration checks minimal, prefer repository state and deterministic actions, and defer non-urgent model work.

Never turn `CAPACITY_DEGRADED` into a paid-provider call.

## Scheduled-task budget

Scheduled tasks are capacity consumers. A watchdog, when enabled, must inspect only the smallest durable state needed to decide whether intervention is required (normally `coordination/STATE.json`, `coordination/WORK_QUEUE.md`, current PR/CI and recent Team Room signals). It must not re-read the repository or perform broad research on every tick.

Multiple staggered watchdogs require a shared cooldown/lease signal to avoid duplicate assignments. `no commit for 15 minutes` is not sufficient evidence of idleness; running CI, tests, an active lease, or a recent checkpoint can all explain quiet periods.

## Data and security exclusions

No context-compression path may receive:

- `.env` files, credentials, tokens, secrets, private keys, or provider configuration containing secrets;
- production or patient data;
- notification/provider payloads containing patient-sensitive content;
- exports, database dumps, or other sensitive operational artifacts.

The compression layer may inspect repository source code, tests, and non-sensitive documentation only. Security/privacy/authorization decisions, architecture verdicts, and merge-gate verdicts belong to an eligible strong actor and deterministic evidence, never to the compression worker.

## Metrics

Measure efficiency without storing source contents. Allowed local metrics include:

- request type;
- files/bytes examined deterministically;
- bounded excerpt size;
- whether compression was invoked;
- estimated input/output token counts;
- cache hit/miss;
- latency;
- fallback reason.

Do not store prompts, patient data, secrets, or full delegated source in metrics.

## Owner authority

Changing this policy to permit additional spending requires an explicit new owner decision. A provider message offering an upgrade, credits, overage, or usage-based billing is not authorization.