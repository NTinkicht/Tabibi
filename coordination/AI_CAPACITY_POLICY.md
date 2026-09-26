# Tabibi AI Capacity Policy

## Purpose

Tabibi operates under a fixed owner-approved AI budget. Only capabilities already included in Nassim's active subscriptions/entitlements or explicitly non-billable free allowance may be used. Capacity exhaustion is an engineering constraint, not permission to spend more.

## Financial circuit breaker

Unless Nassim makes a new explicit owner decision, the following are forbidden:

- additional paid AI usage;
- OpenAI API/pay-as-you-go credits;
- Anthropic API/usage credits;
- OpenRouter or another metered model gateway;
- GitHub Copilot paid overage/additional usage;
- paid Gemini API/Vertex AI billing;
- Mistral PAYG/overage or separately funded API credits;
- xAI API-key billing, Grok usage credits/PAYG or SuperGrok overage;
- automatic top-ups, paid fallbacks or silent substitutions that can incur cost.

No workflow, script, scheduled task, hook or actor may create a billing commitment on the owner's behalf.

## Approved capacity

- **ChatGPT Plus / ChatGPT:** orchestration, architecture, state reconciliation and failover.
- **Codex included capacity:** primary implementation, tests, refactors, CI remediation and merge execution.
- **Claude Pro / Claude Code:** adversarial review, security/privacy/authorization, concurrency/data-integrity analysis and difficult debugging.
- **GitHub Copilot education entitlement:** coding assistance, QA/Test Automation, eligible non-author Code Review and explicitly budgeted local context compression.
- **Gemini CLI (`gemini-cli`):** only the owner's already-configured free/non-billable allowance. A Gemini API key may be used by the dedicated owner-only wake workflow only when `TABIBI_GEMINI_ZERO_BILLING_CONFIRMED=true`; no Vertex AI or paid Gemini tier is authorized.
- **Mistral Vibe (`mistral-vibe`):** the owner's existing included Mistral plan allowance only. The dedicated wake workflow may use a Vibe/API credential only when `TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED=true`; PAYG/overage must remain disabled. Read-only exact-head reviews may be owner-dispatched on Issue #11 or automatically dispatched from a same-repository PR's successful exact-head CI, provided the reviewed head's canonical CI workflow blob is byte-identical to the trusted `main` definition. Automatic review never authorizes implementation, merge, paid fallback or model-held GitHub write credentials.
- **Grok Build (`grok`):** owner-authenticated official Grok Build CLI using only existing SuperGrok included weekly allowance. Verify local OAuth/entitlement before lease; no xAI API key/PAYG or unattended wake.
- **Grok Bot (`grok`, alternative runtime):** owner's existing SuperGrok-linked Grok Bot included weekly usage, separate from Grok Build's pool. Requires owner sign-in/link in the Grok Bot/Cursor app and conscious access/privacy setup on its shared persistent cloud computer; no extra plan or credit purchase. Same actor for author/reviewer-independence accounting; not an API-key GitHub Action.
- **Headroom:** local read-only shadow compression under `HEADROOM_SHADOW_TRIAL.md`.
- **Shell/Git/CI:** first choice for search, indexing, diffs, tests and logs.

## Default-off Mistral scoped implementation exception

The proposed `.github/workflows/mistral-scoped-code-adapter.yml` is a separate parent-only write boundary, not an expansion of the general `mistral-vibe-wake.yml`. Its job must be unreachable until BOTH the explicit repository enable variable AND PAYG-disabled confirmation are true. Only an owner-issued Issue #11 code dispatch plus an active owner-authored canonical PR implementation lease may proceed. Parent validates same-repository open PR and unchanged HEAD, limited `src/`+ `tests/` file paths, anti-symlink/secret/oversize constraints, actual patch and deterministic tests. Child gets `plan`, `grep`, `read_file` only, no GH_TOKEN/commit/push/shell. Parent alone gets scoped GitHub write token after model exit, rechecks lease+HEAD, writes a truthful `Material-Author: mistral-vibe` commit onto the SAME branch with non-force fast-forward. Then exact-head 3-job CI and another NON-Mistral reviewer gate apply BEFORE merge; code adapter itself never merges. Until actual tested pushed code exists this is proposed capability only, NOT a proven coding actor. Off/limits/errors never authorize paid fallback.

## Credential boundary

Gemini/Mistral/Grok credentials are runtime credentials, not repository assets.

