# Tabibi Capability-Resilient Five-Actor Failover Protocol v6

Status: **binding project coordination protocol**. This file supplements `coordination/AUTONOMY_PROTOCOL.md` and supersedes any conflicting assumption that a project role is permanently tied to one AI provider.

## Objective

Tabibi must continue progressing when any AI actor, model, GitHub integration, review service, or capability is temporarily unavailable because of usage limits, authentication failures, runtime errors, service outages, tool restrictions, or latency.

**Roles belong to the project, not to an actor.** ChatGPT, Codex, Claude, Gemini Agent, and Gemini Chat have preferred roles, but every transferable technical role may move when the preferred actor cannot perform it.

Nassim remains outside routine coordination. A provider limit is never, by itself, a reason to return control to Nassim.

## Team

### ChatGPT
Default: product architect, security/architecture arbitrator, orchestrator, state reconciler, emergency implementation/merge fallback.

### Codex Cloud
Default: primary developer, deterministic CI fixer, mechanical merge executor.

### Claude
Default: independent adversarial reviewer and merge gate; secondary developer when another independent reviewer is available.

### Gemini Agent (`gemini_agent`)
Default: experience/QA/system-consistency verifier and second independent reviewer; secondary developer and general-purpose failover runtime. Repository integration is defined in `GEMINI.md` and `.github/workflows/gemini-agent.yml`.

### Gemini Chat (`gemini_chat`)
Default: adaptive generalist peer for architecture critique, implementation, debugging, CI remediation, peer review, retrospectives and cross-module reasoning. It is a distinct actor from Gemini Agent and uses `GEMINI_CHAT.md` plus `.github/workflows/gemini-chat-collaborator.yml`.

Gemini Agent and Gemini Chat may share a model family but **do not share identity, role leases, review authority, heartbeats, authored changes, or accountability**.

### CI
Non-AI deterministic referee. CI is never replaced by model opinion.

## Capability model

Availability is recorded **per actor and capability**, not vaguely per provider. Capabilities tracked by the project:
- `orchestration`
- `architecture`
- `implementation`
- `review`
- `qa_ux_system_verification`
- `ci_remediation`
- `merge_execution`
- `documentation_state_reconciliation`

An actor may be `available`, `degraded`, `limited`, or `unavailable` for each capability.

A failure in `gemini_agent` does not automatically imply `gemini_chat` is unavailable, and vice versa, unless evidence demonstrates a genuinely shared quota or provider boundary.

## Role leases

Every active work unit or PR has explicit **role leases**. A lease gives exactly one actor authority to perform that role until completed, relinquished, or failed over.

At minimum an implementation PR has:
1. `orchestrator_lease`
2. `implementer_lease`
3. `gating_reviewer_lease`
4. `merge_executor_lease`

Optional:
5. `secondary_verifier_lease`

### Hard anti-chaos rules

1. **One active implementer per work stream.** Two actors must never independently implement the same work unit unless the first lease is explicitly revoked.
2. **One canonical PR per work stream.** A failover continues the existing branch/PR whenever technically possible.
3. **No self-gating.** An actor that authored or materially modified the exact head SHA cannot be the sole gating reviewer of that SHA.
4. **Reviewer independence follows the SHA.** A familiar model family is not enough; the reviewer must independently inspect the exact head. Gemini Agent and Gemini Chat count as distinct operational actors but must not rubber-stamp one another.
5. **One authoritative gating verdict per exact SHA.** Only the `gating_reviewer_lease` holder may emit authoritative `MERGE_READY` or a merge-blocking gate for that SHA. Secondary reviewers may add findings, concur, or dissent; any secondary BLOCKER/MAJOR invalidates merge readiness until reconciled.
6. **Do not preempt healthy work.** A recovered preferred actor does not take a lease back mid-attempt.
7. **No duplicate wakeups after acknowledgement.** Once an active run, reaction, branch movement, or explicit acknowledgement proves a lease was consumed, other actors do not start the same role.

## Default assignments and failover order

The first eligible, available actor takes the lease. Skip any candidate that would violate independence or lacks the required GitHub/tool capability.

| Role | Preferred | Failover order |
| --- | --- | --- |
| Orchestration/state | ChatGPT | Claude -> Gemini Chat -> Gemini Agent -> Codex |
| Product/technical architecture | ChatGPT | Claude+Gemini Chat quorum -> Claude+Gemini Agent quorum -> Gemini Chat+Gemini Agent quorum -> Claude+Codex quorum |
| Implementation | Codex | Claude -> Gemini Chat -> Gemini Agent -> ChatGPT |
| Independent gating review | Claude | Gemini Chat -> Gemini Agent -> ChatGPT -> eligible non-author Codex |
| QA/UX/system verification | Gemini Agent | Gemini Chat -> Claude -> ChatGPT -> Codex |
| CI remediation | Codex | Gemini Chat -> Gemini Agent -> Claude -> ChatGPT |
| Mechanical merge execution | Codex | ChatGPT -> Gemini Chat -> Gemini Agent -> Claude |
| Coordination/documentation repair | ChatGPT | Gemini Chat -> Gemini Agent -> Claude -> Codex |

### Architecture failover

When ChatGPT's architecture capability is unavailable:
- deterministic interpretation of committed contracts may be resolved by one independent reviewer;
- a genuinely new or consequential technical architecture decision requires **two available technical actors to agree independently**;
- the current implementer's vote cannot be the only independent basis for approving its own design;
- when possible, prefer a quorum spanning different model families for consequential decisions;
- owner-only matters remain owner-only: paid-provider commitments, legal/business policy, unavailable external credentials, and irreversible destructive production actions still route to Nassim.

