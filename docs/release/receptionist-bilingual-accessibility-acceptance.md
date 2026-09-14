# WU48 receptionist bilingual accessibility acceptance

Parent: Issue #226 / Epic #7.

## Purpose

WU48 extends the merged public waiting-room bilingual release evidence into the existing receptionist operational surface. It must not create a second receptionist implementation path or weaken clinic scoping.

## Canonical acceptance scenario

Use only synthetic local PostgreSQL fixtures and the existing receptionist UI/API boundaries.

1. Seed two isolated clinics, each with its own receptionist identity, consultation session, and queue entry.
2. Exercise one realistic receptionist queue flow through the existing product surface.
3. Verify Arabic/RTL and French/LTR presentation only where the current receptionist surface supports those locales; do not fabricate locale behavior in tests.
4. Drive the primary tested action with keyboard interaction and assert that the actionable control is semantically discoverable and reachable without pointer-only behavior.
5. Assert the receptionist sees only the selected clinic's queue state and never the other clinic's public/private identifiers.
6. Assert rendered output does not expose unnecessary patient IDs, queue-entry IDs, auth subjects, correlation IDs, or cross-clinic private names.

## Test-quality rules

- Assertions must be non-vacuous: each clinic has seeded queue state and the test proves the expected clinic data is actually rendered before asserting the other clinic is absent.
- Directionality assertions must inspect the rendered product surface, not only query parameters or test fixtures.
- Keyboard assertions must perform actual focus/navigation/activation behavior through Playwright rather than calling the underlying API directly.
- Prefer accessible role/name locators for controls; avoid selectors that would allow a visually hidden or inert element to satisfy the test.
- Reuse existing queue/service fixtures and cleanup patterns.
- Keep all data synthetic and deterministic.

## Isolation and privacy gate

A Medium-or-higher finding exists if the acceptance path can render or act on another clinic's queue state, if an internal identifier/private field becomes visible without product need, or if a keyboard/accessibility assertion can pass without exercising a real interactive control.

## Cost and runtime boundary

PostgreSQL + the repository's existing Playwright/CI stack only. No external provider, load-testing SaaS, paid API, PAYG/overage, credits, Vertex, OpenRouter, auto-topups, production credentials, or real patient data.

## Merge gate

The canonical WU48 PR may merge only when its exact head has green required CI and an eligible non-author reviewer returns `PASS — MERGE_READY` for that unchanged SHA with no unresolved Medium+/Major+/High+/Critical/Blocker findings.
