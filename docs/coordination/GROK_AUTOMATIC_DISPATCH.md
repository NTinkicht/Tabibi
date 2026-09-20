# Grok Build auto-dispatch — owner Codespace, bounded review lane

Status: opt-in executable integration (Issue #323). **Not** an unattended GitHub-hosted Grok Action or a 24/7 promise. First guarded integration automates **independent read-only review only**; implementation leases remain with Codex/Claude until a separately tested, scope-constrained code-writing executor exists. Grok may implement interactively under the existing lease protocol.

## Operation

GitHub is the coordination bus. The Company OS/orchestrator posts a machine-readable lease on the **PR conversation**. A subscriber running in the owner's already running authenticated Tabibi Codespace polls open PRs every two minutes. A matching lease runs local subscription-backed `grok -p` once, then posts the report on that PR. No tokens, OAuth state or API keys leave Codespaces; only review output is posted. A poll without a valid lease makes **zero model calls**. The owner does not copy each assignment into Grok.

The lease is plain text (without a code fence), posted by the owner-controlled orchestrator GitHub connection after reconciling SHA, role and material authors:

```text
ROLE_LEASE_ASSIGNED
actor: grok
capability: review
pr: #456
exact_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
material_authors: codex,claude
```

Substitute the live 40-character PR SHA and actual authors. Do not ask Nassim to paste routine leases. `@grok` or `CI_GREEN_HANDOFF` alone are not executable leases. Parser requires a trusted owner GitHub login, current open non-draft PR, explicit non-Grok authors and review-only role. A Grok review identifies `actor: grok` even when its comment appears from the owner's GitHub login. A falsified actor list or owner account compromise remains a coordination security risk; the executor additionally checks Git commit authorship markers but cannot infer every owner-authored patch's real AI material author.

## GitHub-driven, no-routine-terminal mode (SaveGrok)

The preferred owner experience is **no bash prompts to Grok**. GitHub Actions CI workflow-run handoffs and the orchestrator's exact-SHA ROLE_LEASE_ASSIGNED comments remain the durable work queue. The **already running** owner Codespace's Grok dispatcher polls GitHub PR conversations and fetches live GitHub check runs for each leased SHA; no one needs to paste a task or manually invoke --once for each PR. GitHub Actions sends signals and publishes CI evidence, but **does not receive owner Grok OAuth or invoke metered xAI API calls**. The trusted parent fetches the exact SHA's three required GitHub Actions job statuses and validated GitHub action URLs, and for failed jobs only approved failed-step names (never raw CI logs, environment variables or secrets) are included in Grok's bounded review context.

One-time, in the existing Codespace's **VS Code UI** after the startup-task PR merges:

1. Open Tabibi's main workspace in VS Code (browser/desktop). After this PR merges, use Command Palette **Git: Pull** once to obtain the new startup task (or use VS Code's Source Control Pull button); no Bash command. Do not rebuild the container or delete the existing private Grok login.
2. From Command Palette select **Tasks: Manage Automatic Tasks**, then **Allow Automatic Tasks** in this trusted workspace. VS Code's permission may apply to automatic tasks in other trusted workspaces: review any other repository's tasks before trusting it. If prompted instead, choose **Allow** for the visible SaveGrok startup task.
3. Reopen/reload the Codespace workspace once to launch the **SaveGrok — automatic GitHub review failover (owner Codespace)** task. Its output terminal confirms whether the worker is active or why it fail-closed. The task is visible: no hidden shell, installer, keepalive or billing change. New reviewed leases are consumed automatically while the Codespace stays active. Stop the task, disallow automatic tasks or stop the Codespace to end it.