## Failover triggers

A role is eligible for failover when one of these is observed:
- explicit provider/model usage or code-review limit;
- authentication/token failure that cannot be repaired automatically in the current run;
- provider outage or repeated infrastructure failure;
- runtime turn/time limit after one automatic bounded retry or configuration repair;
- tool permission prevents the assigned action and another actor has the required permission;
- two valid executable wake attempts produce no acknowledgement, no active run, and no branch/state movement;
- collaboration heartbeat is stale and GitHub reconciliation confirms no real artifact/job progress;
- the assigned actor explicitly posts `CAPACITY_DEGRADED` or `ROLE_FAILOVER_REQUIRED`.

A single slow response is not enough to create duplicate work. Check active runs and evidence first.

## Failover procedure

1. Record `CAPACITY_DEGRADED` with the **specific actor/capability** affected.
2. Record current lease, exact PR/branch/SHA, known findings, and CI state.
3. Revoke only the affected lease with `ROLE_LEASE_RELEASED`.
4. Select the first eligible available fallback from the matrix, respecting reviewer independence.
5. Post `ROLE_FAILOVER` and `ROLE_LEASE_ASSIGNED` naming replacement, exact bounded task, existing branch/PR, and acceptance criteria.
6. Actively wake the replacement using its supported trigger/monitor.
7. The replacement reads all binding product/security/coordination documents and current state before acting.
8. Continue the existing work stream. Do not restart completed work.
9. When the original actor recovers, record `CAPACITY_RECOVERED`, but do not preempt an active replacement lease.

## Handoff and capacity markers

Recognized markers include:
- `HANDOFF_TO_GEMINI`
- `HANDOFF_TO_GEMINI_CHAT`
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
- Claude: persistent Claude review session subscription/heartbeat; other actors do not directly invoke the stateless `@claude` Action
- Gemini Agent: `@gemini-cli /review ...`, `@gemini-cli /verify ...`, `@gemini-cli /implement ...`, or bounded general instruction
- Gemini Chat: `@gemini-chat ...`, `@gemini-chat /implement ...`, `@gemini-chat /fix ...`, `@gemini-chat /merge ...`; low-cost scheduled monitoring also watches active Gemini Chat leases and unresolved Team Room participation
- ChatGPT: repository watch / active ChatGPT orchestration turn

A durable marker without a supported wake mechanism is not an executable handoff.

### Claude Action invocation policy

Two distinct Claude-identified runtimes exist: the **persistent Claude review session** and the separate stateless **`@claude` GitHub Action**. Per Nassim's direct instruction (2026-09-06), other agents/humans do not invoke the Action directly. Route Claude work through `HANDOFF_TO_CLAUDE` / `ROLE_FAILOVER` / `ROLE_LEASE_ASSIGNED`; the persistent Claude session decides whether its Action fallback is needed.

## Review resilience

The project requires **independent review**, not Claude specifically.

Normal preference:
- Claude = gating reviewer
- Gemini Agent = QA/system secondary verifier
- Gemini Chat = additional independent peer/generalist reviewer when useful

If Claude review is unavailable, Gemini Chat becomes preferred gating reviewer, then Gemini Agent, then ChatGPT, then eligible non-author Codex.

If Gemini Chat authored the head, Gemini Chat cannot gate it. If Gemini Agent authored the head, Gemini Agent cannot gate it. High-risk authentication, authorization, tenant isolation, guest credentials, secret handling, destructive migrations, or concurrency work should receive a second independent review when another non-author reviewer is available; prefer cross-model-family diversity when practical.

## Implementation resilience

The project requires an implementation runtime, not Codex specifically.

When Codex implementation is unavailable:
1. Claude may take the implementer lease and another eligible non-author becomes gating reviewer.
2. If Claude is unavailable, Gemini Chat may implement.
3. If Gemini Chat is unavailable, Gemini Agent may implement.
4. If those are unavailable, ChatGPT may implement.

A replacement developer inherits tests, findings, branch history, CI obligations, and scope limits. It does not reinterpret the product merely because the runtime changed.

## Merge resilience

`MERGE_READY` authorizes a role, not an identity.

If the preferred merge executor cannot act after a valid review gate, the next available merge-capable actor may execute the unchanged reviewed merge. The executor does not re-review or alter the head. After merging it must reconcile coordination state and actively continue the next approved work.

## Quota conservation

Agent capacity is a shared project resource.
- Do not spend reviewer quota on redundant reviews when an independent reviewer is already active.
- Do not ask multiple actors to implement the same routine fix.
- Use Gemini Agent primarily for UX/system verification when available.
- Use Gemini Chat as a flexible peer/failover and for cross-cutting reasoning without duplicating an already active lease.
- Use Claude's adversarial review where it adds independent value.
- Reserve ChatGPT architecture intervention for decisions that need it.
- Reassign only the limited capability, not the entire actor, unless evidence supports a broader outage.

## Recovery and rebalancing

At the next clean handoff after `CAPACITY_RECOVERED`, the orchestrator may restore preferred assignments. Recovery never invalidates a completed independent review or restarts a bounded implementation attempt.

## Definition of a healthy five-actor mesh

The system is healthy when:
- every active role has exactly one valid lease;
- no canonical work stream has duplicate implementation PRs;
- every author has an independent reviewer;
- Gemini Agent and Gemini Chat identities remain separate;
- capability limits are recorded specifically and trigger bounded failover;
- at least one available actor can continue each non-owner technical function;
- CI remains objective;
- active work is visible through heartbeats/checkpoints;
- no actor waits for Nassim to relay routine engineering state.
