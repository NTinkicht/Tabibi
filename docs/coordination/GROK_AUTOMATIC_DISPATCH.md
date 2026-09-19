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

Security: never put `XAI_API_KEY` or tokens in Actions secrets; no billed API, credits, top-ups, `--always-approve` or `--yolo`. The runner uses strict sandbox and edit/push/gh deny rules with a disposable detached git worktree. Grok gets a temporary empty `HOME`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME` and disabled git credential helpers and prompts; `GROK_HOME` still points at the owner's private OAuth directory because the subscription CLI must authenticate. Before any public PR post the dispatcher rejects recognizable GitHub/API tokens, private keys and the actual token/secret values from the local OAuth JSON; an unsafe result is never echoed and produces a failover marker instead. **This is defense in depth, not a mathematical guarantee against all secrets or a replacement for verifying the sandbox on the installed Grok version.** Keep real patient data, private provider payloads and production secrets absent from the Codespace. Inspect effective Grok rules after upgrades.

## Constraints

A stopped Codespace **cannot run this worker**. Closing it does not auto-start the process again; run `--watch` once per Codespace session. No keepalive, Codespaces auto-power-on or owner OAuth relocation is installed. Running Codespaces consumes compute and potentially billed usage; always-on deployment or auto-wake needs a separate cost and credential review. While asleep, a canonical lease remains on GitHub and is picked up on restart if the PR head still matches.

The worker scans up to 50 open PRs and the most recent 100 issue comments per PR per cycle for newly assigned leases; delivery deduplication searches all PR comment pages so a retry cannot double-post an older report. A highly active PR may need a fresh lease comment. It never edits the canonical branch, merges or widens Issue #11 unattended privileges. Grok `PASS` does not mean `MERGE_READY`; the orchestrator rechecks exact-head CI and every source's material findings.

Official CLI headless guide: https://docs.x.ai/build/cli/headless-scripting
Official Codespaces lifecycle: https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle
