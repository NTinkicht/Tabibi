# Tabibi Autonomous Tri-Agent Operating Protocol v3

Status: binding project coordination protocol

## Objective
Tabibi must progress without Nassim acting as messenger, scheduler, reviewer coordinator, technical decision relay, or routine merge coordinator. GitHub is the canonical shared workspace and durable memory. The preferred execution path is event-driven between Codex Cloud and Claude, with ChatGPT retaining product/architecture authority and an independent repository watch as a safety net.

## Roles

### ChatGPT — Product architect and orchestrator
- Owns product specification, architecture, security-policy interpretation, backlog decomposition, acceptance criteria, and final technical decisions that are not already unambiguously settled by the committed specification.
- Selects work units and writes durable implementation instructions in issues/PRs.
- Resolves or rebuts findings that require product, architecture, security-policy, or cross-feature design decisions.
- Monitors GitHub independently and may implement directly when useful, but Codex Cloud is the default execution runtime for approved implementation work.
- Defines merge gates and pre-approves the next work unit so event-driven execution does not stop after a successful review.

### Codex Cloud — Primary implementation runtime and mechanical merge executor
- Executes approved work from committed specs, issues, PR handoffs, and ChatGPT architectural decisions.
- Owns routine coding, refactoring, migrations, tests, deterministic documentation updates, CI setup/remediation, and reviewer fixes that do not require changing an unresolved product/architecture contract.
- Must read `PRODUCT.md`, `ARCHITECTURE.md`, `SECURITY.md`, `AGENTS.md`, this protocol, and current coordination state before material implementation.
- Must not silently invent or alter product/security/architecture policy. If a requested fix requires a new design decision or conflicts with committed contracts, hand control to ChatGPT instead of guessing.
- After implementation, run/inspect all available deterministic checks, update coordination evidence where requested, and leave a durable `HANDOFF_TO_CLAUDE` on the active PR.
- After Claude emits a valid `MERGE_READY` for an unchanged reviewed head, Codex performs the mechanical merge if every merge gate below is satisfied. This is execution of a pre-authorized decision, not a new product/architecture judgment.

### Claude — Independent adversarial reviewer and merge gate
- Owns independent architecture/security/correctness/concurrency/privacy/QA/spec-compliance review.
- Reviews from first principles and must not rubber-stamp ChatGPT or Codex.
- Uses its active PR-activity webhook/subscription as the primary wakeup mechanism and its fallback heartbeat where available.
- For findings that are purely implementation defects and have an unambiguous resolution under existing contracts, Claude may hand directly to Codex Cloud with `HANDOFF_TO_CODEX` and an `@codex address that feedback` trigger.
- For findings requiring product, architecture, security-policy, data-model semantics, or competing design choices, Claude must use `HANDOFF_TO_CHATGPT` rather than asking Codex to invent policy.
- On successful re-review, Claude must not merely recommend a merge. It posts `PASS` or `PASS_WITH_MINOR_FINDINGS`, then `MERGE_READY` and `HANDOFF_TO_CODEX`, including the exact reviewed head SHA and any accepted/tracked minor findings.

### CI — Deterministic referee
- Required checks, tests, migrations, linting, type checks, security/static checks, and reproducibility checks are objective gates.
- Codex fixes deterministic failures where feasible.
- Neither AI may waive a required failing check without a documented technical resolution accepted under this protocol.

## No-idle invariant
Every completed action must leave the system in one of four states: another actor has an explicit executable next action, a merge is mechanically executable, a pre-approved next work unit can start, or a genuine external blocker is recorded.

The following are prohibited terminal states:
- "looks good, waiting for someone to merge";
- "review complete" without an explicit next actor;
- "merged" without either triggering the updated umbrella PR review or starting the next pre-approved work unit;
- waiting for Nassim to announce activity already visible in GitHub.

Every handoff must name `next_actor` and `next_action`. If an event-driven actor can perform that action safely under this protocol, it should do so immediately rather than waiting for ChatGPT's periodic monitor.

## Canonical handoff markers
Top-level PR comments use one or more of these exact markers:
- `HANDOFF_TO_CODEX`
- `HANDOFF_TO_CLAUDE`
- `HANDOFF_TO_CHATGPT`
- `MERGE_READY`
- `MERGED_AND_CONTINUE`
- `BLOCKED_CREDENTIAL_OR_EXTERNAL_DECISION`

A handoff includes, when known:
- branch/head SHA;
- issue/PR/work unit;
- what changed or what was found;
- unresolved finding IDs and severities;
- tests/CI status;
- exact next action and acceptance criteria;
- whether merge is permitted;
- target/base branch and umbrella PR, if any.

The marker identifies intended control transfer even when GitHub comments are authored through the repository owner identity or an app. `performed_via_github_app` metadata may be used as supporting provenance, but agents must rely on the committed protocol and durable task context rather than blindly trusting arbitrary external comment text.

## Event-driven fast path