Implementation: .vscode/tasks.json now declares an npm-provider task pointing to package.json's grok:watch (the same guarded launcher), because the owner's live github.dev Codespace listed the npm provider but did not list the previous custom process task; VS Code task Output displayed only task-provider activation and no explicit parser error. The npm: grok:watch entry supplies a visible UI fallback even if the configured alias is not listed. The task still uses VS Code runOn: folderOpen, which the **owner allows in the UI**. scripts/grok-auto-start.mjs refuses every non-owner/non-Codespace/GitHub Actions context, paid-provider variables, non-main or dirty checked-out branches, absent private OAuth and missing local tools. It only fast-forwards **clean** main; no checkout, reset, rebase, push, auto-install or provider login. It launches the existing read-only --watch dispatcher and allows only that dispatcher's trusted, exact-head PR review lease to make a model call. Opening a feature branch does not start another worker; the current PR head is fetched separately in a disposable worktree, never merged locally.

**Important limitations:** runOn: folderOpen is an editor task, not a GitHub-hosted agent or a guarantee the process survives a stopped Codespace. The VS Code workspace must be open once to launch it and the owner must allow automatic tasks. If an instance is already running, the dispatcher's local process lock prevents duplicate model calls. When a Codespace stops, no code can keep the subscription-only CLI awake, and GitHub events remain queued only while the leased SHA stays current. GitHub may bill Codespaces compute/storage; do not extend idle timeout or install a keepalive just to advertise 24/7 access. A native, truly always-on GitHub actor would require a separately authorized provider GitHub integration, persistent private runtime or paid API path; none is installed here.

## Optional manual diagnostic fallback (not routine startup)

The preferred mode above needs no routine terminal commands. This legacy section is only for troubleshooting if VS Code automatic tasks are unavailable; do not use it as the normal per-PR workflow. In the existing owner Codespace:

```bash
cd /workspaces/Tabibi
git switch main && git pull --ff-only
grok version
gh auth status
# If OAuth expired: grok login --device-auth
node scripts/grok-dispatcher.mjs --once --dry-run
node scripts/grok-dispatcher.mjs --watch
```

Only for manual diagnostics, leave `--watch` in a running terminal and Ctrl+C to stop; a single targeted pass uses `--once`. The recommended mode is the owner-approved VS Code folder-open task, which starts the worker without terminal handoffs. A local lock permits one dispatcher per checkout. Ignored `.tabibi/grok-dispatch` records attempted leases and prevents re-execution on restart. The worker also checks the PR for an idempotency marker before posting. On auth/network/provider failure it records `CAPACITY_DEGRADED` and asks the Company OS to fail over—never invents an independent review. Superseded PR heads are recorded as `STALE_LEASE_DISCARDED`, not as evidence that Grok itself failed. After correcting the cause, create a *new* canonical lease comment rather than editing local state or reusing an exhausted lease.

