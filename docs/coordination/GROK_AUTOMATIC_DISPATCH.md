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

## One-time activation in Codespaces

After merging the adapter PR, inside the existing owner Codespace:

```bash
cd /workspaces/Tabibi
git switch main && git pull --ff-only
grok version
gh auth status
# If OAuth expired: grok login --device-auth
node scripts/grok-dispatcher.mjs --once --dry-run
node scripts/grok-dispatcher.mjs --watch
```

Leave `--watch` in a running terminal, Ctrl+C to stop. For a single pass use `--once`. A local lock permits one dispatcher per checkout. Ignored `.tabibi/grok-dispatch` records attempted leases and prevents re-execution on restart. The worker also checks the PR for an idempotency marker before posting. On auth/network/provider failure it records `CAPACITY_DEGRADED` and asks the Company OS to fail over—never invents an independent review. Superseded PR heads are recorded as `STALE_LEASE_DISCARDED`, not as evidence that Grok itself failed. After correcting the cause, create a *new* canonical lease comment rather than editing local state or reusing an exhausted lease.

Security: never put `XAI_API_KEY` or tokens in Actions secrets; no billed API, credits, top-ups, `--always-approve` or `--yolo`. The runner uses strict sandbox and edit/push/gh deny rules with a disposable detached git worktree. Grok gets a temporary empty `HOME`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME` and disabled git credential helpers and prompts; `GROK_HOME` still points at the owner's private OAuth directory because the subscription CLI must authenticate. Before any public PR post the dispatcher rejects recognizable GitHub/API tokens, private keys and the actual token/secret values from the local OAuth JSON; an unsafe result is never echoed and produces a failover marker instead. Nested OAuth token/secret arrays retain their parent-sensitive-key guard. Local delivery state is written atomically and malformed state files cannot permanently halt the watch loop. **This is defense in depth, not a mathematical guarantee against all secrets or a replacement for verifying the sandbox on the installed Grok version.** Keep real patient data, private provider payloads and production secrets absent from the Codespace. Inspect effective Grok rules after upgrades.

## SaveGrok conditional capacity failover (reactivated 2026-09-20)

This worker is **review-only**. A successful one-line or isolated-read probe does not establish that the full review worker is usable, and a working review worker does not grant Grok coding, branch-write or merge authority. The last full automatic reviews failed with `GROK_EXIT_1`; a later short strict-sandbox worktree read probe succeeded. Status: review activation in progress, automatic implementation adapter not built.

When a Codex, Claude, or other actor hits a **verified quota, authentication or bounded runtime failure**:

1. Reconcile the active WU/PR SHA, actual source commits and in-progress jobs. Record the affected capability and concrete failure; release **only** that actor's role lease. Do not evict a healthy second WU implementer or launch a duplicate PR.
2. Determine whether Grok has an owner-private **already running** Codespace, working OAuth, available included SuperGrok allowance and a successful same-capability executable proof. PR #318 is evidence of a past manual review, **not** evidence the current dispatcher or code-writing executor works now. A stopped Codespace is unavailable; there is no auto-wake.
3. Run `node scripts/actor-router.mjs review --authors=<all-current-material-authors> --unavailable=<known-unavailable-actors> --verified=grok:review` **only when live full-review execution has been independently verified**. Without `--verified=grok:review`, routing excludes Grok as `runtime_not_verified_for_capability` and uses another included non-author actor. If GitHub branch changes, the proof/role lease must be reconciled again.
4. `--verified=grok:implementation` is a **separate** evidence assertion and must remain absent until Grok has demonstrably produced safe executable code/test commits on the canonical branch under a separately reviewed writing adapter or bounded interactive owner-private session. Review proof alone never unlocks implementation.
5. On a Grok lease, require the exact head and owner-authored `ROLE_LEASE_ASSIGNED` comment described above. Run `node scripts/grok-dispatcher.mjs --once --dry-run` then at most one actual `--once` after reconciling latest main/PR. A failed run publishes an allowlisted diagnostic and is spent. Do not repeat it without a root-cause change and fresh lease. If Grok is absent or fails, route to the next eligible **included** actor or wait for capacity reset without silently buying usage.

Two parallel product WUs remain independent: Codex implements one reviewed by Claude; Claude implements the other reviewed by Codex where authorship allows. A Grok capacity replacement inherits the existing *single* WU/PR/branch and changes its reviewer to an independent non-author. Avoid self-review even across Grok Build and Grok Bot, which are the same actor.

**Hard stops:** no xAI API key, paid usage/credits/PAYG, OAuth relocation to GitHub Actions, Codespace keepalive, production/patient data, secret-bearing prompts, autonomous merge or deployment. Mere `actor: grok` text, an issue comment, a lease or a probe is not production execution evidence.

## Constraints

A stopped Codespace **cannot run this worker**. Closing it does not auto-start the process again; run `--watch` once per Codespace session. No keepalive, Codespaces auto-power-on or owner OAuth relocation is installed. Running Codespaces consumes compute and potentially billed usage; always-on deployment or auto-wake needs a separate cost and credential review. While asleep, a canonical lease remains on GitHub, but the worker only searches the newest 100 PR conversation comments for new leases. If more than 100 newer comments arrive before restart, even a same-head older lease may be missed; the orchestrator should post a fresh canonical lease on that exact head.

The worker scans up to 50 open PRs and the most recent 100 issue comments per PR per cycle for newly assigned leases; delivery deduplication searches all PR comment pages so a retry cannot double-post an older report. A highly active PR may need a fresh lease comment. It never edits the canonical branch, merges or widens Issue #11 unattended privileges. Grok `PASS` does not mean `MERGE_READY`; the orchestrator rechecks exact-head CI and every source's material findings.

Official CLI headless guide: https://docs.x.ai/build/cli/headless-scripting
Official Codespaces lifecycle: https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle
