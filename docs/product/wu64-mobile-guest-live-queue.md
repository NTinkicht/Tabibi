# WU64 - Mobile guest live-queue experience

Parent: #264

## Product boundary

Build a mobile-first Arabic/French guest live-queue screen on top of the public WU63 capability-bound endpoint only. Do not expand authentication or reconstruct authority from client-visible identifiers.

## Privacy and capability rules

- Bearer material is transport-only and must never be rendered, logged, persisted to localStorage/sessionStorage, placed in URLs/referrers, analytics, telemetry, or error text.
- WU64 obtains the bearer from its approved handoff and keeps it only in component memory. It sends the bearer exclusively in the `Authorization` header to the WU63 public endpoint; WU64 must not use or fall back to the cookie-authenticated flow.
- Clear the in-memory bearer when the component unmounts, when the capability expires or is rejected, and when the view reaches a terminal state.
- Render only fields explicitly returned by the WU63 public response.
- Rejected capability states remain generic and reveal no booking/credential existence information.
- Preserve no-store/no-referrer behavior.

## Polling state machine

- At most one request may be in flight.
- While visible and non-terminal, poll no faster than once every 30 seconds. A completed request schedules the next poll; interval timers must never overlap requests.
- Each request has a 10-second timeout and is aborted on timeout or component unmount.
- Retry transient network/5xx failures at most 4 consecutive times using bounded delays of 5, 15, 30, then 60 seconds. A successful response resets the retry budget. `Retry-After` may lengthen a delay but is capped at 300 seconds.
- After the fourth consecutive transient failure, stop automatic polling and enter an explicit stale/offline exhausted state with a user-triggered retry action; never spin indefinitely.
- While the document is hidden/backgrounded, do not start new polls. Abort an in-flight request on hide when safe to do so, retain only the last safe response marked stale, and do not consume retry budget merely because the page is hidden.
- On transition from hidden to visible, schedule exactly one immediate refresh if the view is non-terminal and no request is in flight; normal 30-second cadence resumes only after that request settles.
- Transient/offline failure may retain the last safe display only when explicitly marked stale.
- `completed`, `cancelled`, and `no_show` are terminal values for both `bookingState` and `queueState`. Observing any of these values stops polling permanently for that view. All other active/non-terminal values continue polling according to the rules above.

## Localization and accessibility

- Arabic and French must have equivalent state semantics.
- Arabic renders RTL and French LTR without locale affecting authorization behavior.
- Status changes use semantic announcements while suppressing noisy repeated screen-reader updates.

## Explicit non-scope

No ETA invention, notifications, geofencing, rescheduling, queue/check-in mutation, analytics expansion, staff workflow changes, or exposure of doctor/clinic/internal identifiers.

## Required evidence

1. Arabic/French rendering and RTL/LTR tests.
2. No bearer/internal identifiers in DOM, URL, storage, logs, or telemetry fixtures; bearer lifecycle tests prove memory-only retention, Authorization-header-only transport, and clearing on unmount/expiry/rejection/terminal state.
3. Generic rejection parity and proof that WU64 never falls back to cookie-authenticated authorization.
4. Non-overlapping polling tests covering the 30-second visible lower bound, 10-second request timeout, exact 5/15/30/60-second retry sequence, 300-second `Retry-After` cap, four-failure retry exhaustion, and successful-response retry-budget reset.
5. Visibility tests prove no new hidden/background polling, safe in-flight handling on hide, exactly one immediate non-terminal refresh on return to visible, and deterministic restoration of normal cadence.
6. Explicit stale/offline recovery and manual-retry behavior after retry exhaustion.
7. Polling-stop tests for each terminal value (`completed`, `cancelled`, `no_show`) when observed in either `bookingState` or `queueState`, plus evidence that active states continue polling.
8. no-store/no-referrer and no new analytics/audit side effects.
9. External-network-free component/browser coverage and green full CI.

## Governance

This branch is the sole canonical WU64 implementation stream. ChatGPT authored this initial contract and this review remediation and is recused from sole final gating. Exactly one production implementer at a time; failover continues this same branch/PR. Mistral Vibe is preferred for routine exact-head review/test-quality/failure-path analysis when its approved zero-cost path is concretely operational. Preserve an eligible non-author final gate and reconcile every Medium+/Major+/High+/Critical/Blocker finding before merge. No paid fallback, PAYG, overage, credits, Vertex, OpenRouter, auto-topups, retired Gemini Agent/Chat, or duplicate implementation stream.
