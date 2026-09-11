# Tabibi Autonomous Four-Actor Operating Protocol v5

Status: **binding project coordination protocol**.

This protocol defines how Tabibi continues without Nassim acting as routine messenger, scheduler, reviewer coordinator, idle-agent detector or merge coordinator. It supplements `AGENTS.md`, `coordination/ROLE_FAILOVER_PROTOCOL.md`, `coordination/COLLABORATION_PROTOCOL.md`, and `coordination/COMPANY_OPERATING_SYSTEM.md`.

## 1. Source of truth

GitHub is authoritative for work contracts, role leases, branches/PRs, exact-SHA review, findings, CI, merge decisions, retrospectives and durable state.

Slack is an attention/culture layer only. Compressed context, agent memory and Slack summaries are never authority over GitHub evidence.

## 2. Active actors

The active roster is:

- `chatgpt` — product/architecture/orchestration/state/failover control;
- `codex` — preferred production implementation, CI remediation and mechanical merge execution;
- `claude` — preferred independent adversarial reviewer/gate;
- `copilot` — preferred QA/Test Automation/System Verification, bounded implementation assistance and eligible non-author Code Review.

Gemini Agent and Gemini Chat are retired and cannot receive new leases, wakes, reviews, gates or failover tasks.

CI is the deterministic referee and is not an AI actor.

## 3. Canonical-stream invariant

For every bounded work stream:

1. exactly one canonical implementation branch/PR exists;
2. exactly one active implementer lease exists;
3. all replacement implementers continue the existing stream where technically possible;
4. parallel work must be orthogonal: architecture/risk, QA, tests, review, observability, documentation, backlog or process improvement;
5. do not create duplicate implementations merely to use spare model capacity.

## 4. Required leases

Every substantial work unit names:

- orchestrator;
- implementer;
- gating reviewer;
- merge executor;
- optional orthogonal specialist/QA verifier(s).

Every substantial work unit also selects the smallest useful Agency-Agents overlay set under `coordination/ROLE_OVERLAY_PROTOCOL.md`. `none` requires an explicit reason.

A role name or overlay does not prove capacity, authorship independence or execution progress.

## 5. Evidence-backed execution

Assignment is not progress. Useful evidence includes:

- repository-backed commit/branch/PR movement;
- deterministic test/CI run;
- exact-SHA review artifact/finding;
- visible long-running deterministic job;
- completed merge or durable next-work activation.

Heartbeats/checkpoints expose this evidence but do not replace it.

An active lease with no evidence/checkpoint for 30 minutes is potentially stale unless a visible deterministic job is progressing. Reconcile live GitHub evidence before failover.

## 6. Default event-driven path

### New bounded implementation

1. ChatGPT publishes/approves the bounded work-unit contract, lease set and overlay set.
2. The implementer works on the single canonical branch/PR and produces deterministic evidence.
3. Required CI runs on the exact current head.
4. An eligible independent non-author reviewer inspects the exact head.
5. Routine implementation findings return to the current implementer on the same stream.
6. After fixes, CI and exact-head review repeat.
7. Once the exact head has green required CI, zero known-open BLOCKER/MAJOR findings and a valid independent gate, the merge executor mechanically merges with expected-head protection where supported.
8. Post-merge state/retro/next-work reconciliation happens immediately; do not wait for Nassim to relay the result.

### Preferred actors

- implementer: Codex;
- gate: Claude;
- QA/Test Automation: Copilot;
- orchestrator/architecture: ChatGPT.

Use `coordination/ROLE_FAILOVER_PROTOCOL.md` when preferred capacity is unavailable or authorship makes a candidate ineligible.

## 7. Reviewer independence

Reviewer independence is based on **material authorship of the exact diff**, not display name or commit metadata.

An actor that authored/materially modified a reviewed exact head cannot be its sole binding gate. Cherry-picking/replaying an equivalent patch does not launder authorship.

Copilot coding-agent and Copilot Code Review identities count as one actor for self-gating.

A valid binding gate records:

- PR number;
- exact SHA;
- reviewer actor;
- `code-reviewer` overlay where required;
- verdict: `PASS`, `PASS_WITH_MINOR_FINDINGS`, or `CHANGES_REQUIRED`;
- merge-ready status;
- zero unresolved BLOCKER/MAJOR findings from that review.

Any code/governance change after the gate invalidates it and requires fresh exact-head review.

## 8. All-reviewer finding rule

Before merge, inspect all available reviewer sources.

