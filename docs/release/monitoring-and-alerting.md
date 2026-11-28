# Monitoring and alerting guide (TAB-P1-08 slice 2)

This guide lists the operator signals Tabibi already emits and **proposes** alert rules for them. It is a planning aid, not a certification: every threshold below is `PROPOSED` and must be confirmed by the owner and operations before launch. It selects no monitoring vendor and adds no exporter; any log shipper or uptime checker that can read JSON lines and poll HTTP is sufficient.

## Privacy rule for every signal

Signals carry counts, states, status codes, durations and opaque ids only. Never add patient names, phone numbers, guest credentials, notification bodies or request payloads to a log line, alert text or dashboard. The logger redaction list in `src/platform/observability/logger.ts` is a safety net, not permission to log such fields.

## Signal inventory

| Signal | Where it comes from | Healthy | Unhealthy |
|---|---|---|---|
| `GET /api/health` | `src/app/api/health/route.ts` | 200, `status: ok` | no response or non-200: process down |
| `GET /api/ready` | `src/app/api/ready/route.ts` | 200, `status: ready` | 503 `not_ready`: database unreachable |
| `request completed` log line | `src/platform/http/request-context.ts` | `status` < 500, `durationMs` within budget | sustained `status` >= 500 or rising `durationMs` |
| `request failed` log line | `src/platform/http/request-context.ts` | absent | any occurrence (the client received a 500) |
| `x-request-id` response header | `src/platform/http/request-context.ts` | present | used to correlate a client report with the log line |
| `notification.worker.tick` | `scripts/worker/notification-dispatch.ts` | printed every dispatch interval | missing for several intervals: worker stalled |
| `notification.worker.tick_failed` | `scripts/worker/notification-dispatch.ts` | absent | repeated: dispatch loop failing |
| `notification.worker.fatal` | `scripts/worker/notification-dispatch.ts` | absent | any occurrence: worker exited non-zero |
| `retention.sweep` | `scripts/worker/retention-sweep.ts` | scheduled run, empty `failed` list | missing run or non-empty `failed` |
| `retention.sweep.fatal` | `scripts/worker/retention-sweep.ts` | absent | any occurrence |

The `notification.worker.tick` line also carries the counters `clinics`, `claimed`, `delivered`, `retried`, `deadLettered`, `suppressed`, `errors`, `scrubbed` and `pushExpired`.

## Database-side checks

Run these read-only checks from an operator session on the production replica or primary. They return aggregate counts only.

```sql
SELECT state, count(*) FROM notification_outbox GROUP BY state;
SELECT min(created_at) FROM notification_outbox WHERE state = 'pending';
```

A growing `pending` count with an old `min(created_at)` means the worker is not draining. A growing `dead_letter` count means deliveries are exhausting retries. Receptionists see recent dead letters per clinic in the staff notifications exceptions page (`src/app/operations/[clinicId]/notifications/page.tsx`); the privacy-minimal query behind it is `src/modules/notification-outbox/observability.ts`.

## Proposed alert rules (PROPOSED)

| Rule | Condition | Severity | First response |
|---|---|---|---|
| Process down | `/api/health` fails 3 consecutive 30 s checks | page | restart the web process; follow `docs/release/deployment-cutover-rollback-runbook.md` if a release is implicated |
| Database not ready | `/api/ready` returns 503 for 2 consecutive minutes | page | check database reachability and connection limits; if data is damaged use `docs/DATABASE_RECOVERY_REHEARSAL.md` |
| Server errors | `request failed` or `operational request failed` (emitted by `operationalJson` routes such as patient cancel and reschedule) occurs more than 5 times in 5 minutes combined | page | find the `requestId` in the log, identify the route, roll back if the release is recent |
| Slow requests | p95 of `durationMs` exceeds the production p95 budget for 10 minutes | ticket | compare with `docs/release/clinic-day-load-baseline.md`; budgets are defined in the recovery-objectives guide once merged |
| Worker silent | no `notification.worker.tick` for 5 dispatch intervals | page | restart `npm run worker:notifications`; check the outbox `pending` age |
| Worker failing | `notification.worker.tick_failed` in 3 consecutive ticks, any `notification.worker.fatal`, or a nonzero `errors` count in `notification.worker.tick` for 3 consecutive ticks (batch, guest-link or expiry errors are caught inside the tick and do not dead-letter) | page | inspect worker stderr, restart, confirm `/api/ready` |
| Dead letters rising | `deadLettered` is above 0 in any tick, or the `dead_letter` row count grows | ticket | clinic staff contact the affected patients manually from the exceptions page |
| Retention missed | no `retention.sweep` in 36 hours, or non-empty `failed` | ticket | run `npm run worker:retention` manually and inspect the failed task names |

## Verification

Evidence that this guide matches the code is the unit test `tests/unit/monitoring-and-alerting-doc.test.ts`, which fails when a cited path, route or log event name no longer exists in its source file. It does not prove that alerts fire in production. A staged restart drill that observes each rule fire remains open work under TAB-P1-08 and the PRODUCT.md row stays unverified until then.
