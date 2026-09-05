# TAB-FND-021 — Provider-dispatch boundary resolution

Status: **RESOLVED / INCORPORATED INTO CANONICAL ARCHITECTURE**
Severity: **MAJOR**
Category: notification / concurrency

The accepted provider-dispatch boundary is now incorporated in canonical `ARCHITECTURE.md` (first in v0.10 and retained in v0.11).

Canonical contract:
1. Provider-bound intents persist retryable states `pending|failed|unknown`, a committed `dispatching` boundary, outcomes `delivered|failed|unknown|dead_letter`, and direct `skipped_obsolete` from retryable states when relevance validation fails.
2. Immediately before `dispatching`, the worker transactionally revalidates supersession, stream-head version, terminal/session state and attempt eligibility.
3. If obsolete, the intent becomes `skipped_obsolete` and provider invocation never starts.
4. Only after committed `dispatching` may provider invocation begin.
5. Once invocation begins, the attempt is irrevocable/in-flight; later state mutations cannot recall it.
6. Newer/terminal state supersedes older not-yet-started intents while the newer/terminal version remains deliverable after any already-started attempt.
7. Provider idempotency protects retry/unknown-result duplicates of the same logical intent and does not order different versions.
8. Unknown-result recovery retries the same logical operation/idempotency key.

Required barrier/crash tests remain canonical in `ARCHITECTURE.md`: mutation before dispatch suppresses the old call; mutation after dispatch begins permits the bounded in-flight result while preserving the newer version; unknown retries reuse the same key; terminal cancellation suppresses older not-yet-started mutable intents; crash windows around `dispatching` recover without silent loss.

No further architecture update is pending for TAB-FND-021.