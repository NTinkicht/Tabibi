# Tabibi Compact Bootstrap

This is a startup index, not a replacement for authoritative contracts. If it conflicts with `PRODUCT.md`, `ARCHITECTURE.md`, `SECURITY.md`, `AGENTS.md`, or a binding coordination protocol, the source contract wins.

## Startup sequence

Before material work:

1. Read this file.
2. Read current `coordination/STATE.json` and `coordination/WORK_QUEUE.md`.
3. Reconcile the live work unit: issue/PR, exact head, CI, review threads, active leases, capability state, and selected role overlay.
4. Retrieve the task-relevant sections of the authoritative contracts below. Do not bulk-read unrelated history merely because it exists.
5. Expand original context whenever correctness, security, review, or unresolved ambiguity requires it.

## Authoritative contract map

- Product behavior / MVP boundaries -> `PRODUCT.md`
- Architecture / module / data boundaries -> `ARCHITECTURE.md`
- Security / privacy / authorization / tenant isolation -> `SECURITY.md`
- Actor roles / leases / independent review / findings / no-idle -> `AGENTS.md`
- Owner/escalation policy -> `coordination/AUTONOMY_PROTOCOL.md`
- Capability failover -> `coordination/ROLE_FAILOVER_PROTOCOL.md`
- Team Room / heartbeat / retrospectives -> `coordination/COLLABORATION_PROTOCOL.md`
- Company/work-marketplace behavior -> `coordination/COMPANY_OPERATING_SYSTEM.md`
- Mandatory specialist selection -> `coordination/ROLE_OVERLAY_PROTOCOL.md`, `coordination/WORK_UNIT_TEMPLATE.md`, `coordination/AGENT_PROFILES/registry.json`
- Zero-extra-cost AI policy -> `coordination/AI_CAPACITY_POLICY.md`
- Context routing -> `coordination/CONTEXT_ROUTER.md`
- Local Headroom shadow rules -> `coordination/HEADROOM_SHADOW_TRIAL.md`

## Non-negotiable engineering invariants

- GitHub plus deterministic CI/test evidence is the durable engineering record.
- Exactly one canonical implementation stream and one active implementer lease exist per bounded work unit.
- Every substantial work unit declares its smallest useful role-overlay set; `none` needs an explicit reason.
- An actor that materially authored an exact head cannot be its sole gating reviewer.
- Required CI must be green on the exact reviewed/merged head.
- BLOCKER/MAJOR and equivalent Medium+ findings must be fixed or concretely adjudicated before merge.
- Failover continues the existing branch/PR whenever technically possible.
- Tenant isolation, privacy, authorization, concurrency/data integrity, idempotency, and secret handling are never relaxed because a provider/tool is limited.
- Patient-sensitive data, credentials, provider payloads, and production data never belong in public logs, review prompts, metrics, or model-compression requests.
- Gemini Agent and Gemini Chat are retired from Tabibi. Historical artifacts are evidence only; do not wake, probe, lease, route, or review through them.
- Nassim is not the routine scheduler, message relay, idle detector, or merge coordinator.

## Fixed AI budget invariant

Additional paid AI usage is not authorized. No OpenAI API, Anthropic API, OpenRouter, Copilot overage, automatic top-up, or other metered fallback may be introduced. Capacity exhaustion degrades gracefully under `coordination/AI_CAPACITY_POLICY.md`.

## Context-efficiency invariant

Use:

`cache/index -> git/rg/diff/bounded slice -> verified local Headroom shadow when suitable -> optional explicitly enabled Copilot/Luna compression -> strong actor`

Compressed context is discovery/convenience only. Product/security/architecture decisions, exact-head review verdicts, and code changes remain the responsibility of eligible strong actors plus original evidence and deterministic tests.

## Current-state discipline

Never trust a historical snapshot over live evidence. `STATE.json` and `WORK_QUEUE.md` are coordination aids; PR heads, workflow runs, review threads, issue state, and committed code determine transient truth.

For long sessions, re-check only state that can have changed instead of repeatedly loading every foundational document.
