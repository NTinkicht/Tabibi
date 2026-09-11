# Tabibi Capability-Resilient Four-Actor Failover Protocol v7

Status: **binding project coordination protocol**. This file supplements `coordination/AUTONOMY_PROTOCOL.md` and supersedes any assumption that a role is permanently tied to one provider.

## Objective

Tabibi must continue progressing when one active actor or capability is temporarily unavailable because of quota, authentication, runtime errors, outages, tool restrictions or latency.

**Roles belong to the project, not permanently to an actor.**

The active actors are ChatGPT, Codex, Claude and GitHub Copilot. Gemini Agent and Gemini Chat were retired by owner decision on 2026-09-11 and are not fallback capacity.

Nassim remains outside routine coordination. A provider limit is not, by itself, an owner escalation.

## Team

### ChatGPT
Default: product architect, security/architecture arbitrator, orchestrator, state reconciler, emergency implementation/merge fallback.

### Codex Cloud
Default: primary developer, deterministic CI fixer, mechanical merge executor.

### Claude
Default: independent adversarial reviewer and merge gate; secondary developer when another independent reviewer is available.

### GitHub Copilot (`copilot`)
Default: QA/Test Automation and system verification; bounded implementation/fix support when explicitly leased; eligible exact-head Code Review only when non-author.

Copilot coding-agent authorship and Copilot Code Review count as one actor for self-gating.

### CI
Non-AI deterministic referee. CI is never replaced by model opinion.

## Capability model

Availability is recorded per actor and capability, not vaguely per provider.

Tracked capabilities include:

- `orchestration`
- `architecture`
- `implementation`
- `review`
- `qa_test_automation`
- `ci_remediation`
- `merge_execution`
- `documentation_state_reconciliation`

An actor may be `available`, `degraded`, `limited` or `unavailable` per capability.

## Role leases

Every active work unit or PR has explicit role leases:

1. `orchestrator_lease`
2. `implementer_lease`
3. `gating_reviewer_lease`
4. `merge_executor_lease`
5. optional orthogonal specialist/QA verifier leases

Hard rules:

1. One active implementer per work stream.
2. One canonical PR per work stream unless replacement is explicitly authorized.
3. No self-gating: an actor that authored/materially modified the exact head cannot be its sole gate.
4. Reviewer independence follows the exact SHA and material authorship.
5. One authoritative gating verdict per exact SHA; secondary BLOCKER/MAJOR findings still block until reconciled.
6. Do not preempt healthy work merely because a preferred actor recovers.
7. Do not duplicate wakeups after a lease is visibly consumed.

## Default assignments and failover order

Skip a candidate that lacks the required capability or would violate independence.

| Role | Preferred | Failover order |
| --- | --- | --- |
| Orchestration/state | ChatGPT | Claude -> Codex -> Copilot |
| Product/technical architecture | ChatGPT | Claude + eligible non-author technical quorum -> Codex + Claude quorum -> Copilot + Claude quorum |
| Implementation | Codex | Claude -> ChatGPT -> Copilot |
| Independent gating review | Claude | ChatGPT -> eligible non-author Codex -> eligible non-author Copilot Code Review |
| QA/Test Automation/system verification | Copilot | Claude -> ChatGPT -> Codex |
| CI remediation | Codex | Claude -> ChatGPT -> Copilot |
| Mechanical merge execution | Codex | ChatGPT -> Claude -> Copilot |
| Coordination/documentation repair | ChatGPT | Claude -> Codex -> Copilot |

### Architecture failover

If ChatGPT architecture capacity is unavailable:

- deterministic interpretation of committed contracts may be resolved by one eligible independent reviewer;
- a genuinely new/consequential architecture decision requires two available technical actors to agree independently;
- the current implementer cannot be the only independent basis for approving its own design;
- owner-only matters remain owner-only: paid-provider commitments, legal/business policy, unavailable external credentials and irreversible destructive production actions.

## Failover triggers

A lease may fail over after evidence of:

- explicit quota/usage/review limit;
- authentication failure not repairable in the bounded run;
- provider/runtime outage;
- tool permission mismatch;
- runtime/time limit after one bounded retry where appropriate;
- no acknowledgement/artifact after supported wake attempts and live reconciliation;
- stale active lease with no actual branch/PR/CI/job movement;
- explicit `CAPACITY_DEGRADED` or `ROLE_FAILOVER_REQUIRED`.

A slow response alone is not enough. Reconcile live evidence first.

## Failover procedure

1. Record `CAPACITY_DEGRADED` for the specific actor/capability.
2. Record current lease, PR/branch/SHA, findings and CI state.
3. Release only the affected lease.
4. Select the first eligible available fallback while preserving reviewer independence.
5. Record `ROLE_FAILOVER` and `ROLE_LEASE_ASSIGNED` with the bounded task and existing stream.
6. Wake the replacement through a supported mechanism.
7. Continue the existing branch/PR; do not restart completed work.
8. When the original actor recovers, record `CAPACITY_RECOVERED` but do not preempt healthy replacement work.

## Recovery behavior

On first successful activity after a known limitation, an actor should:

1. report the recovered capability;
2. read current state and relevant Team Room/PR/CI evidence;
3. post one useful heartbeat/checkpoint;
4. take a vacant eligible lease or remain available without preempting healthy work.

Do not require Nassim to notice that a quota reset occurred.

## Supported wakeups

- Codex: executable `@codex ...` instruction/assignment.
- Claude: persistent Claude review session/handoff markers; other actors do not directly invoke the stateless `@claude` Action under the existing Claude invocation policy.
- Copilot: `@copilot ...`, issue assignment and/or `@copilot review`/GitHub Code Review request.
- ChatGPT: active orchestration turn/repository watch.

A durable marker without a supported wake mechanism is not an executable handoff.

## Review resilience

The project requires independent review, not one specific model.

Normal preference:

1. Claude
2. ChatGPT if non-author
3. Codex if non-author
4. Copilot Code Review if non-author and explicitly reviewing the exact current head

High-risk authentication, authorization, tenant-isolation, secret handling, destructive migration or concurrency work should receive a second independent review when another non-author reviewer is available.

## Implementation resilience

When Codex implementation is unavailable:

1. Claude may implement if another independent reviewer remains available;
2. otherwise ChatGPT may implement;
3. Copilot may take a bounded implementation lease when its coding agent is appropriate and another independent gate remains available.

A replacement developer inherits existing scope, tests, findings, branch history and CI obligations.

## Merge resilience

`MERGE_READY` authorizes a role, not an identity. Any eligible merge-capable actor may mechanically merge the unchanged reviewed exact head after all gates pass.

## Capacity conservation

Capacity is a fixed project resource.

- Do not spend reviewer capacity on redundant generic reviews.
- Do not assign multiple actors to the same routine implementation.
- Prefer deterministic tools/search before model-heavy context reads.
- Use Headroom only as an optional local context-efficiency layer under `coordination/HEADROOM_SHADOW_TRIAL.md` until it graduates from shadow mode.
- Do not introduce paid-provider fallback merely because included capacity is exhausted.

## Definition of a healthy four-actor mesh

The system is healthy when:

- every active role has exactly one valid lease;
- no work stream has duplicate implementation PRs;
- every exact head has an eligible independent reviewer;
- capability limits are recorded specifically and trigger bounded failover;
- CI remains objective;
- active work is visible through evidence-backed checkpoints;
- GitHub is authoritative and Slack is not a second state machine;
- no actor waits for Nassim to relay routine engineering state.
