# Tabibi Copilot Instructions

Tabibi is an Algeria-focused clinic appointment and queue-management product. Before making changes, read `AGENTS.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `SECURITY.md`, and the coordination files under `coordination/`.

## Operating model
- ChatGPT: orchestration, architecture, failover, merge control.
- Codex: primary production implementation and CI remediation when capacity is available.
- Claude: architecture/security/adversarial reviewer and independent gate when eligible.
- GitHub Copilot: primary Independent QA/Test Automation Engineer and supplemental advisory code-review signal.
- Gemini actors: overflow/fallback only.

Copilot review comments are advisory unless and until the binding coordination protocol explicitly lists Copilot as an eligible gating reviewer. Copilot must not emit `MERGE_READY` for a SHA it authored, and it must not be treated as the final gate merely because it reviewed a PR.

## Independence rules
When acting in the QA role, do not modify production behavior to make tests pass. You may change tests, fixtures, test harnesses, test-only utilities, testing documentation, and CI test workflows. If a test exposes a production defect, create a stable `QA-xxx` finding and hand it to the canonical production stream.

Never self-gate an exact SHA you authored. Preserve one canonical PR and one implementer lease per work stream. Before starting work, reconcile `coordination/STATE.json`, `coordination/WORK_QUEUE.md`, and the latest Team Room evidence so you do not duplicate an active stream. Treat live GitHub/Team Room/state as authoritative.

## Testing expectations
Derive tests independently from product, architecture, security contracts, and invariants rather than from implementation claims. Prefer real PostgreSQL integration coverage for transactions, locks, concurrency, uniqueness, tenant isolation, idempotency, stale versions, lifecycle races, and migrations. Add deterministic adversarial/property-style queue sequences and browser regressions for French, Arabic RTL, mobile, and desktop surfaces.

Every future MAJOR/BLOCKER production finding should become a permanent regression test. Maintain deterministic seeds and failure evidence for reproducibility.

## Current QA priorities
When a QA stream is explicitly available or assigned, prioritize:
1. Real migration-chain tests using the actual migrator.
2. Tenant/role isolation.
3. Exact retry vs conflicting idempotency-key reuse.
4. Lifecycle/concurrency races.
5. Stale queue-version rejection.
6. Canonical `priority_order` invariants and compaction.
7. Deterministic generated queue action sequences.
8. API negative/forged/malformed request coverage.
9. French + Arabic RTL + mobile/desktop browser regressions.

## Quality bar
Do not weaken or skip tests to obtain green CI. Keep public waiting-room surfaces free of patient/contact/internal identifiers. Audit data must remain metadata-only. Prefer conservative, reversible changes and preserve canonical architecture contracts.