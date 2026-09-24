# GitHub-native autonomous implementation workers — execution contract

Parent: #481. This is a staged implementation contract, **not** proof of a functioning unattended coding agent.

## Existing baseline
- `.github/workflows/mistral-vibe-wake.yml` is read-only. Preserve it; never silently expand its GitHub token or Vibe tool permissions.
- `scripts/grok-dispatcher.mjs` and `scripts/grok-auto-start.mjs` are owner-Codespace **review-only**. Do not move `~/.grok/auth.json` into Actions, GitHub secrets, issues or logs.
- The repo already has exact-head CI and independent non-author review requirements. Do not create a second merge policy.

## Execution strategy
1. Start with a GitHub-hosted, manual/owner-only **readiness check**; this does not invoke any model, consume credits or obtain provider credentials.
2. Mistral implementation is eligible for a separate GitHub Action only after an owner confirms the configured key is a Vibe-specific key for the intended organization, included allowance is available, and PAYG is disabled. A generic Studio API key is not sufficient evidence of subscription-backed execution. Validate on a synthetic bounded WU, with one canonical branch, least-privilege token, no forked/untrusted code receiving credentials, and a maximum runtime/turn budget.
3. Grok implementation requires a provider-supported headless cloud auth path that uses the owner's included subscription. API-key-only Actions would be metered and are NOT authorized. Do not export or serialize owner OAuth into hosted runners. If no eligible path is verified, record `AUTH_BLOCKED` and retain owner-Codespace interactive implementation; do not claim Grok runs while Codespaces is stopped.
4. GitHub issue/PR state is the durable queue. Each owner-issued lease binds actor, capability, issue, branch, expected base SHA, allowed file scope and expiry. A trusted dispatcher verifies repo, sender, lease, authorship and current branch before executing. One active material implementer and one canonical PR per WU.
5. After changes, use exact-head required CI and an independent non-author full-SHA review. On failure, reassign the **same** branch/PR to the implementer. Limit attempts and time; classify quota/auth failures and fail over without paying. Merge only after all gates pass, then replenish the queue.

## Explicit negative tests before enabling write mode
- Untrusted comment, fork PR, stale lease, wrong SHA, wrong actor, duplicate delivery, expired lease, wrong branch, overlapping WU and insufficient quota do not invoke a model or grant a write token.
- A material author cannot gate its own diff; a green older SHA cannot gate a newer commit.
- A model cannot access provider credentials, production data or a write token by reading an untrusted repository file or PR body.
- Cancelled/failed run leaves a resumable canonical stream, not a duplicate branch.
- No API/PAYG, keepalive, added hosting or new owner spending is implicitly enabled.

## Acceptance evidence
A Codespace-OFF owner-issued WU is implemented on a GitHub-hosted worker, creates a real tested PR, receives a valid independent review, remediates any findings, and is mechanically merged after exact-head gates. Prove separately for each provider. A readiness check or a plan-only PR does not satisfy this acceptance criterion.
