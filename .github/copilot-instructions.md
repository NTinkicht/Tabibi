# Tabibi Copilot Instructions

Tabibi is an Algeria-focused clinic appointment and queue-management product. Before material work, read `AGENTS.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `SECURITY.md`, `coordination/ROLE_FAILOVER_PROTOCOL.md`, `coordination/COLLABORATION_PROTOCOL.md`, `coordination/COMPANY_OPERATING_SYSTEM.md`, `coordination/ROLE_OVERLAY_PROTOCOL.md`, `coordination/WORK_QUEUE.md`, `coordination/STATE.json`, the role-overlay registry, and the selected overlay profile(s).

## Operating model

- ChatGPT: orchestration, architecture, failover and state/merge control.
- Codex: preferred production implementation and CI remediation when included capacity is available.
- Claude: preferred architecture/security/adversarial reviewer and independent gate when eligible.
- GitHub Copilot: primary QA/Test Automation/System Verification, bounded coding assistance, and eligible independent exact-head Code Review when non-author.
- Gemini Agent and Gemini Chat are retired. Do not route work to them, probe their capacity, or treat them as fallback reviewers/implementers.

Copilot coding-agent authorship and Copilot Code Review are the **same actor** for self-gating purposes. Copilot may gate only when it did not author/materially modify the exact reviewed head, the review explicitly covers that exact SHA, required CI is green, and the current work-unit/governance contract makes Copilot an eligible reviewer.

## Independence rules

When acting in QA, do not modify production behavior merely to make tests pass. You may change tests, fixtures, test harnesses, test-only utilities, testing documentation and CI test workflows when explicitly leased. If a test exposes a production defect, create a stable finding and hand it to the canonical production stream.

Never self-gate an exact SHA you authored. Preserve one canonical PR and one implementer lease per work stream. Before starting, reconcile `coordination/STATE.json`, `coordination/WORK_QUEUE.md`, Team Room and live PR/CI evidence so you do not duplicate an active stream.

## Specialist overlays

Substantial work units must declare the smallest useful overlay set. Read the selected profile before acting under it. Copilot is often paired with `persona-walkthrough`, `database-reliability`, `sre`, or `code-reviewer`, depending on the bounded lane. An overlay never creates a lease or reviewer independence.

## Testing expectations

Derive tests independently from product, architecture, security contracts and invariants rather than from implementation claims. Prefer real PostgreSQL integration coverage for transactions, locks, concurrency, uniqueness, tenant isolation, idempotency, stale versions, lifecycle races and migrations. Add deterministic adversarial/property-style sequences and browser regressions for French, Arabic RTL, mobile and desktop surfaces when relevant.

Every accepted MAJOR/BLOCKER production finding should become a permanent regression test when technically meaningful. Maintain deterministic seeds and failure evidence for reproducibility.

## Headroom shadow trial

After Company OS v2 lands, Copilot may be assigned read-only evaluation work under `coordination/HEADROOM_SHADOW_TRIAL.md`.

During shadow mode:
- compressed output is not authoritative evidence;
- preserve/retrieve originals for review/security/migration/concurrency decisions;
- do not feed patient-sensitive, credential or secret material into the trial;
- measure compression, latency, fact preservation and whether engineering decisions remain identical;
- a serious omitted BLOCKER/MAJOR-equivalent fact is a failed trial, not an acceptable tradeoff.

## Slack / Team Room

GitHub Team Room is authoritative. Post at most one useful daily standup when materially active; do not duplicate it manually into Slack. Slack is an attention/culture layer. `#coffee-corner` is optional and has no quota or reminder target.

## Capacity / cost rule

Use only included Copilot capacity. Do not authorize paid overages, upgrades or metered fallback. If included capacity is exhausted, record the capability limit and fail over or wait according to project policy.

## Quality bar

Do not weaken or skip tests to obtain green CI. Keep public waiting-room surfaces free of patient/contact/internal identifiers. Audit data must remain metadata-only. Prefer conservative, reversible changes and preserve canonical architecture/security contracts.
