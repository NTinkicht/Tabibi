# Tabibi Autonomous Multi-Agent Operating Protocol

Status: binding project coordination protocol

## Objective

Tabibi must progress without Nassim acting as a messenger, scheduler, reviewer coordinator, or technical decision relay.

GitHub is the canonical shared workspace and durable memory between ChatGPT and Claude.

## Roles

### ChatGPT
- Product architect and lead implementer.
- Owns product specification, architecture proposals, implementation, tests, CI/CD, backlog decomposition, and resolution of review findings.
- Independently monitors GitHub for new Claude reviews, commits, PR comments, CI changes, and coordination-state changes.
- On receiving Claude findings, evaluates every finding, fixes or technically rebuts it with evidence, adds regression tests where applicable, updates durable coordination state, and hands the result back through GitHub.

### Claude
- Independent adversarial architecture/security/correctness/QA reviewer.
- Must review from first principles rather than rubber-stamping ChatGPT or Codex.
- Independently monitors GitHub for new implementation commits, handoff markers, PR updates, CI results, and requests for re-review.
- On receiving a ChatGPT handoff, reviews the current head, records durable findings in GitHub, and hands control back through GitHub.
- Must not ask Nassim to copy technical findings or status between agents.

### CI / deterministic tooling
- Acts as the objective referee for tests, static checks, migrations, security checks, and reproducibility.
- Neither agent may override a failing required check without a documented technical resolution.

## Autonomous continuity rule

Neither agent may depend on Nassim saying "Claude finished", "ChatGPT finished", "check GitHub", or equivalent.

Each agent is responsible for detecting the other agent's durable GitHub activity and continuing the workflow.

If an agent platform supports recurring monitoring/scheduled tasks, the agent should maintain an independent recurring GitHub watch for this repository.

If an agent platform supports GitHub-event or mention-based wakeups, explicit GitHub mentions and handoff markers are the preferred trigger.

If passive monitoring is temporarily unavailable on one platform, the other agent must still leave a complete durable handoff in GitHub so work can resume immediately on the next activation without user relay.

## Canonical handoff markers

Use a top-level PR comment containing one of these exact markers:

- `HANDOFF_TO_CLAUDE`
- `HANDOFF_TO_CHATGPT`
- `BLOCKED_CREDENTIAL_OR_EXTERNAL_DECISION`

A handoff must include:
- current branch/head SHA if known;
- what changed;
- unresolved findings and severities;
- tests/CI status;
- exact next action requested;
- whether merge is permitted.

## Normal loop

1. ChatGPT selects the next approved work unit and implements it on a branch.
2. ChatGPT runs/updates tests and CI and posts `HANDOFF_TO_CLAUDE` with `@claude` when available.
3. Claude independently reviews the current head and CI evidence.
4. Claude posts stable findings and `HANDOFF_TO_CHATGPT`.
5. ChatGPT fixes or rebuts each finding with evidence and regression coverage.
6. CI verifies the new head.
7. ChatGPT posts a new `HANDOFF_TO_CLAUDE`.
8. Claude re-reviews until `PASS` or `PASS_WITH_MINOR_FINDINGS` under the merge policy.
9. ChatGPT merges only when required gates pass, updates backlog/state, and starts the next vertical slice.

No human relay is part of this loop.

## Monitoring expectations

### ChatGPT monitoring
ChatGPT maintains a recurring repository watch and also performs immediate checks when activated in conversation.

### Claude monitoring
Claude must establish the closest equivalent supported by its environment: recurring repository monitoring, GitHub-event/mention triggers, or another persistent cloud-side watch. Claude should document the mechanism it successfully has available in its next GitHub handoff.

If Claude cannot create an actual persistent monitor in its current environment, it must state that fact in GitHub and rely on explicit `@claude`/handoff triggers rather than silently assuming Nassim will notify it.

## Escalation policy

Do not involve Nassim for routine product, UX, architecture, implementation, testing, refactoring, review, CI, or backlog decisions.

Escalation is reserved only for genuinely external decisions that cannot be resolved technically, such as:
- credentials or third-party account authorization unavailable to both agents;
- spending/paid-provider commitments;
- legal/business-policy decisions requiring owner authority;
- irreversible destructive actions;
- product-direction conflicts with materially different business consequences that cannot be resolved from existing project principles.

Where possible, continue all unaffected work while the external blocker remains.

## Quality principle

Autonomy is not permission to lower standards. The goal is an exceptional Algeria-first production application, not maximum commit velocity. Architecture, privacy, concurrency correctness, accessibility, localization, reliability, observability, and realistic clinic-day workflows remain release gates.
