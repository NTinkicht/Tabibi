# GitHub-native autonomous implementation workers — execution contract

Parent: #481. This is a staged implementation contract, **not** proof of a functioning unattended coding agent.

## Existing baseline
- **Already implemented before EPIC #481:** `.github/workflows/mistral-scoped-code-adapter.yml` plus `scripts/mistral-code-adapter.py` can turn one owner-leased exact-head PR assignment into a Vibe-generated bounded JSON proposal, isolated validation/tests, and a trusted-parent commit back to that **existing** PR, provided entitlement and PAYG-disabled checks succeed. It is not currently a general GitHub-issue-to-new-PR coder.
- **Already implemented before EPIC #481:** `.github/workflows/grok-cloud-code-proposal.yml` plus `scripts/grok-cloud-code-adapter.py` can validate a Grok cloud Bot's **existing PR comment proposal**, test and push an authorized bounded edit. GitHub Actions does not initiate Grok inference and this workflow requires a connected, working Grok Bot routine. These two existing adapters must be reused rather than rewritten.
- `scripts/autonomous-worker-readiness.py` runs both existing adapter selftests and checks essential workflow markers offline. It is a static regression check, not a provider authentication, subscription-capacity, cloud-execution or merge-gate proof.
- `.github/workflows/mistral-vibe-wake.yml` is read-only. Preserve it; never silently expand its GitHub token or Vibe tool permissions.
- `scripts/grok-dispatcher.mjs` and `scripts/grok-auto-start.mjs` are owner-Codespace **review-only**. Do not move `~/.grok/auth.json` into Actions, GitHub secrets, issues or logs.
- The repo already has exact-head CI and independent non-author review requirements. Do not create a second merge policy.

## Execution strategy
1. Start with the GitHub-hosted, manual/owner-only **readiness check**, upgraded to call both existing adapter selftests; this does not invoke any model, consume credits or obtain provider credentials. Reuse the existing scoped code adapters rather than build duplicates.
2. The **existing** Mistral scoped-code Action is eligible for actual inference only after an owner confirms the configured key is authorized for Vibe in the intended Mistral Organization, included allowance is available, and PAYG is disabled. Mistral documents that its plan usage is shared across Vibe, Studio and API; the key name or a successful whoami response alone does not prove PAYG status or remaining allowance. Validate on a synthetic bounded WU, with one canonical branch, least-privilege token, no forked/untrusted code receiving credentials, and a maximum runtime/turn budget.
3. For Grok, use an owner-linked Grok Bot cloud routine that consumes the authorized GitHub PR lease and posts a bounded proposal to the **existing** Grok Cloud Code Proposal Adapter. API-key-only Actions would be metered and are NOT authorized. Do not export or serialize owner OAuth into hosted runners. Until an actual Codespace-OFF Bot-to-PR proof exists, record `AUTH_BLOCKED` or `RUNTIME_UNVERIFIED` and do not claim Grok is an autonomous cloud coder.
4. GitHub issue/PR state is the durable queue. Existing adapter leases bind actor, capability, PR, exact head SHA, stream and bounded file scope. Extend the next dispatcher revision to bind issue identity and expiry as well; do not claim those fields are enforced by the existing adapters. A trusted dispatcher verifies repo, sender, lease, authorship and current branch before executing. One active material implementer and one canonical PR per WU.
5. After changes, use exact-head required CI and an independent non-author full-SHA review. On failure, reassign the **same** branch/PR to the implementer. Limit attempts and time; classify quota/auth failures and fail over without paying. Merge only after all gates pass, then replenish the queue.

## Explicit negative tests before enabling write mode
- Untrusted comment, fork PR, stale lease, wrong SHA, wrong actor, duplicate delivery, expired lease, wrong branch, overlapping WU and insufficient quota do not invoke a model or grant a write token.
- A material author cannot gate its own diff; a green older SHA cannot gate a newer commit.
- A model cannot access provider credentials, production data or a write token by reading an untrusted repository file or PR body.
- Cancelled/failed run leaves a resumable canonical stream, not a duplicate branch.
- No API/PAYG, keepalive, added hosting or new owner spending is implicitly enabled.

## Provider documentation
- Mistral: https://docs.mistral.ai/vibe/code/cli/api-keys-profiles and https://docs.mistral.ai/admin/billing-usage/subscriptions (included usage shared across Vibe, API and Studio; PAYG setting is an Organization decision).
- Grok: https://docs.x.ai/build/cli/headless-scripting and https://docs.x.ai/grok-bot/skills-routines-and-automations (a cloud Bot routine is separate from a GitHub-hosted Grok Build CLI runner).

## Acceptance evidence
A Codespace-OFF owner-issued WU is implemented on a GitHub-hosted worker, creates a real tested PR, receives a valid independent review, remediates any findings, and is mechanically merged after exact-head gates. Prove separately for each provider. A readiness check or a plan-only PR does not satisfy this acceptance criterion.
