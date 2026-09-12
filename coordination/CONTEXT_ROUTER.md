# Tabibi Context Router

## Goal

Reduce repeated strong-model context consumption without changing Tabibi's product, security, CI, authorship, Company OS v2, role-overlay, or independent-review rules.

The router is infrastructure, not an actor. It has no role lease, implementation authority, review authority, or merge authority.

## Routing ladder

### L0 - reuse

Reuse fresh deterministic/cache results when the underlying file content and question class are unchanged. Prefer content-hash keys.

### L1 - deterministic discovery

Before broad model reads use `git grep`/`rg`, changed-file lists and `git diff`, symbol lookup, file profiling, bounded slices, and deterministic CI/test logs. The desired output is a small evidence packet with relevant paths, symbols, line ranges, and bounded excerpts.

### L1.5 - verified local Headroom shadow

For non-sensitive material, Headroom may be evaluated locally under `coordination/HEADROOM_SHADOW_TRIAL.md` before spending Copilot/strong-model context. Its pinned source revision must be verified. Headroom output is convenience context only and original evidence must remain retrievable.

### L2 - optional Copilot/Luna compression

Only when cheaper levels are insufficient for a genuinely broad repository-reading question, the helper may explicitly send a bounded non-sensitive evidence packet to GitHub Copilot CLI using GPT-5.6 Luna.

Rules:

- disabled by default;
- requires explicit local opt-in `TABIBI_CONTEXT_ALLOW_COPILOT=1`;
- repository custom instructions, auto-update, remote access, and remote export are disabled for the worker;
- never use `--allow-all`;
- no automatic retry through another paid provider;
- local budget state must be valid and positive;
- a unit is atomically reserved under an exclusive local lock before Copilot starts;
- lock acquisition and stale-lock reclamation are serialized by a separate short-lived local gate;
- concurrent calls may not consume the same final unit;
- ordinary invocation failure refunds under the same lock;
- hard crash remains fail-closed: the unit stays consumed, and stale-lock recovery never refunds it;
- output has no architecture, implementation, review, or merge authority.

### L3 - strong actor

ChatGPT, Codex, or Claude receives the smallest evidence packet adequate for the actual task and may request original source whenever correctness requires it.

Use strong actors directly for product/architecture decisions, authentication/authorization/privacy/tenant isolation, concurrency/data-integrity reasoning, exact-head adversarial review, difficult debugging, and code modification.

## Real-path and sensitive-data enforcement

Before `profile`, `slice`, or `compress` reads a file, `scripts/context-router.mjs`:

1. requires the lexical requested path to stay inside the repository;
2. rejects obvious sensitive requested paths;
3. resolves the path with `realpath`;
4. requires the real target to stay inside the real repository root;
5. applies sensitive-path exclusions again to the resolved target.

This prevents an in-repository symlink from smuggling an external file into the router.

Conservative excluded classes include `.env*`, credentials/keys, local `.tabibi` state, patient record/data/fixture/export files, provider/webhook/notification payload/response data, production exports/backups, and database dumps/backups. The policy is intentionally path-conservative; if a legitimate source file collides with a data-like name, use original strong-actor reading rather than weakening the compression boundary.

## Claude Code read guard

`.claude/settings.json` installs a `PreToolUse` guard for `Read`. Small files, bounded reads, and bootstrap/current-state files are allowed. Large unbounded reads are redirected to deterministic discovery or bounded slices.

The hook itself never calls a model. It is a context-efficiency rail, not a security boundary, and fails open so engineering is not stranded by hook errors.

## Bootstrap procedure

1. Read `coordination/BOOTSTRAP.md`.
2. Read current `coordination/STATE.json` and `coordination/WORK_QUEUE.md`.
3. Reconcile live PR/issue/CI/review/lease/overlay evidence.
4. Retrieve only task-relevant source-contract sections.
5. Expand originals whenever correctness/security/review requires it.

The bootstrap is an index. Source contracts win on conflict.

## Evidence packet format

Prefer:

```text
question: <bounded question>
paths:
  - path/to/file.ts:120-185 — <why relevant>
symbols:
  - SomeService.method
facts:
  - <grounded fact>
uncertainty:
  - <what still needs a direct read/test>
```

## Budget state and recovery

Local budget/metrics/lock/gate files live under `.tabibi/` and are gitignored. Repository defaults are zero-spend-safe.

A reservation lock uses exclusive file creation. Lock creation and stale-lock reclamation are themselves serialized by `context-budget.gate`, also created exclusively and held only around those local filesystem operations. This prevents two stale-lock reclaimers from replacing each other's newly acquired reservation lock.

If a previous reservation process was hard-killed, its reservation lock may become stale. While holding the acquisition gate, the router may remove that stale reservation lock only after its age exceeds the configured threshold and the recorded PID is no longer alive. It never refunds the already-reserved unit during stale-lock recovery.

The acquisition gate has no automatic stale-reclamation path. If a process is hard-killed during that very short critical section, later compression fails closed until an operator verifies that no context-router process is active and removes the local gate file. This deliberately prefers under-using included capacity over any path that could race into paid overage.

## Success metrics

Evaluate real work units using strong-model bulk-read bytes/tokens avoided, deterministic/search hit rate, Headroom fidelity, optional worker input/output estimates, added latency, strong-model re-read rate, CI/test success, and review finding rate.

The goal is not a marketing percentage. Smaller context with equal or better engineering evidence is the win.
