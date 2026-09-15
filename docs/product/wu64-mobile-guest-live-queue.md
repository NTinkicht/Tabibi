# WU64 - Mobile guest live-queue experience

Parent: #264

## Product boundary

Build a mobile-first Arabic/French guest live-queue screen on top of the public WU63 capability-bound endpoint only. Do not expand authentication or reconstruct authority from client-visible identifiers.

## Privacy and capability rules

- Bearer material is transport-only and must never be rendered, logged, persisted to localStorage/sessionStorage, placed in URLs/referrers, analytics, telemetry, or error text.
- Render only fields explicitly returned by the WU63 public response.
- Rejected capability states remain generic and reveal no booking/credential existence information.
- Preserve no-store/no-referrer behavior.

## Polling state machine

- At most one request may be in flight.
- Use bounded polling cadence and bounded backoff; never create a retry storm.
- Pause or materially reduce polling while hidden/backgrounded and resume deterministically.
- Transient/offline failure may retain the last safe display only when explicitly marked stale.
- Terminal booking/queue states stop polling permanently for that view.

## Localization and accessibility

- Arabic and French must have equivalent state semantics.
- Arabic renders RTL and French LTR without locale affecting authorization behavior.
- Status changes use semantic announcements while suppressing noisy repeated screen-reader updates.

## Explicit non-scope

No ETA invention, notifications, geofencing, rescheduling, queue/check-in mutation, analytics expansion, staff workflow changes, or exposure of doctor/clinic/internal identifiers.

## Required evidence

1. Arabic/French rendering and RTL/LTR tests.
2. No bearer/internal identifiers in DOM, URL, storage, logs, or telemetry fixtures.
3. Generic rejection parity.
4. Non-overlapping polling plus visibility pause/resume and bounded retry/backoff.
5. Explicit stale/offline recovery behavior.
6. Terminal states stop polling.
7. no-store/no-referrer and no new analytics/audit side effects.
8. External-network-free component/browser coverage and green full CI.

## Governance

This branch is the sole canonical WU64 implementation stream. ChatGPT authored this initial contract and is recused from sole final gating. Exactly one production implementer at a time; failover continues this same branch/PR. Mistral Vibe is preferred for routine exact-head review/test-quality/failure-path analysis when its approved zero-cost path is concretely operational. Preserve an eligible non-author final gate and reconcile every Medium+/Major+/High+/Critical/Blocker finding before merge. No paid fallback, PAYG, overage, credits, Vertex, OpenRouter, auto-topups, retired Gemini Agent/Chat, or duplicate implementation stream.