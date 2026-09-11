# Tabibi Context Router

## Goal

Reduce repeated strong-model context consumption without changing Tabibi's product, security, CI, authorship, or independent-review rules.

The router is infrastructure, not an actor. It has no role lease, implementation authority, review authority, or merge authority.

## Routing ladder

### L0 - reuse

Reuse a fresh deterministic/cache result when the underlying file content and question class are unchanged. Cache keys should include content hashes rather than file names alone.

### L1 - deterministic discovery

Before a broad model read, use one or more of:

- `git grep` / `rg`;
- changed-file lists and `git diff`;
- path and symbol lookup;
- file size / line count profiling;
- bounded line slices around matched symbols;
- deterministic CI and test logs.

The desired output is an evidence packet: relevant paths, symbols, line ranges, and a small bounded excerpt.

### L2 - optional compression worker

Only when L0/L1 are insufficient for a genuinely broad repository-reading question, the local helper may explicitly send a bounded, non-sensitive evidence packet to GitHub Copilot CLI using GPT-5.6 Luna.

Rules:

- disabled by default;
- must require explicit local opt-in (`TABIBI_CONTEXT_ALLOW_COPILOT=1`);
- source excerpts are assembled by the deterministic helper before the model call;
- the Copilot call receives no filesystem-write permission and is not trusted as an authority;
- repository custom instructions are disabled for this worker so `AGENTS.md` and other broad startup material are not silently re-injected into the compression call;
- Copilot CLI remote/session export and automatic CLI updates are disabled for the compression call;
- never use `--allow-all`;
- output must be compact: filenames, symbols, line references, facts, and uncertainty;
- no automatic retry through another paid provider;
- if the local budget state is absent, exhausted, or invalid, fail closed to L0/L1.

### L3 - strong actor

ChatGPT, Codex, or Claude receives the smallest evidence packet adequate for the actual task. The strong actor may request targeted additional source whenever correctness requires it.

Use strong actors directly for:

- product/architecture decisions;
- authentication, authorization, privacy, tenant isolation and secret handling;
- concurrency/data-integrity reasoning;
- exact-head adversarial review and merge verdicts;
- difficult debugging where compressed evidence could hide causality;
- code modification of the exact implementation area.

## Claude Code read guard

The project `.claude/settings.json` installs a `PreToolUse` hook for `Read`.

The hook allows:

- small files;
- explicit bounded reads (`offset` + a modest `limit`);
- current-state/bootstrap files required for safe startup.

For a large unbounded file read, it denies the tool call and points Claude to `scripts/context-router.mjs` or a bounded `Read`. The hook itself never invokes Copilot or any model, so merely opening Claude Code cannot consume another provider's allowance.

The guard is a context-efficiency rail, not a security boundary. An actor may deliberately use bounded reads repeatedly when complete evidence is genuinely necessary.

## Bootstrap procedure

For a new engineering turn:

1. Read `coordination/BOOTSTRAP.md`.
2. Read current `coordination/STATE.json` and `coordination/WORK_QUEUE.md`.
3. Reconcile live PR/issue/CI evidence for the work unit.
4. Retrieve only the task-relevant sections of `PRODUCT.md`, `ARCHITECTURE.md`, `SECURITY.md`, `AGENTS.md`, and the relevant coordination protocols.
5. Expand context only when the task or evidence requires it.

The bootstrap is an index, not a replacement contract. If it conflicts with a source contract, the source contract wins.

## Evidence packet format

A useful deterministic/compressed result should prefer:

```text
question: <bounded question>
paths:
  - path/to/file.ts:120-185 — <why relevant>
  - path/to/test.ts:40-88 — <why relevant>
symbols:
  - SomeService.method
facts:
  - <fact grounded in the supplied excerpt>
uncertainty:
  - <what still requires a direct read or test>
```

Do not return long prose when paths and exact ranges are sufficient.

## Sensitive-path exclusions

The helper refuses obvious secret/sensitive paths and should be extended conservatively. Never route `.env*`, credentials, keys, database dumps, production exports, patient data, or provider payloads into model compression.

Repository source/tests/docs may still contain accidental secrets; deterministic scanning and normal security discipline remain required.

## Budget modes

The local optional compression mode is controlled outside Git by `.tabibi/context-budget.json` and environment variables. Repository defaults must always be zero-spend-safe:

- no opt-in -> compression disabled;
- no valid budget file -> compression disabled;
- allowance at/above hard stop -> compression disabled;
- Copilot CLI missing/error -> deterministic fallback, no provider substitution.

See `coordination/AI_CAPACITY_POLICY.md` for the binding financial policy.

## Success metrics

Evaluate the router on real work units using:

- strong-model bulk-read bytes/tokens avoided;
- deterministic cache/search hit rate;
- optional worker input/output estimates;
- added latency;
- strong-model re-read rate;
- CI/test success and review finding rate.

The goal is not a specific marketing percentage. A smaller context with equal or better engineering evidence is the win.