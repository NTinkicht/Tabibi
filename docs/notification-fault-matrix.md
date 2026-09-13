# Notification fault matrix

WU44 establishes a deterministic, zero-external-traffic baseline for recoverable notification delivery failures.

| Fault boundary | Expected behavior | Recovery owner |
| --- | --- | --- |
| In-app inbox persistence throws | Adapter returns bounded `unknown` / `in_app_persist_exception`; never reports delivery; raw exception text is not returned | Dispatch lifecycle retries or resolves through existing unknown-result policy |
| Provider/network adapter throws | Dispatch service normalizes to bounded `unknown` / `provider_exception`; persists only the bounded code; raw provider exception text is not persisted or emitted through the tested observer path | Dispatch lifecycle / operator observability |
| Dispatch-store claim throws before provider invocation | Error is surfaced; provider is not invoked; no success can be reported | Database/operator recovery before retry |
| Dispatch-store completion throws after provider invocation | Error is surfaced; the service does not return a completed success result | Database/operator recovery plus idempotent retry/reconciliation using the existing provider idempotency key |

All WU44 fixtures are synthetic and deterministic. The tests perform no external provider or network calls and require no paid capacity, PAYG, credits, Vertex, OpenRouter, or auto-topups.
