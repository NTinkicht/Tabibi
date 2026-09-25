# Tabibi Work Queue

GitHub is authoritative for live PRs, CI, reviews and leases; this is a dated snapshot, NOT permission to merge.

Status values: `ACTIVE`, `READY`, `BLOCKED`, `DONE`, `CANCELLED`.

## Product delivery after WU169 — snapshot 2026-09-25

**WU169 has merged**: PR #488 merge `9829612ab5deccd39878a824c608c1639582ca13`. WU168 PR #479 merge `6713cc2fbd445435b8621a317bac3cdccbe54b2c`. The stale implementation issues #346 (WU95), #383 (WU113), #385 (WU114), #476 (WU168) and #477 (WU169) were verified against merged PRs and closed. Duplicate WU112 Issue #382 was also reconciled against WU119 PR #395 and closed. Epics #2/#3/#4/#6 are closed; Epic #5 (deterministic live queue and ETA) is still open. Do NOT re-activate Issue #6 or the obsolete WU66 continuation.

PR #487, merge `7e3d044717f07ab514d772b3206ecfa22b1b067a`, is a review-proof pilot, **NOT enforced branch protection**. Its latest Mistral review disclosed material co-authorship and `merge_ready: no`; no verifiable independent nonauthor final-head gate was found before merge. Issue #485 records this incident; resolve by tested SHA-bound check, broad reviewer-proof support and required GitHub main ruleset, not by fabricated PASS or human routine PR sign-off.

| Workstream | Status | Scope and real next evidence |
| --- | --- | --- |
| WU168 / #476 | DONE | Guest queue help link, PR #479 merged; implementation issue closed |
| WU169 / #477 | DONE | FR/AR accessible clinic count, PR #488 merged; implementation issue closed |
| REVIEW-GATE-485 / PR #489 | ACTIVE | Trusted-main verified exact-head review check and negative tests; green CI, actual nonauthor review, then ruleset activation and live blocked/allowed proof; cannot count an unrequired check as enforcement |
| MISTRAL-BOUNDARY-355 / PR #490 | ACTIVE | Remove untrusted PR hooks/`--trust` and inherited GitHub credentials; CI, independent security review and merge; acknowledge remaining model provider-key read surface |
| STATE-RECONCILE-491 | ACTIVE | Correct STATE.json and WORK_QUEUE.md; derive a genuine next product WU only after acceptance audit |
| WU112 / #382 | DONE (superseded by WU119) | PR #395 merged FR/AR reconnect/fallback/recovery guidance and Playwright coverage; duplicate Issue #382 reconciled and closed |
| GROK-CLOUD #323/#340/#339 | READY TO VERIFY | Real no-Codespace provider run and trusted scoped code push with independent non-Grok review; adapter code/lease alone is not execution |
| MISTRAL-CLOUD #341/#355 | READY TO VERIFY | Real included-capacity review/code/test run, trusted push, 3-job CI and independent non-Mistral gate; PAYG off |
| PRODUCT-ACCEPTANCE-POST-WU169 | READY | Audit Epic #5 and PRODUCT.md across end-to-end clinic day with concrete code/tests; define smallest actual next feature WU |
| HEADROOM-SHADOW-001 | READY | Non-sensitive, read-only fidelity evaluation |

One material implementer per disjoint stream. A CI trigger or unexecuted review request is not a PASS. No PAYG or additional AI spend. No routine owner or Kaporal159 validation, but owner-only spending/credentials/legal/destructive production decisions remain.

## Current actor status

- **ChatGPT:** AVAILABLE - orchestration/architecture/state reconciliation and bounded implementation when leased.
- **Codex:** AVAILABLE subject to included-plan capacity - preferred implementation/CI/mechanical merge; non-author review only when eligible.
- **Claude:** AVAILABLE subject to Claude Pro capacity - preferred independent adversarial review/gate when concretely available and non-author.
- **Copilot:** AVAILABLE subject to included education entitlement - QA/Test Automation and eligible non-author Code Review.
- **Gemini CLI (`gemini-cli`):** AVAILABLE - activation probe passed; scouting/research/long-context/QA/overflow review; free/non-billable allowance only.
- **Mistral Vibe (`mistral-vibe`):** AVAILABLE - activation probe passed; bounded coding/docs/design/QA/overflow review; existing subscription allowance only, PAYG forbidden.
- **Grok:** ACTIVE registered actor; Codespace-off cloud availability and autonomous code delivery still require real provider execution evidence (Issues #340/#339).
- **CodeRabbit:** SUPPLEMENTAL reviewer source; material findings still require reconciliation.
- **Gemini Agent / Gemini Chat:** RETIRED historical identities - never route/wake/probe/lease.

## Binding delivery rules

- Exactly one canonical PR and one active implementer per work stream.
- Required exact-head CI is binding.
- Final merge requires an eligible independent non-author exact-SHA gate.
- All reviewer sources are inspected; unresolved BLOCKER/MAJOR/Medium+/High+/Critical findings prevent merge.
- Actor selection uses `coordination/ACTOR_REGISTRY.json` plus live capability/authorship evidence.
- Paid Gemini/Vertex routes, Mistral PAYG, OpenRouter, paid API credits, Copilot overage and other paid fallback are forbidden by `AI_CAPACITY_POLICY.md`.
- GitHub is authoritative; Slack is attention/culture only.
- Retired Gemini Agent/Gemini Chat identities remain retired; `gemini-cli` is a distinct active actor.
