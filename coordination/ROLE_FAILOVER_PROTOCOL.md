# Tabibi Capability-Resilient Four-Agent Failover Protocol v5

Status: **binding project coordination protocol**. This file supplements `coordination/AUTONOMY_PROTOCOL.md` v4 and supersedes any conflicting assumption that a project role is permanently tied to one AI provider.

## Objective

Tabibi must continue progressing when any AI agent, model, GitHub integration, review service, or capability is temporarily unavailable because of usage limits, authentication failures, runtime errors, service outages, tool restrictions, or latency.

**Roles belong to the project, not to an agent.** ChatGPT, Codex, Claude, and Gemini each have preferred roles, but every technical role is transferable when the preferred agent cannot perform it.

Nassim remains outside routine coordination. A provider limit is never, by itself, a reason to return control to Nassim.

## Team

### ChatGPT
Default: product architect, security/architecture arbitrator, orchestrator, state reconciler, emergency implementation/merge fallback.

### Codex Cloud
Default: primary developer, deterministic CI fixer, mechanical merge executor.

### Claude
Default: independent adversarial reviewer and merge gate; secondary developer when another independent reviewer is available.

### Gemini
Default: experience/QA/system-consistency verifier and second independent reviewer; secondary developer and general-purpose failover runtime.

### CI
Non-AI deterministic referee. CI is never replaced by model opinion.

## Capability model

Availability is recorded **per capability**, not per agent. For example, a Codex code-review quota exhaustion means `review=limited`; it does not imply `implementation=unavailable`.

Capabilities tracked by the project:
- `orchestration`
- `architecture`
- `implementation`
- `review`
- `qa_ux_system_verification`
- `ci_remediation`
- `merge_execution`
- `documentation_state_reconciliation`

An agent may be `available`, `degraded`, `limited`, or `unavailable` for each capability.

## Role leases

Every active work unit or PR has explicit **role leases**. A lease gives exactly one actor authority to perform that role until the lease is completed, relinquished, or failed over.

At minimum an implementation PR has:
1. `orchestrator_lease`
2. `implementer_lease`
3. `gating_reviewer_lease`
4. `merge_executor_lease`

Optional:
5. `secondary_verifier_lease`

### Hard anti-chaos rules

1. **One active implementer per work stream.** Two agents must never independently implement the same work unit unless the first lease is explicitly revoked.
2. **One canonical PR per work stream.** A failover continues the existing branch/PR whenever technically possible; it does not create a duplicate PR merely because the agent changed.
3. **No self-gating.** An agent that authored or materially modified the exact head SHA cannot be the sole gating reviewer of that SHA.
4. **Reviewer independence follows the SHA, not the agent's usual title.** If Claude becomes implementer, Gemini or ChatGPT must take the gating review lease. If Gemini becomes implementer, Claude or ChatGPT must review. If Codex becomes reviewer, it must not have authored that exact head.
5. **Do not preempt healthy work.** A recovered preferred agent does not take a lease back in the middle of an active bounded attempt. Return to the preferred assignment at the next clean handoff boundary.
6. **No duplicate wakeups after acknowledgement.** Once an active run, reaction, branch movement, or explicit acknowledgement proves a lease was consumed, other agents do not start the same role.

## Default assignments and failover order

The first eligible, available actor takes the lease. Skip any candidate that would violate independence or lacks the required GitHub/tool capability.

| Role | Preferred | Failover order |
| --- | --- | --- |
| Orchestration/state | ChatGPT | Claude -> Gemini -> Codex |
| Product/technical architecture | ChatGPT | Claude+Gemini technical quorum -> Claude+Codex quorum -> Gemini+Codex quorum |
| Implementation | Codex | Claude -> Gemini -> ChatGPT |
| Independent gating review | Claude | Gemini -> ChatGPT -> Codex |
| QA/UX/system verification | Gemini | Claude -> ChatGPT -> Codex |
| CI remediation | Codex | Gemini -> Claude -> ChatGPT |
| Mechanical merge execution | Codex | ChatGPT -> Gemini -> Claude |
| Coordination/documentation repair | ChatGPT | Gemini -> Claude -> Codex |

### Architecture failover

When ChatGPT's architecture capability is unavailable:
- routine implementation-contract interpretation may be resolved by one independent reviewer if the committed product/architecture/security documents make the answer deterministic;
- a genuinely new or consequential technical architecture decision requires **two available technical agents to agree independently**;
- the current implementer's vote cannot be the only independent basis for approving its own design;
- owner-only matters remain owner-only: paid-provider commitments, legal/business policy, unavailable external credentials, and irreversible destructive production actions still route to Nassim.

## Failover triggers

A role is eligible for failover when one of these is observed:
- explicit provider/model usage or code-review limit;
- authentication/token failure that cannot be repaired automatically in the current run;
- provider outage or repeated infrastructure failure;
- runtime turn/time limit after one automatic bounded retry or configuration repair;
- tool permission prevents the assigned action and another agent has the required permission;
- two valid executable wake attempts produce no acknowledgement, no active run, and no branch/state movement;
- the assigned agent explicitly posts `CAPACITY_DEGRADED` or `ROLE_FAILOVER_REQUIRED`.

