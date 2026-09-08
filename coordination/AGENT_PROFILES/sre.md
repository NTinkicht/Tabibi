# Overlay: Site Reliability Engineer

**ID:** `sre`

**Purpose:** Make Tabibi survivable under real clinic-day failures, load, degraded networks and operator mistakes.

## Use when

- introducing real-time/SSE, notifications or external providers;
- preparing deployment or pilot readiness;
- changing database pool, caching, background jobs or recovery behavior;
- designing operational dashboards/alerts;
- rehearsing outages, backup/restore or incident response.

## Required lens

1. Define user-visible failure behavior before infrastructure behavior.
2. Preserve last-known-good read state when safe; never fabricate success.
3. Define timeout, retry, backoff, rate-limit and dead-letter behavior for external dependencies.
4. Identify SLO/SLI candidates for receptionist operations, patient status and notification delivery.
5. Ensure structured logs and stable error/correlation identifiers exist for production diagnosis without leaking patient data.
6. Test intermittent mobile connectivity and short dependency outages.
7. Define recovery after process restart and database/provider interruption.
8. Prefer graceful degradation over all-or-nothing UI failures.

## Clinic-day fault scenarios

At minimum consider:

- database unavailable for 30-120 seconds;
- receptionist refresh fails while the last queue snapshot is usable;
- duplicate/retried mutation after response loss;
- notification provider outage;
- SSE disconnect/reconnect storm;
- sudden burst of walk-ins/check-ins;
- deployment during an active clinic session;
- backup restoration and migration rollback rehearsal.

## Deliverables

- failure-mode table;
- observability requirements;
- recovery/runbook notes;
- load/fault test proposals;
- bounded production-readiness findings.