Security: never put `XAI_API_KEY` or tokens in Actions secrets; no billed API, credits, top-ups, `--always-approve` or `--yolo`. The runner uses strict sandbox and edit/push/gh deny rules with a disposable detached git worktree. Grok gets a temporary empty `HOME`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME` and disabled git credential helpers and prompts; `GROK_HOME` still points at the owner's private OAuth directory because the subscription CLI must authenticate. Before any public PR post the dispatcher rejects recognizable GitHub/API tokens, private keys and the actual token/secret values from the local OAuth JSON; an unsafe result is never echoed and produces a failover marker instead. Nested OAuth token/secret arrays retain their parent-sensitive-key guard. Local delivery state is written atomically and malformed state files cannot permanently halt the watch loop. **This is defense in depth, not a mathematical guarantee against all secrets or a replacement for verifying the sandbox on the installed Grok version.** Keep real patient data, private provider payloads and production secrets absent from the Codespace. Inspect effective Grok rules after upgrades.

## SaveGrok conditional capacity failover (reactivated 2026-09-20)

This worker is **review-only**. A successful one-line or isolated-read probe does not establish that the full review worker is usable, and a working review worker does not grant Grok coding, branch-write or merge authority. The earlier full automatic reviews failed with `GROK_EXIT_1`; a short strict-sandbox worktree read probe passed. On 2026-09-20 owner ran an actual full review of PR #335 head `3dbfc0f30a5a4c3be82cf1bdfc63a2be3232ccd6`: dry run passed, the former **12-turn** review hit `GROK_TURN_LIMIT`, and dispatcher posted an exhausted lease with **no verdict**. This is the configured *review execution turn ceiling*, not proof that weekly SuperGrok capacity is exhausted. The next dispatcher change uses a focused diff-first review prompt with **28 maximum turns**, still 12-minute timeout and one attempt per fresh exact-head owner lease; code treats subsequent turn exhaustion as `EXECUTION_INCOMPLETE`, not provider `CAPACITY_DEGRADED`. Test once only after review/merge of that change, with a fresh lease. Status: full review activation unproven, automatic implementation adapter not built.

When a Codex, Claude, or other actor hits a **verified quota, authentication or bounded runtime failure**:

1. Reconcile the active WU/PR SHA, actual source commits and in-progress jobs. Record the affected capability and concrete failure; release **only** that actor's role lease. Do not evict a healthy second WU implementer or launch a duplicate PR.
2. Determine whether Grok has an owner-private **already running** Codespace, working OAuth, available included SuperGrok allowance and a successful same-capability executable proof. PR #318 is evidence of a past manual review, **not** evidence the current dispatcher or code-writing executor works now. A stopped Codespace is unavailable; there is no auto-wake.
3. Run `node scripts/actor-router.mjs review --authors=<all-current-material-authors> --unavailable=<known-unavailable-actors> --verified=grok:review` **only when live full-review execution has been independently verified**. Without `--verified=grok:review`, routing excludes Grok as `runtime_not_verified_for_capability` and uses another included non-author actor. If GitHub branch changes, the proof/role lease must be reconciled again.
4. `--verified=grok:implementation` is a **separate** evidence assertion and must remain absent until Grok has demonstrably produced safe executable code/test commits on the canonical branch under a separately reviewed writing adapter or bounded interactive owner-private session. Review proof alone never unlocks implementation.
5. On a Grok lease, require the exact head and owner-authored `ROLE_LEASE_ASSIGNED` comment described above. Run `node scripts/grok-dispatcher.mjs --once --dry-run` then at most one actual `--once` after reconciling latest main/PR. A failed run publishes an allowlisted diagnostic and is spent. Do not repeat it without a root-cause change and fresh lease. If Grok is absent or fails, route to the next eligible **included** actor or wait for capacity reset without silently buying usage.

Two parallel product WUs remain independent: Codex implements one reviewed by Claude; Claude implements the other reviewed by Codex where authorship allows. A Grok capacity replacement inherits the existing *single* WU/PR/branch and changes its reviewer to an independent non-author. Avoid self-review even across Grok Build and Grok Bot, which are the same actor.

**Hard stops:** no xAI API key, paid usage/credits/PAYG, OAuth relocation to GitHub Actions, Codespace keepalive, production/patient data, secret-bearing prompts, autonomous merge or deployment. Mere `actor: grok` text, an issue comment, a lease or a probe is not production execution evidence.

## Constraints

A stopped Codespace **cannot run this worker**. Closing it does not automatically wake the Codespace; when the owner opens the existing Codespace workspace again, the approved VS Code automatic task restarts the GitHub lease watcher. The manual `--watch` fallback is not the normal restart path. No keepalive, Codespaces auto-power-on or owner OAuth relocation is installed. Running Codespaces consumes compute and potentially billed usage; always-on deployment or auto-wake needs a separate cost and credential review. While asleep, a canonical lease remains on GitHub, but the worker only searches the newest 100 PR conversation comments for new leases. If more than 100 newer comments arrive before restart, even a same-head older lease may be missed; the orchestrator should post a fresh canonical lease on that exact head.

The worker scans up to 50 open PRs and the most recent 100 issue comments per PR per cycle for newly assigned leases; delivery deduplication searches all PR comment pages so a retry cannot double-post an older report. A highly active PR may need a fresh lease comment. It never edits the canonical branch, merges or widens Issue #11 unattended privileges. Grok `PASS` does not mean `MERGE_READY`; the orchestrator rechecks exact-head CI and every source's material findings.

Official CLI headless guide: https://docs.x.ai/build/cli/headless-scripting
Official Codespaces lifecycle: https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle
