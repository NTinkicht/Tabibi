# Tabibi Compact Bootstrap

This file is a **startup index**, not a replacement for the authoritative contracts it references. If this index conflicts with `PRODUCT.md`, `ARCHITECTURE.md`, `SECURITY.md`, `AGENTS.md`, or a binding coordination protocol, the source contract wins.

## Startup sequence

Before material work:

1. Read this file.
2. Read current `coordination/STATE.json` and `coordination/WORK_QUEUE.md`.
3. Reconcile the live work unit: issue/PR, exact head, CI, review threads, active leases, and capability state.
4. Retrieve the task-relevant sections of the authoritative contracts listed below. Do not bulk-read unrelated history merely because it exists.
5. Expand context whenever correctness, security, or an unresolved ambiguity requires it.

## Authoritative contract map

- Product behavior and MVP boundaries -> `PRODUCT.md`
- System architecture and module/data boundaries -> `ARCHITECTURE.md`
- Security/privacy/authorization/tenant-isolation rules -> `SECURITY.md`
- Actor roles, leases, independent review, finding severity and no-idle rules -> `AGENTS.md`
- Autonomous owner/escalation policy -> `coordination/AUTONOMY_PROTOCOL.md`
- Capability-specific failover -> `coordination/ROLE_FAILOVER_PROTOCOL.md`
- Team Room/heartbeat/retrospective behavior -> `coordination/COLLABORATION_PROTOCOL.md`
- Work marketplace/company behavior -> `coordination/COMPANY_OPERATING_SYSTEM.md`
- Zero-extra-cost AI policy -> `coordination/AI_CAPACITY_POLICY.md`
- Context routing -> `coordination/CONTEXT_ROUTER.md`

## Non-negotiable engineering invariants

These are reminders; consult the source contracts for full semantics.

- GitHub plus deterministic CI/test evidence is the durable engineering record.
- Exactly one canonical implementation stream and one active implementer lease exist per bounded work unit.
- An actor that materially authored an exact head cannot be its sole gating reviewer.
- Required CI must be green on the exact reviewed/merged head.
- BLOCKER/MAJOR and owner-policy Medium+ findings must be resolved or concretely adjudicated before merge; MINOR findings may be explicitly deferred with rationale when they do not invalidate the feature.
- Failover continues the existing branch/PR whenever technically possible; do not create duplicate implementations to keep an actor busy.
- Tenant isolation, privacy, authorization, concurrency/data integrity, idempotency, and secret handling are never relaxed because a provider/tool is limited.
- Patient-sensitive data, credentials and provider secrets never belong in public logs, review prompts, metrics or context-compression requests.
- Gemini Agent and Gemini Chat remain paused/off-roster until the owner explicitly reactivates them.
- Nassim is not the routine scheduler, message relay, idle detector or merge coordinator.

## Fixed AI budget invariant

Additional paid AI usage is not authorized. No OpenAI API, Anthropic API, OpenRouter, Copilot overage, automatic top-up or other metered fallback may be introduced. Capacity exhaustion must degrade gracefully under `coordination/AI_CAPACITY_POLICY.md`.

## Context-efficiency invariant

Use deterministic retrieval before model retrieval:

`cache/index -> git/rg/diff/bounded slice -> optional explicitly enabled Copilot/Luna compression -> strong actor`

Cheap/compressed context is evidence discovery only. Product/security/architecture decisions, exact-head review verdicts and code changes remain the responsibility of eligible strong actors plus deterministic tests.

## Current-state discipline

Never trust a historical snapshot over live evidence. `STATE.json` and `WORK_QUEUE.md` are coordination aids; PR heads, workflow runs, review threads, issue state and committed code determine transient truth.

For a long-running session, re-check only the state that can have changed instead of re-reading every foundational document from the beginning.