A single slow response is not enough to create duplicate work. The watchdog must first check whether an active run exists.

## Failover procedure

1. Record `CAPACITY_DEGRADED` with the **specific capability** that is affected and evidence, e.g. `codex.review=limited`, not `codex=down`.
2. Record the current role lease, exact PR/branch/SHA, known findings, and CI state.
3. Revoke only the affected lease with `ROLE_LEASE_RELEASED`.
4. Select the first eligible available fallback from the matrix, respecting reviewer independence.
5. Post `ROLE_FAILOVER` and `ROLE_LEASE_ASSIGNED` naming the replacement, exact bounded task, existing branch/PR, and acceptance criteria.
6. Actively wake the replacement with its supported trigger.
7. The replacement reads `PRODUCT.md`, `ARCHITECTURE.md`, `SECURITY.md`, `AGENTS.md`, `coordination/AUTONOMY_PROTOCOL.md`, this file, and `coordination/STATE.json` before acting.
8. Continue the existing work stream. Do not restart completed work.
9. When the original provider recovers, record `CAPACITY_RECOVERED`, but do not preempt an active replacement lease.

## Handoff and capacity markers

Existing v4 markers remain valid. v5 adds:
- `HANDOFF_TO_GEMINI`
- `CAPACITY_DEGRADED`
- `CAPACITY_RECOVERED`
- `ROLE_LEASE_ASSIGNED`
- `ROLE_LEASE_RELEASED`
- `ROLE_FAILOVER`
- `ROLE_FAILOVER_REQUIRED`
- `TECHNICAL_QUORUM_REQUEST`
- `TECHNICAL_QUORUM_ACCEPTED`

Every role-transfer comment names:
- work unit / issue / PR;
- exact branch and SHA when applicable;
- role being transferred;
- old actor and new actor;
- why the old capability is unavailable;
- whether the outage is capability-specific;
- current findings and CI status;
- exact next action;
- executable wake trigger.

## Executable wakeups

- Codex: `@codex ...`
- Claude: `@claude ...` through the repository Claude workflow/subscription
- Gemini: `@gemini-cli /review ...`, `@gemini-cli /verify ...`, or `@gemini-cli /implement ...` through the repository Gemini workflow
- ChatGPT: repository watch / active ChatGPT orchestration turn

A durable marker without a supported wake mechanism is not an executable handoff.

## Review resilience

The project requires **independent review**, not Claude specifically.

Normal preference:
- Claude = gating reviewer
- Gemini = secondary verifier

If Claude review is unavailable, Gemini becomes gating reviewer. If Gemini authored the head, ChatGPT becomes reviewer. Codex may review only when it did not author the exact head and its review capability is available.

For security-sensitive changes involving authentication, authorization, tenant isolation, guest credentials, secret handling, destructive migrations, or concurrency invariants, two independent model reviews are preferred whenever two non-author reviewers are available. A provider limit must not cause a lower-quality agent to rubber-stamp its own work.

## Implementation resilience

The project requires an implementation runtime, not Codex specifically.

When Codex implementation is unavailable:
1. Claude may take the implementer lease and Gemini becomes preferred gating reviewer.
2. If Claude is also unavailable, Gemini may implement and Claude/ChatGPT reviews.
3. If both are unavailable, ChatGPT may implement and Claude/Gemini/Codex reviews when one becomes available.

A replacement developer inherits all tests, findings, branch history, CI obligations, and scope limits. It does not reinterpret the product merely because the runtime changed.

## Merge resilience

`MERGE_READY` authorizes a role, not Codex by identity.

If the preferred merge executor cannot act after the review gate is valid, the next available merge-capable agent may execute the unchanged reviewed merge. The executor does not re-review or alter the head. After merging it must reconcile coordination state and actively continue the next approved work.

## Quota conservation

Agent capacity is a shared project resource.
- Do not spend reviewer quota asking an implementer for redundant reviews when an independent reviewer is already active.
- Do not ask multiple agents to implement the same routine fix.
- Use Gemini's default QA/system role to find cross-cutting issues without consuming Codex implementation capacity.
- Use Claude's adversarial review where it adds independent value.
- Reserve ChatGPT's architectural intervention for decisions that actually need it.
- When one service is limited, reassign only the limited capability rather than abandoning all of that agent's useful capabilities.

## Recovery and rebalancing

At the next clean handoff after `CAPACITY_RECOVERED`, the orchestrator may restore preferred assignments. Recovery must never invalidate an already completed independent review or restart a bounded implementation attempt.

## Definition of a healthy four-agent mesh

The system is healthy when:
- every active role has exactly one valid lease;
- no canonical work stream has duplicate implementation PRs;
- every author has an independent reviewer;
- capability limits are recorded specifically and trigger bounded failover;
- at least one available actor can continue each non-owner technical function;
- CI remains objective;
- no agent waits for Nassim to relay routine engineering state.
