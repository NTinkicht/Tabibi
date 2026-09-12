# Tabibi Company Operating System v3 - Epic

Tabibi is operated as a small autonomous engineering company. Epic applies a **Spotify-inspired** structure to reduce coordination overhead; it is not a literal copy of Spotify and must not create bureaucracy for its own sake.

## Active roster

- `chatgpt` - product/architecture/orchestration;
- `codex` - primary implementation/CI/mechanical merge;
- `claude` - adversarial review/security/correctness;
- `copilot` - QA/Test Automation and eligible Code Review;
- `gemini-cli` - Repository Intelligence & Regression Scout;
- `mistral-vibe` - Failure & Test Design Analyst.

`gemini_agent` and `gemini_chat` remain retired historical identities. `gemini-cli` is a new actor, not a reactivation.

The goal is to ship the best Algeria-first healthcare operations product possible using already-owned/included capacity, while preserving deterministic CI, independent review and zero-extra-spend boundaries.

## 1. Squads - bounded delivery streams

A squad is a temporary team around one canonical work unit, issue, branch and PR. It dissolves/releases leases when the work is complete.

Every active squad has explicit leases for:

- orchestrator/product-technical direction;
- exactly one implementer;
- independent non-author gating reviewer;
- QA/system verification when useful;
- mechanical merge executor.

Squads are capability-based. A provider is never permanently assigned to a squad role. Failover continues the same stream rather than creating a duplicate branch.

## 2. Chapters - discipline standards

Chapters define reusable engineering standards. They do not own delivery branches or create another queue.

Initial chapters:

- **Architecture & Product Contracts** - product/architecture invariants, APIs and bounded scope;
- **Implementation & CI Reliability** - code quality, deterministic tests, build/integration discipline;
- **Security / Privacy / Tenant Isolation** - authorization, healthcare-sensitive data, secrets, abuse cases;
- **Review & QA** - independent exact-head gating, adversarial/system testing;
- **UX / Accessibility / Localization** - Arabic/French/RTL, mobile, accessibility and patient/receptionist usability.

Chapter standards are expressed through source contracts, tests and role overlays rather than recurring meetings.

## 3. Guilds - cross-cutting advisory overlays

Guilds are optional specialist overlays spanning squads. Useful guild topics include security, localization/RTL, migrations/concurrency, developer productivity/context efficiency, research/scouting and documentation quality.

Guilds are advisory unless a source contract already gives the underlying requirement binding authority. Guild membership never creates a lease, reviewer independence or merge authority.

## 4. Three operating planes

### GitHub = truth

GitHub is authoritative for work-unit contracts, leases, authorship, branch/PR/SHA, CI, review findings, verdicts, merge state, retrospectives and durable lessons.

### Slack = attention/culture

Slack carries concise signals and summaries that point back to GitHub. It is not a second state machine. `#coffee-corner` is optional with no quota or engineering consequences.

### Context efficiency = infrastructure

Use deterministic search/diffs/slices first, then verified local Headroom shadow when suitable, then explicitly allowed bounded compression, then strong actors. Compressed context never becomes evidence or authority.

## 5. Deterministic capacity routing

`coordination/ACTOR_REGISTRY.json` is the machine-readable preference/capability registry. `scripts/actor-router.mjs` deterministically removes inactive/unavailable candidates and material authors for review, then proposes the first eligible actor.

Routing is a proposal, not a lease. Orchestration must reconcile live capability evidence before assignment.

Primary tendencies:

- Delivery: Codex.
- Product/architecture: ChatGPT.
- Adversarial review: Claude.
- QA/system verification: Copilot.
- Repository intelligence/regression scouting: Gemini CLI.
- Failure analysis/adversarial test design: Mistral Vibe.
- Deterministic referee: CI.

These are preferences, not permanent ownership.

### Standing service lanes

Two read-only standing lanes make the additional actors useful without creating duplicate implementation branches:

1. **Gemini CLI - Repository Intelligence & Regression Scout.** Produce bounded repository-wide impact maps, dependency/blast-radius analyses, contract/documentation drift reports, post-merge regression scouts and eligible exact-head reviews. Use the machine capabilities `repository_intelligence` and `regression_scouting`.
2. **Mistral Vibe - Failure & Test Design Analyst.** Produce bounded failure matrices, retry/idempotency/concurrency analysis, CI diagnoses, degraded-mode checks, adversarial test plans and eligible exact-head reviews. Use the machine capabilities `failure_analysis` and `test_design`.

These lanes generate artifacts, not activity theater. A finding that requires code is handed to the active implementer unless the specialist receives an explicit implementation lease.

## 6. Resource utilization without busywork

1. One canonical implementation stream and one active implementer per work unit.
2. Other actors may work only in orthogonal lanes: architecture/risk analysis, QA/test design, security review, observability, documentation, backlog decomposition, research or retrospectives.
3. An actor without a lease checks `WORK_QUEUE.md` for compatible `READY` work.
4. If no useful task exists, post one bounded proposal/availability note and stop.
5. Reviewer independence outranks utilization.
6. Heartbeats/assignments are not progress; commits, tests, CI, review artifacts and merges are evidence.

## 7. Standups without status theater

Each materially active actor posts at most one useful standup per workday unless its assignment changes materially.

```text
STANDUP
actor: <chatgpt|codex|claude|copilot|gemini-cli|mistral-vibe>
date: <YYYY-MM-DD>
yesterday: <evidence>
today: <concrete contribution>
blockers: <none or exact blocker>
risks: <engineering/product risk>
help_wanted: <specific input or none>
team_note: <short lesson>
watercooler: <optional>
```

The canonical record is GitHub Team Room. Slack mirrors only useful summaries.

## 8. Retrospectives must change something

After meaningful merged work or a material coordination/CI incident, capture what worked, what slowed delivery, one lesson and one concrete improvement/test/task/rule change. If there is no useful change, record that conclusion and avoid ceremony.

## 9. Task quality

Every queued task states task ID/goal, owner/claim status, work stream, allowed scope, expected artifact, acceptance evidence, code-change permission, role overlay, reviewer-independence implications and next handoff.

"Look around" is not a task. Exploration must produce a bounded artifact such as a risk map, test matrix, refactor proposal or architecture recommendation.

## 10. Zero-extra-spend company rule

The company uses only existing subscriptions/entitlements/free non-billable allowance. Gemini/Vertex paid billing, Mistral PAYG, OpenRouter, OpenAI/Anthropic API credits, Copilot overage and auto-topups are not authorized. Quota exhaustion triggers failover or wait-for-reset.

Local Gemini/Mistral credentials are never committed or wired into GitHub Actions without a separate owner decision. The only authorized unattended Gemini/Mistral credential paths are the owner-approved guarded Issue #11 workflows described in `AGENTS.md`, `GEMINI.md`, `VIBE.md` and `coordination/ROLE_FAILOVER_PROTOCOL.md`.

## 11. Owner experience

Nassim should not need to reconstruct dozens of conversations or act as an idle-agent detector. `STATE.json`, `WORK_QUEUE.md`, Team Room and live PR/CI/review evidence should tell the story compactly.

## 12. Culture

Be concise, curious, skeptical, kind and evidence-driven. Challenge artifacts and decisions, not personalities. Internal motto: **coffee optional, evidence mandatory.**
