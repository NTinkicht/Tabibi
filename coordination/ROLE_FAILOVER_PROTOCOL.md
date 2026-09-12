# Tabibi Capability-Resilient Six-Actor Failover Protocol v8

Status: **binding project coordination protocol**.

## Objective

Tabibi must keep moving when an actor/capability is unavailable because of quota, authentication, runtime errors, outages, tool restrictions or latency, without duplicating healthy work or buying fallback capacity.

Roles belong to the project, not permanently to an actor.

Active actors: `chatgpt`, `codex`, `claude`, `copilot`, `gemini-cli`, `mistral-vibe`.

Retired historical actors: `gemini_agent`, `gemini_chat`. They are never failover candidates.

The machine-readable source for supported capabilities and preference order is `coordination/ACTOR_REGISTRY.json`.

## Capability model

Availability is recorded per actor and capability, not vaguely per provider. Relevant capabilities include orchestration, architecture, implementation, review, QA/system verification, CI remediation, documentation, research/scouting, long-context analysis and merge execution.

An actor may be `available`, `degraded`, `limited` or `unavailable` for a specific capability.

## Role leases

Every active work unit or PR has explicit leases for:

1. orchestrator;
2. implementer;
3. gating reviewer;
4. merge executor;
5. optional orthogonal specialist/QA verifier.

Hard rules:

1. One active implementer per work stream.
2. One canonical PR per work stream unless replacement is explicitly authorized.
3. No self-gating: a material author of the exact head cannot be its sole gate.
4. Reviewer independence follows exact SHA and actor authorship.
5. One authoritative gating verdict per exact SHA; secondary BLOCKER/MAJOR findings still block until reconciled.
6. Do not preempt healthy work merely because a preferred actor recovers.
7. Do not duplicate wakeups after a lease is visibly consumed.
8. A candidate with uncertain spend state is treated as unavailable, not as a reason to enable billing.

## Default routing

Skip a candidate that lacks the capability, is currently unavailable, materially authored the exact head for a review lease, or would require unapproved paid usage.

| Capability/role | Preferred order |
| --- | --- |
| Orchestration/state | ChatGPT -> Claude -> Codex -> Mistral Vibe -> Gemini CLI -> Copilot |
| Product/technical architecture | ChatGPT -> Claude -> Mistral Vibe -> Codex -> Gemini CLI -> Copilot |
| Implementation | Codex -> Claude -> ChatGPT -> Mistral Vibe -> Copilot -> Gemini CLI |
| Independent exact-head review | Claude -> ChatGPT -> Codex -> Gemini CLI -> Mistral Vibe -> Copilot Code Review |
| QA/system verification | Copilot -> Gemini CLI -> Claude -> Mistral Vibe -> ChatGPT -> Codex |
| CI remediation | Codex -> Claude -> ChatGPT -> Mistral Vibe -> Copilot |
| Documentation/state synthesis | ChatGPT -> Gemini CLI -> Mistral Vibe -> Claude -> Codex -> Copilot |
| Research/scouting | Gemini CLI -> ChatGPT -> Claude -> Mistral Vibe -> Codex -> Copilot |
| Long-context analysis | Gemini CLI -> Claude -> ChatGPT -> Mistral Vibe -> Codex -> Copilot |
| Mechanical merge execution | Codex -> ChatGPT -> Claude -> Copilot |

Use `node scripts/actor-router.mjs <capability> ...` for deterministic candidate selection, then reconcile live evidence before assigning the lease.

## Architecture failover

If ChatGPT architecture capacity is unavailable:

- deterministic interpretation of committed contracts may be resolved by one eligible technical actor;
- a genuinely new/consequential architecture decision requires two available technical actors to agree independently;
- the current implementer cannot be the only independent basis for approving its own design;
- owner-only matters remain owner-only: new spending, legal/business policy, unavailable external credentials and irreversible destructive production actions.

## Failover triggers

A lease may fail over after concrete evidence of explicit quota/usage limit, authentication failure not repairable in the bounded run, provider/runtime outage, tool permission mismatch, bounded runtime/time-limit failure, no artifact after supported wake attempts and live reconciliation, stale lease with no actual branch/PR/CI/job movement, or an explicit `CAPACITY_DEGRADED`/`ROLE_FAILOVER_REQUIRED` marker.

A slow response alone is not enough. Reconcile live evidence first.

## Failover procedure

1. Record `CAPACITY_DEGRADED` for the specific actor/capability.
2. Record current lease, PR/branch/SHA, findings, authorship and CI state.
3. Release only the affected lease.
4. Run deterministic candidate routing with authors/unavailable exclusions.
5. Select the first concretely eligible included-capacity candidate.
6. Record `ROLE_FAILOVER` and `ROLE_LEASE_ASSIGNED` with the bounded task and existing stream.
7. Wake/run the replacement through a supported mechanism.
8. Continue the existing branch/PR; do not restart completed work.
9. When the original actor recovers, record `CAPACITY_RECOVERED` without preempting healthy replacement work.

## Supported wake/run mechanisms

- ChatGPT: active orchestration turn/repository reconciliation.
- Codex: executable `@codex ...` instruction/assignment when included capacity is available.
- Claude: persistent Claude Code review/session handoff; do not assume the stateless Action is available.
- Copilot: `@copilot ...`, coding-agent assignment and/or GitHub Code Review request.
- Gemini CLI: interactive `gemini` CLI in the owner's Codespace/local environment. Repository-wide unattended Gemini API-key automation is not authorized.
- Mistral Vibe: interactive `vibe` CLI in the owner's Codespace/local environment. PAYG/API-key automation is not authorized.

A durable marker without a supported executable path is not a complete handoff.

## Review resilience

The project requires an independent actor, not one particular model. Review candidates are filtered by exact-head authorship first.

A valid review artifact explicitly identifies the actor and exact SHA, reports findings using Tabibi severity, checks required CI and ends with a verdict. The GitHub account posting an artifact may be the owner's account when a local CLI is used; actor identity and material authorship must be stated in the artifact.

High-risk authentication, authorization, tenant-isolation, secret handling, destructive migration or concurrency work should receive a second independent review when another eligible actor is concretely available.

## Implementation resilience

Replacement developers inherit existing scope, tests, findings, branch history and CI obligations. Gemini CLI is last-resort implementation capacity by default because its primary value is scouting/analysis; Mistral Vibe is preferred ahead of Copilot for bounded developer-reserve work. Neither new actor gets production merge authority merely because it can edit files.

## Merge resilience

`MERGE_READY` authorizes the merge role, not an identity. Any eligible merge-capable actor may mechanically merge the unchanged reviewed exact head after all gates pass. `gemini-cli` and `mistral-vibe` are not default merge executors.

## Capacity conservation

- Deterministic repository evidence before model context.
- Do not spend review capacity on redundant generic reviews.
- Do not assign multiple actors to the same routine implementation.
- Use Headroom only under its shadow-mode rules.
- Gemini local free/non-billable allowance only; if billing state is uncertain, mark unavailable.
- Mistral existing subscription only with PAYG disabled.
- Never introduce paid fallback because included capacity is exhausted.

## Healthy six-actor mesh

The system is healthy when every active role has exactly one valid lease, no work stream has duplicate implementation PRs, every exact head has an eligible independent reviewer, capacity limits trigger bounded failover, CI remains objective, GitHub is authoritative, retired actors are never routed, and no actor waits for Nassim to relay routine state.
