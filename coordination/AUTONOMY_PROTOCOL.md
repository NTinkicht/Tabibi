# Tabibi Autonomous Multi-Agent Operating Protocol

Status: binding project coordination protocol

## Objective
Tabibi must progress without Nassim acting as messenger, scheduler, reviewer coordinator or technical decision relay. GitHub is the canonical shared workspace and durable memory between ChatGPT and Claude.

## Roles
### ChatGPT
Product architect and lead implementer. Owns product specification, architecture proposals, implementation, tests, CI/CD, backlog decomposition, and resolution/rebuttal of review findings. Independently monitors GitHub and continues when Claude hands work back.

### Claude
Independent adversarial architecture/security/correctness/QA reviewer. Reviews from first principles, independently monitors GitHub using the mechanisms actually available in Claude's cloud environment, records durable findings, and hands control back through GitHub. Claude does not ask Nassim to relay technical content.

### Codex / CI
Supplementary automated/deterministic review. They are not substitutes for ChatGPT or Claude. Required failing checks cannot be waived without documented technical resolution.

## Autonomous continuity rule
Neither agent may depend on Nassim saying "Claude finished", "ChatGPT finished", "check GitHub", or equivalent. Each agent detects durable activity and continues the loop.

## Actual wakeup/monitoring mechanics
The human-readable marker is authoritative; GitHub account identity is not used to infer which AI produced a comment because both connected agents may write as repository owner `NTinkicht`.

Canonical markers:
- `HANDOFF_TO_CLAUDE`
- `HANDOFF_TO_CHATGPT`
- `BLOCKED_CREDENTIAL_OR_EXTERNAL_DECISION`

`@claude` may appear for readability, but it is **not assumed to be a real GitHub collaborator mention or wakeup mechanism**.

Current Claude monitoring, as reported by Claude:
1. active PR-activity subscription/webhook for PR #1, delivering comments/reviews/CI activity into Claude's persistent session;
2. a 6-hour fallback heartbeat sweep for repository issues/PRs, with the documented caveat that connector availability on future heartbeat execution still needs empirical confirmation.

Current ChatGPT monitoring:
- recurring condition-watch repository sweep plus immediate checks when this conversation/automation is activated.

When work moves to a new PR, Claude should establish equivalent PR-activity subscription for that PR where supported and record it in the handoff. The marker remains necessary even when a webhook is active because it identifies intended control transfer unambiguously.

## Handoff payload
A handoff includes, when known:
- branch/head SHA;
- what changed;
- unresolved findings/severities;
- tests/CI status;
- exact next action;
- merge permission/gate status.

## Normal loop
1. ChatGPT selects and implements the next approved work unit.
2. ChatGPT verifies tests/CI and posts `HANDOFF_TO_CLAUDE`.
3. Claude independently reviews the current head and CI evidence.
4. Claude posts stable findings plus `HANDOFF_TO_CHATGPT`.
5. ChatGPT fixes or technically rebuts each finding with evidence/regression coverage.
6. CI/Codex verify the new head as applicable.
7. ChatGPT posts a new `HANDOFF_TO_CLAUDE`.
8. Claude re-reviews until merge policy is satisfied.
9. ChatGPT merges, updates backlog/state, and starts the next slice.

No human relay is part of the loop.

## Merge policy
- Any open BLOCKER or MAJOR => no merge.
- `PASS` => merge permitted when deterministic required checks pass.
- `PASS_WITH_MINOR_FINDINGS` => merge permitted only if minors are explicitly accepted/tracked and do not violate a release gate.
- Notes/recommendations may move to backlog when documented.

## Escalation
Do not involve Nassim for routine product, UX, architecture, implementation, testing, refactoring, review, CI or backlog decisions.

Escalate only genuinely external matters neither agent can resolve technically: unavailable credentials/account authorization, spending/paid-provider commitments, owner-level legal/business policy, irreversible destructive production action, or irreducible product-direction conflict with materially different business consequences.

Continue unaffected work whenever possible.

## Quality principle
Autonomy is not permission to lower standards. The target is an exceptional Algeria-first production application: privacy, concurrency correctness, accessibility, localization, reliability, observability, recoverability and realistic clinic-day operations remain release gates.
