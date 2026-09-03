# Tabibi Agent Operating Agreement

## Roles

### Nassim — Product Owner
Owns product intent and decisions requiring human/business judgment. Nassim is not a relay between AI agents.

Escalate only for genuine product ambiguity, irreversible/destructive actions, secrets/external accounts, spending, legal/regulatory interpretation, or unresolved material disagreement.

### ChatGPT / Codex — Lead Engineer
Owns architecture, implementation, tests, CI, refactors, technical documentation, and resolution of reviewer findings.

For each implementation cycle:
1. Read PRODUCT.md, ARCHITECTURE.md, SECURITY.md and coordination state.
2. Work on a scoped branch/PR.
3. Add tests for changed behavior.
4. Run deterministic checks.
5. Update coordination/CHATGPT_HANDOFF.md.
6. Do not declare acceptance while BLOCKER or MAJOR findings remain unresolved.

### Claude — Independent Reviewer
Owns independent review of architecture, correctness, privacy, security, concurrency, data integrity, testing quality and specification compliance.

Claude should try to falsify correctness, not confirm ChatGPT's assumptions.

On first review of a change, Claude should not modify production code unless explicitly asked. Findings should be durable in GitHub and/or coordination/CLAUDE_REVIEW.md.

## Finding severity
- BLOCKER — unsafe to merge: severe correctness, security, privacy, data-loss, or direct core-spec violation.
- MAJOR — material defect requiring resolution before acceptance.
- MINOR — real issue that does not invalidate the feature.
- NOTE — suggestion, ambiguity or future improvement.

Each finding should include a stable ID, category, location, evidence/reproduction, expected behavior, observed behavior, impact, required resolution and verification method.

Verdicts:
- PASS
- PASS_WITH_MINOR_FINDINGS
- CHANGES_REQUIRED

## Communication
GitHub is the communication bus and durable source of truth.

Use issues for work, PRs for integration/review, CI for deterministic verification, and coordination files for state/handoffs.

Neither agent should depend on Nassim copying messages between ChatGPT and Claude.

## Resolution protocol
ChatGPT must resolve every BLOCKER and MAJOR finding by either:
1. fixing it and adding appropriate verification/tests, or
2. rejecting it with technical evidence tied to the specification or an explicit architectural decision.

Claude re-reviews unresolved findings and checks for regressions.

## Definition of done
A scoped engineering change is accepted only when:
- relevant product/security/architecture contracts are satisfied;
- deterministic CI passes;
- zero unresolved BLOCKER findings remain;
- zero unresolved MAJOR findings remain;
- handoff/review state is current;
- no required human decision is outstanding.

## Engineering rules
- No secrets in Git.
- No silent error swallowing.
- No fake/stub behavior presented as production complete.
- No unreviewed direct feature work on main.
- Prefer small, auditable PRs.
- Avoid unnecessary dependencies.
- Data mutations that can race must have explicit consistency strategy and tests.
- Healthcare-adjacent data is treated as sensitive by default.
