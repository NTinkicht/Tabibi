# OpenRouter Review Council

## Purpose

The OpenRouter Review Council is a model-diverse, read-only advisory review layer for Tabibi pull requests. It exists to increase reviewer diversity and catch issues that a single model family may miss.

It is **not merge authority**. Council output is advisory until a future explicitly reviewed protocol change promotes a specific council identity into the binding gate policy.

## Current specialists

- **Nemotron 3 Ultra** (`nvidia/nemotron-3-ultra-550b-a55b`) — architecture, security boundaries, concurrency, authorization, tenancy, and failure modes.
- **GLM 5.3** (`z-ai/glm-5.3`) — code correctness, migrations, state transitions, invariants, API/data-flow bugs, and test adequacy.
- **MiniMax M3** (`minimax/minimax-m3`) — user-facing behavior, accessibility, UI/API ergonomics, workflow edge cases, and operational usability.
- **Gemma 3 27B** (`google/gemma-3-27b-it`) — Arabic/French multilingual behavior, RTL, privacy-safe copy, localization, and public API contract review.
- **DeepSeek V4 Flash** (`deepseek/deepseek-v4-flash`) — low-cost synthesis/judge that reconciles specialist findings, removes duplicates, and highlights cross-model agreement or disagreement.

## Invocation

The GitHub Action can be invoked in either of two ways:

1. `workflow_dispatch` with a pull-request number; or
2. an owner-authored PR comment whose trimmed body is exactly `/openrouter-council`.

The comment trigger is deliberately owner-only so untrusted users cannot spend the repository's OpenRouter credit.

## Secret

Repository Actions must contain one secret named exactly:

`OPENROUTER_API_KEY`

Never place the key in Git history, issue comments, workflow logs, Team Room, Slack, or model prompts.

## Cost and privacy controls

- PR diff input is capped before transmission.
- Specialist outputs are bounded.
- The council receives source-code diff and PR metadata only; it must not be used to transmit production credentials, patient data, or other secrets.
- Individual provider failures do not fail the whole council if enough specialists remain available.
- `openrouter/free` is reserved for low-value background experiments and is not part of the default high-signal council.

## Output semantics

Council comments must start with `OPENROUTER_COUNCIL_ADVISORY` and clearly state that they are non-gating.

Findings should use stable IDs where practical and classify severity as `BLOCKER`, `MAJOR`, `MINOR`, or `NOTE`. The DeepSeek synthesis should distinguish consensus from single-model findings and should never fabricate verification evidence.

A council response cannot satisfy `PASS/MERGE_READY` under the current Tabibi binding protocol.