- Never commit API keys, OAuth material, `.gemini/`, `.vibe/`, `.mistral/`, `.grok/`, `auth.json` or generated auth files.
- `GEMINI_API_KEY` is permitted only in `.github/workflows/gemini-cli-wake.yml`, guarded by `TABIBI_GEMINI_ZERO_BILLING_CONFIRMED=true` and an owner-only Issue #11 event trigger.
- `MISTRAL_API_KEY` is permitted ONLY in `.github/workflows/mistral-vibe-wake.yml` (read-only exact-head review/analysis lane) and `.github/workflows/mistral-scoped-code-adapter.yml` (SEPARATE DEFAULT-OFF, scoped code-proposal lane). Both require `TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED=true`. The read-only review lane may start from an owner Issue #11 dispatch or a GitHub `workflow_run` event for successful same-repository exact-head CI only after the trusted parent verifies that the reviewed head uses the same canonical CI workflow blob as `main`. The code adapter still requires a NEW owner-issued Issue #11 code dispatch for an active same-PR sole-implementer owner lease, a current exact SHA and path allow-list. This per-WU dispatch is the activation; there is no standing global enable variable. Never treat either parent publisher/write scope as model write permissions.
- `GOOGLE_API_KEY`, Vertex AI and other billable Gemini routes remain forbidden in active workflows.
- `XAI_API_KEY`/metered xAI routes remain forbidden in workflows. Never copy `~/.grok/auth.json`, MCP credentials or OAuth tokens to hosted runners, GitHub Secrets, source, prompts or public issues.
- Gemini's general wake and Mistral's model-execution job are read-only actor lanes: model processes inspect evidence but do not edit, commit, push, merge, label or hold GitHub write tokens. For Mistral only, a separate trusted publisher job may copy an immutable run-sealed exact-head result to the PR and create a native `APPROVE` only for one clean `VERDICT: PASS` after unchanged-head, non-author provenance and trusted exact-head 3-job CI are reverified. A PR that changes the canonical CI workflow is ineligible for this automatic approval lane and requires an explicit owner-dispatched review path. The separately scoped **Grok metadata bridge** `.github/workflows/savegrok-cloud-slack-bridge.yml` is NOT a Grok model wake: it uses the already-approved Slack relay credential only to send public PR/lease/SHA metadata after verified owner-authored lease, newest 3/3 exact-head CI, and failover/supersession checks. `TABIBI_GROK_CLOUD_BRIDGE_ENABLED=true` is forbidden until owner has deliberately connected the included Grok Bot, GitHub and Slack and confirmed the narrow event routine. No Grok token, model access, code write or merge authority is granted. A real Codespace-off review must separately prove the Bot runtime.
- Issue #162 plus the owner's later explicit automatic-review decision authorize these bounded unattended wake paths only; they are not blanket authorization for provider-key automation elsewhere. Mistral automatic review is restricted to included capacity, PAYG disabled, same-repository PRs and the trusted-CI integrity fence described above.
- Do not paste credentials into issues, PRs, Team Room, Slack or model prompts.

## Deterministic-first context budget

Use the cheapest safe evidence level:

1. cache/index;
2. deterministic Git/`rg`/diff/path/symbol/bounded slices;
3. verified local Headroom shadow for non-sensitive context when suitable;
4. optional explicitly enabled included-capacity compression;
5. strong subscribed actor with the smallest adequate evidence set.

A strong actor may always request more original evidence when correctness requires it.

## Fail-closed degradation

- Grok owner OAuth missing/expired, included allowance exhausted or spend state uncertain -> `AUTH_BLOCKED` / `CAPACITY_DEGRADED`, never API key/credits.
- Gemini guard missing, quota exhausted, credential unavailable or billing uncertainty -> `CAPACITY_DEGRADED`; do not switch to paid Gemini/Vertex.
- Mistral failures keep their actual class: missing spend guard -> `CONFIG_BLOCKED`; missing/rejected credential -> `AUTH_BLOCKED`; rejected Vibe entitlement -> `ENTITLEMENT_BLOCKED`; exhausted included allowance or explicit rate/quota signal -> `CAPACITY_DEGRADED`; wake timeout -> `WAKE_TIMEOUT`; incompatible CLI -> `CLI_INCOMPATIBLE`; unrelated nonzero runtime -> `EXECUTION_FAILED`. Every class fails closed and PAYG stays off.
- Copilot compression unavailable -> deterministic retrieval/Headroom/targeted reads.
- Codex implementation limited -> fail over to already-included eligible implementation capacity.
- Claude review limited -> another eligible independent non-author reviewer; never weaken a security/concurrency gate.
- Any provider limit -> deterministic evidence, another included actor, bounded scope reduction or wait for reset.

Never turn any degraded/blocked actor state into a paid-provider call.

## Copilot context allowance

Copilot context compression remains a finite included resource. Local budget state lives under `.tabibi/`, is gitignored and must be valid/positive before invocation. Units are reserved atomically; concurrent callers cannot consume the same final unit. Ordinary invocation failure refunds under the reservation lock; hard crash remains fail-closed.

## Scheduled-task budget

Scheduled tasks consume capacity. Use event-driven state and shared cooldown/lease signals rather than multiple staggered polling tasks. Quiet Git history alone is not proof of idleness when CI/tests or an active lease exist.

Gemini CLI and Mistral Vibe unattended wakes are deliberately event-driven only. Mistral read-only review may be triggered by trusted green-CI completion as defined above; Mistral implementation remains owner-Issue-#11 dispatched. Grok Build has no unattended GitHub-hosted model wake, cron or OAuth token relay. The guarded metadata-only Slack bridge can dispatch to an owner-configured Grok Bot routine but must remain disabled until explicitly activated; it never runs Grok on Actions. No actor may add polling or cron schedules without another explicit owner decision.

## Data/security exclusions

No model/compression route may receive credentials/tokens/private keys, production or patient records/fixtures/exports, notification/webhook/provider payloads containing sensitive operational content, database dumps/backups or other secret-bearing artifacts.

Security/privacy/authorization decisions, architecture verdicts and merge-gate verdicts belong to eligible strong actors plus deterministic original evidence.

## Metrics

Allowed local metrics include request type, files/bytes examined, excerpt size, compression invocation, token estimates, cache status, latency and fallback reason. Do not store full prompts, patient data, secrets or delegated source in metrics.

## Owner authority

Changing this policy to permit additional spending requires a new explicit owner decision. Upgrade/credit/overage offers are not authorization.