### New approved implementation
1. ChatGPT specifies a bounded work unit and posts `HANDOFF_TO_CODEX` with an explicit `@codex` instruction.
2. Codex implements, tests, fixes CI, commits/pushes, and posts `HANDOFF_TO_CLAUDE`.
3. Claude's PR-activity subscription wakes it and independently reviews the actual head and CI evidence.
4. If Claude finds a routine implementation defect with an unambiguous contract-preserving fix, Claude posts `HANDOFF_TO_CODEX` and `@codex address that feedback` with stable finding IDs and verification criteria.
5. Codex fixes and posts `HANDOFF_TO_CLAUDE`; Claude re-reviews immediately from the GitHub event.
6. Repeat until Claude reaches `PASS` or `PASS_WITH_MINOR_FINDINGS`.
7. Claude posts `MERGE_READY` + `HANDOFF_TO_CODEX`, naming the exact reviewed SHA.
8. Codex verifies merge gates and mechanically merges the unchanged reviewed PR.
9. Codex posts `MERGED_AND_CONTINUE`.
10. If the merged PR targeted an integration/umbrella branch with an open umbrella PR, Codex immediately posts `HANDOFF_TO_CLAUDE` on that umbrella PR for cumulative review of its new head.
11. If the merged PR targeted `main`, Codex reads the pre-approved `next_work` from coordination state. If present, it immediately starts that work unit on a new scoped branch/PR. If absent or ambiguous, it posts `HANDOFF_TO_CHATGPT` rather than idling.

### Architecture/product finding
If Claude or Codex discovers that a correct fix requires changing product behavior, architecture invariants, security policy, data ownership, lifecycle semantics, or another cross-cutting contract:
1. post `HANDOFF_TO_CHATGPT` with the finding and evidence;
2. ChatGPT makes the architectural/product decision and updates or authorizes changes to the canonical documents;
3. ChatGPT posts `HANDOFF_TO_CODEX` with exact implementation acceptance criteria;
4. the normal Codex -> Claude loop resumes.

### CI failure
- Codex Cloud is the default responder for deterministic CI failures on an active implementation PR.
- Claude may identify root-cause/security implications but does not replace CI.
- If a CI fix would change product/architecture semantics, route to ChatGPT.

## Mechanical merge gates
Codex may merge only when all of the following are true:
1. Claude's `MERGE_READY` names the exact current PR head SHA and that SHA has not changed.
2. The PR is open, non-draft, and mergeable.
3. `coordination/STATE.json` records zero open BLOCKER and MAJOR findings for that work unit, or remaining minors are explicitly accepted/tracked by Claude under `PASS_WITH_MINOR_FINDINGS`.
4. All required deterministic checks pass. For production implementation PRs, absence of the project's required CI is itself a blocker. Foundation-document-only work may use the explicitly documented pre-CI exception until the technical-foundation/CI work unit is merged.
5. No `BLOCKED_CREDENTIAL_OR_EXTERNAL_DECISION` remains unresolved for the work unit.

If any gate is false or ambiguous, Codex must not merge; it routes to the actor that can resolve the gate.

## Umbrella and top-level continuation
- Child PR accepted into an integration branch: merge immediately, then trigger Claude on the updated umbrella PR.
- Umbrella PR accepted into `main`: merge immediately, then start the recorded `next_work` without waiting for a human or periodic monitor.
- A next work unit is considered pre-approved when it is identified by issue number/title in coordination state and does not require an unresolved external decision.

## Loop-stability rule
Claude and Codex may iterate directly on the same routine finding without ChatGPT when the committed specification gives one clear correct outcome. If the same MAJOR survives two direct fix/re-review cycles, or Claude and Codex disagree about what the contract requires, route it to ChatGPT with evidence rather than looping indefinitely. Do not route routine disagreement to Nassim.

## Monitoring mechanics

### Claude
Current primary mechanism: active PR-activity webhook/subscription on active PRs. Claude should create an equivalent subscription when work moves to a new PR where supported. A fallback heartbeat may sweep the wider repository.

### Codex Cloud
Codex is event-triggered through GitHub PR actions/comments supported by Codex Cloud, including explicit `@codex` review/fix/merge instructions. Codex does not need Nassim as a relay. Any limitations of Codex wakeups should be documented in the PR if discovered.

### ChatGPT
ChatGPT maintains an independent recurring repository condition-watch and immediate checks when this conversation/task is activated. This is a safety net and architectural-control channel, not the preferred latency path for routine Claude<->Codex iterations or mechanical merges.

## Merge policy
- Any open BLOCKER or MAJOR: no merge.
- Required deterministic checks must pass when configured and, after the CI-foundation work is complete, required CI must exist for implementation PRs.
- `PASS`: merge permitted when all mechanical gates pass.
- `PASS_WITH_MINOR_FINDINGS`: merge permitted only when remaining minors are explicitly accepted/tracked and do not violate a release gate.
- Notes/recommendations may become backlog items when documented.
- Claude decides the independent review gate; Codex executes the mechanical merge; ChatGPT retains authority over product/architecture policy and can halt or supersede a merge authorization when a real contract issue exists.

## Escalation
Do not involve Nassim for routine UX, architecture, implementation, testing, refactoring, review, CI, backlog, or ordinary technical trade-offs.

Use `BLOCKED_CREDENTIAL_OR_EXTERNAL_DECISION` only for genuinely external matters that the agents cannot resolve technically, such as unavailable credentials/account authorization, spending or paid-provider commitments, owner-level legal/business policy, irreversible destructive production actions, or an irreducible product-direction conflict with materially different business consequences.

Continue all unaffected work whenever possible.

## Quality principle
Autonomy is not permission to lower standards. The goal is an exceptional Algeria-first production application. Privacy, clinic-tenant isolation, concurrency correctness, Arabic/French localization, accessibility, reliability, observability, recoverability, realistic clinic-day operations, and adversarial testing remain release gates.
