# TAB-FND-021 — Provider-dispatch boundary resolution

Status: **ACCEPTED / REQUIRED ARCHITECTURE UPDATE PENDING**
Severity: **MAJOR**
Category: notification / concurrency

## Problem

A database transaction cannot atomically fence an external notification-provider network call. If a newer delay update, recovery, or session cancellation commits after the worker's last database relevance check but before the provider invocation actually begins, an older message can still be sent. Provider idempotency protects retries of the same logical intent but does not order different notification versions.

## Canonical MVP contract

1. Every provider-bound notification intent has a persisted delivery lifecycle with at least `pending -> dispatching -> delivered|failed|unknown` plus an auditable `skipped_obsolete` outcome.
2. Immediately before entering `dispatching`, the worker opens a transaction and revalidates all of the following against committed state:
   - the intent is not superseded;
   - the intent is still the head/current version of its replaceable per-entry notification stream;
   - the session/entry terminal state still permits this notification;
   - any terminal cancellation precedence rule has not made the intent obsolete.
3. In the same transaction, if the intent is current, it is persisted as `dispatching`; otherwise it is persisted as `skipped_obsolete` and the provider is never called.
4. Only after the committed `dispatching` transition may provider invocation begin.
5. Once provider invocation has begun, that attempt is **irrevocable/in-flight**. A later state mutation cannot truthfully guarantee recall or suppression of that already-started network call.
6. A newer delay/recovery/cancellation mutation still advances the stream version and supersedes every older intent whose provider invocation has not begun. Terminal cancellation has precedence over all remaining not-yet-started non-terminal intents.
7. If a newer/terminal mutation commits after an older provider call has begun, the older call may complete, but the newer/terminal intent remains deliverable afterward. The product and architecture must describe this as a bounded race, not absolute stale-message suppression.
8. Stable provider idempotency keys are mandatory for retry-after-unknown-result and duplicate suppression. They do **not** provide cross-version ordering or supersession.
9. Recovery from `unknown` must retry the same logical provider operation idempotently; it must not create a fresh logical notification version merely because provider outcome is unknown.

## Required verification before production implementation

Add barrier-controlled PostgreSQL/worker integration tests proving:

- **Mutation before dispatch boundary:** worker selects an older intent, then update/clear/cancel commits before final revalidation. The old intent becomes obsolete/skipped and the provider call count remains zero for it.
- **Mutation after dispatch begins:** worker commits `dispatching` and provider invocation begins, then update/clear/cancel commits. The in-flight old call may finish, while the newer/terminal intent remains valid and is subsequently deliverable in version order.
- **Unknown-result retry:** provider outcome becomes `unknown`; retry uses the same provider idempotency key/logical intent and cannot intentionally duplicate the logical notification.
- **Terminal precedence:** cancellation suppresses every older not-yet-started delay/recovery intent, including queued/retryable jobs.
- **Crash windows:** crashes before committed `dispatching`, after committed `dispatching` but before a known provider result, and after provider acceptance are handled without violating the stated bounded-race/idempotency contract.

## Required durable updates

Before returning the foundation to Claude review:

- bump `ARCHITECTURE.md` from v0.9 to v0.10;
- replace the claim that final revalidation alone is authoritative with the persisted `dispatching` boundary and bounded-race semantics above;
- add the barrier-controlled tests to architecture requirements;
- record TAB-FND-021 as resolved in `coordination/CHATGPT_HANDOFF.md`;
- update `coordination/STATE.json` to zero open majors only after the architecture change is committed.

Production implementation remains blocked until this specification update is committed and reviewed.
