# Tabibi Compact Bootstrap

This is a startup index, not a replacement for authoritative contracts. Source contracts win on conflict.

## Active company

Active actor IDs: `chatgpt`, `codex`, `claude`, `copilot`, `gemini-cli`, `mistral-vibe`.

Retired historical identities: `gemini_agent`, `gemini_chat`. `gemini-cli` is a distinct new actor.

## Startup sequence

Before material work:

1. Read this file.
2. Read current `coordination/STATE.json` and `coordination/WORK_QUEUE.md`.
3. Read `coordination/ACTOR_REGISTRY.json`.
4. Reconcile live issue/PR, exact head, CI, review threads, material authors, active leases, capability state and selected overlay.
5. Read actor-specific guidance when applicable: `CLAUDE.md`, `.github/copilot-instructions.md`, `GEMINI.md`, `VIBE.md`.
6. Retrieve only task-relevant source-contract sections; expand original evidence when correctness/security/review requires it.

## Authoritative contract map

- Product behavior/MVP -> `PRODUCT.md`
- Architecture/data/module boundaries -> `ARCHITECTURE.md`
- Security/privacy/authorization/tenant isolation -> `SECURITY.md`
- Actor roles/leases/review/no-idle -> `AGENTS.md`
- Capability registry/routing -> `coordination/ACTOR_REGISTRY.json`, `coordination/ROLE_FAILOVER_PROTOCOL.md`
- Squads/chapters/guilds/company behavior -> `coordination/COMPANY_OPERATING_SYSTEM.md`
- Owner/escalation -> `coordination/AUTONOMY_PROTOCOL.md`
- Team Room/heartbeat/retro -> `coordination/COLLABORATION_PROTOCOL.md`
- Specialist selection -> `coordination/ROLE_OVERLAY_PROTOCOL.md`, `coordination/WORK_UNIT_TEMPLATE.md`, `coordination/AGENT_PROFILES/registry.json`
- Zero-extra-spend AI policy -> `coordination/AI_CAPACITY_POLICY.md`
- Context routing -> `coordination/CONTEXT_ROUTER.md`
- Headroom shadow -> `coordination/HEADROOM_SHADOW_TRIAL.md`

## Non-negotiable invariants

- GitHub + deterministic CI/test evidence is the durable engineering record.
- Exactly one canonical implementation stream and one active implementer per bounded work unit.
- Material authors cannot sole-gate their exact head.
- Required CI must be green on the exact reviewed head.
- BLOCKER/MAJOR and equivalent Medium+ findings must be fixed/adjudicated before merge.
- Failover continues the existing stream whenever technically possible.
- Tenant isolation, privacy, authorization, concurrency/data integrity, idempotency and secret handling are never relaxed for provider limitations.
- Patient-sensitive data, credentials, provider payloads and production data never belong in public logs/review prompts/compression requests.
- Old Gemini Agent/Gemini Chat remain retired and are never routed.
- Nassim is not the routine scheduler, message relay, idle detector or merge coordinator.

## Fixed budget

No additional paid AI usage is authorized. Gemini uses only free/non-billable local allowance; Mistral Vibe uses only the existing subscription with PAYG disabled. No provider API key belongs in GitHub Actions without a separate owner decision.

## Context efficiency

Use `cache/index -> deterministic retrieval -> verified Headroom shadow when suitable -> explicitly allowed bounded compression -> strong actor`. Compressed context is discovery only; source evidence remains authoritative.

## Current-state discipline

Never trust a historical snapshot over live evidence. `STATE.json`, `WORK_QUEUE.md` and routing preferences are coordination aids; current PR heads, CI, review artifacts, issue state and committed code determine transient truth.
