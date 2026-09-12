# Tabibi Headroom Shadow Trial

Status: **approved for read-only shadow evaluation; not yet authoritative in the agent path**.

Pinned evaluation source:

- repository: `NTinkicht/headroom`
- synchronized fork head observed on 2026-09-11: `97aa9f6d0fc04619e4e821e7d54611eb9d6b9b81`
- immutable install artifact: `headroom-ai[all] @ git+https://github.com/NTinkicht/headroom.git@97aa9f6d0fc04619e4e821e7d54611eb9d6b9b81`
- upstream content merged through `headroomlabs-ai/headroom` commit `04cdf79ab0a8423d88148ba63e960ac6b4007b9c`

Headroom describes itself as a local context-compression layer: tool outputs, logs, files, RAG chunks and conversation history can be compressed on the machine before reaching the LLM, with reversible retrieval/CCR support. The compression stage itself must not require sending Tabibi content to a new paid provider.

## Why Tabibi is evaluating it

Tabibi repeatedly feeds agents large GitHub/Team Room/CI/tool outputs. The trial asks whether local compression can reduce model-context consumption while preserving the facts that actually change engineering decisions.

This trial is deliberately separate from the Spotify-inspired **Epic** context-router restructuring. If Headroom proves reliable, Epic may adopt it as one local compression stage later.

## Shadow-mode rules

1. **Original evidence remains authoritative.** Headroom output is never the sole basis for a gate, security conclusion, migration decision, concurrency proof, role lease or owner decision.
2. **No patient-sensitive or secret material.** Do not feed production credentials, `.env` files, tokens, patient/contact payloads, private exports or other prohibited data into the trial.
3. **No new paid inference.** Headroom compression must run locally. The trial must not introduce OpenAI API, Anthropic API, OpenRouter or other metered fallback.
4. **No automatic governance edits.** `headroom learn` may generate suggestions in an isolated/gitignored or review branch context, but must never directly rewrite `AGENTS.md`, `SECURITY.md`, `ARCHITECTURE.md` or coordination protocols on `main`.
5. **Reversible only.** If compressed output loses a needed fact, the workflow must be able to retrieve/read the original evidence immediately.
6. **Shadow first.** Until graduation, agents still receive/use the normal authoritative evidence path; Headroom results are measured beside it rather than silently replacing it.
7. **Exact revision only.** Every trial run must use the pinned `NTinkicht/headroom` commit above. A PyPI/unpinned install, missing VCS provenance, or any different commit is rejected rather than treated as comparable evidence.

## Initial corpus

Use only repository-backed non-secret material, preferably historical/closed work so the trial cannot disturb active delivery:

- closed work-unit Team Room slices;
- CI/log excerpts from already-resolved incidents;
- large non-sensitive source/test files;
- generated `coordination/TEAM_INTERACTIONS.md` / `ENGINEERING_CHAT.md` slices;
- PR review discussions from completed work units.

Do not begin with authentication/authorization, destructive migrations or the most subtle concurrency reviews. Those become later validation cases only after baseline fidelity is demonstrated.

## Evaluation tasks

For each sample, compare baseline original-context reasoning with Headroom-compressed context on the same bounded question.

Examples:

- identify the exact failing CI cause;
- locate the responsible file/symbol/line range;
- list unresolved review findings and severities;
- reconstruct the current lease/next-action state;
- summarize a multi-file implementation without losing scope exclusions;
- identify a known regression condition from historical tests.

## Required metrics

Record at minimum:

- input tokens/chars before compression;
- compressed tokens/chars;
- compression ratio / tokens saved;
- wall-clock compression latency;
- whether every required fact was preserved;
- whether file/symbol/line references remained actionable;
- whether the baseline and compressed answer lead to the same engineering decision;
- whether the agent had to retrieve the original evidence;
- false omission / false emphasis incidents.

## Graduation criteria

Headroom may move from shadow mode into Epic's normal context path only after a representative sample demonstrates:

- material context reduction;
- no missed BLOCKER/MAJOR-equivalent fact in the evaluated corpus;
- no change to exact-SHA merge decisions caused by compression loss;
- acceptable latency;
- reliable original retrieval;
- explicit preservation of the GitHub-as-truth boundary.

A single serious omission in security, privacy, tenant isolation, migration safety or concurrency evidence resets the relevant graduation claim and requires remediation/retest.

## Local evaluation

Use a dedicated local virtual environment and install the exact fork revision, not the floating PyPI package:

```bash
python -m venv .venv-headroom-shadow
# Activate the environment for your platform, then:
python -m pip install --upgrade pip
python -m pip install 'headroom-ai[all] @ git+https://github.com/NTinkicht/headroom.git@97aa9f6d0fc04619e4e821e7d54611eb9d6b9b81'
headroom doctor
python scripts/context/headroom-shadow.py coordination/TEAM_INTERACTIONS.md
```

The supported Python API is `from headroom import compress`; `compress(messages, model=...)` returns compression metrics and compressed messages without itself being the LLM call.

A Tabibi helper is provided at `scripts/context/headroom-shadow.py`. It is metrics-only by default and restricts inputs to repository-local allowlisted paths. Before importing Headroom, the helper reads the installed distribution's PEP 610 `direct_url.json` provenance and requires both the approved `NTinkicht/headroom` repository and exact commit `97aa9f6d0fc04619e4e821e7d54611eb9d6b9b81`. Missing provenance or any mismatch fails closed before evaluation.

## Decision log

Do not “adopt because the benchmark percentage looks good.” Graduation requires Tabibi-specific fidelity evidence. Record the final decision as a normal reviewed coordination PR and a `TEAM_DECISION` in Team Room.
