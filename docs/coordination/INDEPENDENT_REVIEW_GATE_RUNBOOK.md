# Independently verified exact-head AI review — SHA-bound check

Issue #485 incident follow-up. CI-only green is not merge authorization.

## State of this implementation

`.github/workflows/verified-independent-review.yml` runs ONLY trusted `main` verifier code, with `checks:write` and no model/provider key. It writes the **Independent AI review / Verified final head** GitHub check run to the current canonical PR HEAD commit, never just the default-branch workflow SHA. New PR synchronization, native review events, CI completion, owner PR comments and completed Mistral Issue #11 wakes cause bounded re-evaluation. Manual `workflow_dispatch` can recheck a PR if GitHub suppresses GitHub-token-generated events.

Every checked open PR receives an explicit SUCCESS or FAILURE attached to its exact current HEAD. Failure includes missing provider proof, stale head, non-author mismatch, failed CI, adverse authenticated verdict, unresolved inline review threads, CHANGES_REQUESTED native reviews, missing evidence or API errors. No request, bot acknowledgement, owner-written `actor: grok`, CI handoff or self-review is a PASS. The verifier never checks out untrusted PR code with a privileged token.

**Reviewer-proof limitation:** the current `independent-review-gate.py` verifies provider-run-backed, artifact-sealed, clean **Mistral Vibe** review only, and excludes Mistral material authors. Existing Grok owner-account review comments, CodeRabbit `COMMENTED`/skip messages and an owner assertion cannot be treated as equivalent evidence. A separate independently verified adapter for other actors is required before this check can pass those PRs. This intentionally fails closed rather than silently reducing the requirement.

The verifier additionally rejects unresolved native GitHub review threads and CHANGES_REQUESTED native reviews. It does not by itself prove every historical top-level medium-or-higher finding was adjudicated, so merge orchestration must still inspect the full conversation, code and reviewer findings under AGENTS.md. Do not call this the final complete multi-provider gate until that requirement has tests and proof.

## Required main-branch configuration (one-time owner repository settings)

1. Merge this audited workflow through the existing governance process; its own first PR cannot be protected by a not-yet-installed required check.
2. In GitHub repository Settings → Rules → Rulesets, make a main-branch ruleset active and require the status check **Independent AI review / Verified final head** from GitHub Actions, along with existing required CI: **Quality and build**, **PostgreSQL integration**, **Browser smoke**. Verify the exact published name/source in the GitHub Checks UI rather than assuming it appears automatically.
3. Require branches to be up to date with main as appropriate for the existing merge policy, prevent bypasses that would silently defeat the check, and verify behavior on a synthetic clean PR: 3/3 CI green with no model review must BLOCK; stale, self-authored, edited, rate-limited and adverse reviews must BLOCK; an authenticated independent exact-head PASS with all reviewer findings reconciled must ALLOW. Do not turn on a rule that traps every Grok/Codex feature PR until an eligible provider-proof adapter exists or a safe alternative is demonstrated.
4. A new commit invalidates the prior SHA's success. If a new bot review or Mistral Issue #11 wake has finished but the check was not reevaluated, dispatch **Verified Independent AI Review** manually with that PR number; verify the new exact SHA.
5. No additional API/PAYG spending, fake app reviews, human routine approval, credential export or bypass to make green.

## Incident evidence

- PRs #482/#483/#486 merged with green CI but without an independently executed final-head gate.
- PR #487 merged at 2026-09-25T07:07:04Z at head `b13a6adead6688542a5bad90c2e24a6af63d9958`, although its final Mistral review, comment #5828367703, explicitly said `merge_ready: no` and disclosed `Material-Author: mistral-vibe` on commit `38883d6c`; the previous Grok review applied to an older head. This pilot does NOT establish enforcement.
- PR #488 merged at 2026-09-25T07:11:38Z; its green CI alone cannot establish nonauthor review provenance. An owner-attributed review without independently verifiable runtime remains advisory.

Keep Issue #485 open until a tested, required and usable merge guard exists, including a verified reviewer path for the project's actual mix of material authors.