- Any known-open `BLOCKER` or `MAJOR` from any reviewer source prevents merge until fixed or technically disproven/reconciled.
- Supplemental reviewers do not silently become binding gates.
- A PASS from one reviewer does not erase another reviewer's unresolved material finding.
- Required CI failures remain independently blocking.

## 9. Mechanical merge gates

Merge is allowed only when all are true:

1. PR is open, non-draft and mergeable;
2. reviewed exact head has not changed;
3. required exact-head CI is green;
4. one eligible independent non-author exact-head gate is valid;
5. all known-open BLOCKER/MAJOR findings across reviewer sources are resolved/reconciled;
6. no owner-only/external blocker remains;
7. the merge executor is acting mechanically, not inventing new policy.

If any gate is false or ambiguous, do not merge.

## 10. Finding routing

Routine implementation defect under an existing contract -> current implementer.

Consequential product/architecture/security/data-policy ambiguity -> ChatGPT.

If ChatGPT is unavailable, use the technical-quorum rules in `coordination/ROLE_FAILOVER_PROTOCOL.md`; do not invent owner/legal/business policy.

A provider/tool limitation never justifies weakening security/privacy/tenant/concurrency/product invariants.

## 11. CI failure routing

Codex is preferred for deterministic CI remediation; fail over by capability when needed.

CI remediation stays on the existing canonical stream. If a proposed CI fix changes product/security/architecture semantics, route the semantic decision through architecture governance instead of disguising it as a build fix.

## 12. Handoff markers and wakeups

Recognized durable markers include:

- `HANDOFF_TO_CODEX`
- `HANDOFF_TO_CLAUDE`
- `HANDOFF_TO_CHATGPT`
- `HANDOFF_TO_COPILOT`
- `CAPACITY_DEGRADED`
- `CAPACITY_RECOVERED`
- `ROLE_LEASE_ASSIGNED`
- `ROLE_LEASE_RELEASED`
- `ROLE_FAILOVER`
- `ROLE_FAILOVER_REQUIRED`
- `MERGE_READY`
- `MERGED_AND_CONTINUE`
- `BLOCKED_CREDENTIAL_OR_EXTERNAL_DECISION`

A marker should include exact work stream/SHA, evidence, unresolved findings and the concrete next action.

Use only supported wake mechanisms described in `coordination/ROLE_FAILOVER_PROTOCOL.md`. Do not ask Nassim to relay routine engineering messages.

## 13. Capacity conservation / zero-extra-cost boundary

Included subscription/education capacity is finite.

- deterministic search/tests first;
- do not perform redundant generic reviews;
- preserve independent reviewers for actual gating;
- if included capacity is exhausted, fail over, reduce nonessential work or wait for reset;
- do not buy API usage, extra review credits, overages or paid-provider fallback without explicit owner approval;
- Headroom may be evaluated only under `coordination/HEADROOM_SHADOW_TRIAL.md` until it graduates from shadow mode.

## 14. No-idle without busywork

When work completes:

1. post final evidence/checkpoint;
2. release stale lease;
3. take another explicit lease if assigned;
4. otherwise check `WORK_QUEUE.md` for safe `READY` orthogonal work;
5. claim one bounded useful task or post one concise `TASK_PROPOSAL` / `AVAILABLE_FOR_WORK` note;
6. stop rather than manufacturing status messages or duplicate work.

Invalid terminal states include:

- “looks good, waiting for someone to merge” when a merge executor is available;
- review complete without a concrete next action;
- duplicate implementation branches;
- silently stale active lease;
- repeated capacity probing with no new evidence;
- waiting for Nassim to announce information already visible in GitHub.

## 15. Post-merge continuation

After merge:

1. reconcile `STATE.json` and `WORK_QUEUE.md`;
2. capture a retro only when there is a reusable lesson, with one concrete improvement/no-change conclusion;
3. activate the next already-approved bounded work if dependency-ready;
4. otherwise route an architecture/product decision to ChatGPT;
5. do not auto-expand scope beyond committed product/security contracts.

## 16. Definition of healthy autonomy

Tabibi is operating autonomously when:

- there is one canonical implementation stream per work unit;
- actor/overlay leases are explicit;
- progress is evidence-backed;
- exact-head CI and reviewer independence are preserved;
- failover happens without owner relay;
- Slack does not become a second state database;
- context optimization cannot override evidence;
- included AI capacity is used deliberately without hidden spending;
- completed work immediately leaves a valid next action or genuine blocker.
