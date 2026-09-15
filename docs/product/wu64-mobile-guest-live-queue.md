# WU64 - Mobile guest live-queue experience

Parent: #264

## Product boundary

Build a mobile-first Arabic/French guest live-queue screen on top of the public WU63 capability-bound endpoint only. Do not expand authentication or reconstruct authority from client-visible identifiers.

## Privacy and capability rules

- Bearer material is transport-only and must never be rendered, logged, persisted to localStorage/sessionStorage, placed in URLs/referrers, analytics, telemetry, or error text.
- The approved handoff is an in-memory, same-document transfer from the trusted host that receives the capability directly from the successful guest-booking flow into the WU64 component through a non-serialized prop/context value. The host must clear its handoff reference immediately after the component accepts it. The transfer must not cross a URL, query/hash, browser storage, DOM attribute, cookie, log, telemetry event, or error payload.
- WU64 keeps the accepted bearer only in component memory. It sends the bearer exclusively in the `Authorization` header to the WU63 public endpoint; WU64 must not use or fall back to the cookie-authenticated flow.
- A reload, relaunch, or new document must not recover the bearer from persisted client state. Unless the trusted booking host can perform a fresh approved in-memory handoff from a newly obtained capability, WU64 enters the same generic unavailable state used for rejected/absent capability and does not poll. Reacquisition requires returning through the trusted guest-booking flow; WU64 must not reconstruct authority from booking, queue, appointment, clinic, or credential identifiers.
- Clear the in-memory bearer when the component unmounts, when the capability expires or is rejected, and when the view reaches a terminal state.
- Render only fields explicitly returned by the WU63 public response.
- Rejected, absent, and non-reacquirable capability states remain generic and reveal no booking/credential existence information.
- Preserve no-store/no-referrer behavior.

## Polling state machine

- At most one request may be in flight.
- While visible and non-terminal, poll no faster than once every 30 seconds. A completed request schedules the next poll; interval timers must never overlap requests.
- Each request has a 10-second timeout and is aborted on timeout or component unmount.
- After an initial transient network/5xx failure, perform up to four retries using bounded delays of 5, 15, 30, then 60 seconds. The initial failure does not consume one of these four retry attempts. A successful response resets the consecutive-failure/retry sequence. `Retry-After` may lengthen a delay but is capped at 300 seconds.
- If the fourth retry also fails (five consecutive transient failures total: the initial attempt plus four retries), stop automatic polling and enter an explicit stale/offline exhausted state with a user-triggered retry action; never spin indefinitely.
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
2. No bearer/internal identifiers in DOM, URL, storage, cookies, logs, telemetry, or error fixtures; bearer lifecycle tests prove trusted same-document in-memory handoff, immediate host-reference cleanup, component memory-only retention, Authorization-header-only transport, and clearing on unmount/expiry/rejection/terminal state.
3. Generic rejection/absence/relaunch parity; reload/relaunch tests prove no persisted bearer recovery or polling without a fresh approved handoff, and proof that WU64 never falls back to cookie-authenticated authorization or reconstructs authority from identifiers.
4. Non-overlapping polling tests covering the 30-second visible lower bound, 10-second request timeout, exact 5/15/30/60-second sequence for four retries after the initial transient failure, 300-second `Retry-After` cap, exhaustion only when the fourth retry fails (five consecutive transient failures total), and successful-response retry-budget reset.
5. Visibility tests prove no new hidden/background polling, safe in-flight handling on hide, exactly one immediate non-terminal refresh on return to visible, and deterministic restoration of normal cadence.
6. Explicit stale/offline recovery and manual-retry behavior after retry exhaustion.
7. Polling-stop tests for each terminal value (`completed`, `cancelled`, `no_show`) when observed in either `bookingState` or `queueState`, plus evidence that active states continue polling.
8. no-store/no-referrer and no new analytics/audit side effects.
9. External-network-free component/browser coverage and green full CI.

## Governance

This branch is the sole canonical WU64 implementation stream. ChatGPT authored this initial contract and this review remediation and is recused from sole final gating. Exactly one production implementer at a time; failover continues this same branch/PR. Mistral Vibe is preferred for routine exact-head review/test-quality/failure-path analysis when its approved zero-cost path is concretely operational. Preserve an eligible non-author final gate and reconcile every Medium+/Major+/High+/Critical/Blocker finding before merge. No paid fallback, PAYG, overage, credits, Vertex, OpenRouter, auto-topups, retired Gemini Agent/Chat, or duplicate implementation stream.
