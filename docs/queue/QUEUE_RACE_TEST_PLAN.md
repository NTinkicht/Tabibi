# Queue race executable regression plan

WU #590 converts the merged adversarial concurrency contract from #578/#582 into executable regressions without changing product semantics.

## First implementation slice

1. **Concurrent call-next / single-called-slot**: two commands for the same canonical next entry, issued from the same eligible queue state with distinct idempotency keys, must not both commit. Exactly one command may occupy the session's called slot; the competing command must fail after it observes the committed transition.
2. **Stale priority override**: two priority mutations from the same observed `queue_order_version` cannot both commit. After one mutation advances the version, the other must fail as stale until it deliberately rereads and retries.
3. **Call-next wins versus stale priority**: if call-next advances queue state/version first, an override based on the old version must fail closed rather than silently affecting later ordering.
4. **Priority override wins before call-next**: force the opposite serialization order. Commit the priority override first, then invoke call-next against the newly committed version. The regression must assert that call-next selects the entry dictated by the new priority order and that the durable queue version and audit record correspond to that committed override before the call-next transition. This proves both operations share the required session serialization boundary and prevents an implementation that ignores a just-committed override.

## Regression requirements

- exercise the existing queue service/database boundary rather than a duplicate model;
- assert durable post-race state, not only returned command results;
- cover **both** serialization orders for call-next versus priority override;
- in the priority-first case, assert the selected entry plus committed queue version and audit state;
- preserve registration order and deterministic eligibility/order semantics;
- prove retries are explicit and version-bound;
- leave ETA, authorization, deployment, and production behavior unchanged.

The canonical branch now contains focused PostgreSQL integration regressions for all four oracles. Source changes remain unnecessary because the existing session-row locking and queue-version seam is sufficient to drive the races deterministically at the service/database boundary.

Material-Author: chatgpt
