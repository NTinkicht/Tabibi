# Recovery objectives and operator launch readiness (TAB-P1-08)

This document fixes recovery and latency targets **before** any capacity or disaster-recovery test is run, and gives operators a launch-readiness checklist. It is a planning and acceptance aid, not a certification: nothing here proves that a production environment meets these targets, and it does not mark TAB-P1-08 `VERIFIED`.

Every target below is **PROPOSED**. They are conservative defaults chosen so that tests have something fixed to be measured against. The clinic owner or operations lead must confirm or change them before launch; a change is a documentation edit plus a rerun of the affected drill. No hosting vendor is chosen here and nothing is deployed.

## 1. Recovery objectives (PROPOSED)

RPO is the largest acceptable window of lost committed writes. RTO is the largest acceptable time from failure detection to normal service.

| Failure class | RPO | RTO | Recovery path |
| --- | --- | --- | --- |
| Web process crash or restart | 0 (all state is in PostgreSQL) | 5 minutes | Restart the container; `GET /api/ready` must return 200 before traffic resumes |
| Notification worker stopped | 0 (intents stay pending in the outbox) | 30 minutes | Restart `npm run worker:notifications`; due intents dispatch on the next tick, guest-link intents past their expiry are scrubbed rather than sent |
| Database corruption or bad migration | 15 minutes | 4 hours | Restore the latest verified backup into a fresh database, verify, then cut over per `docs/release/deployment-cutover-rollback-runbook.md` |
| Full host or region loss | 1 hour | 8 hours | Rebuild from the image and restore the latest off-host backup |

Notes:

- A clinic day continues on paper during an outage. Queue order after recovery is the order committed in PostgreSQL; anything staff wrote on paper during the outage is entered by the receptionist afterwards and is not replayed automatically.
- The RPO values assume backups are taken at least that often and stored off-host. Scheduling, retention, encryption and key management are operational work outside the repository (`docs/DATABASE_RECOVERY_REHEARSAL.md` states the same boundary).
- Restore never overwrites the live database in place. Restore into a new database, compare, then cut over.

## 2. Latency budgets (PROPOSED)

A p95 budget is measured server-side over a rolling hour of real clinic traffic, or over a synthetic run. The budgets below are defined now so that the load harness and any later monitoring have fixed targets. They replace the loose regression alarm in `docs/release/clinic-day-load-baseline.md` only once an owner confirms them and a measured baseline exists.

| Operation | Route | p95 budget |
| --- | --- | --- |
| Public discovery search | `src/app/api/public/discovery/route.ts` | 800 ms |
| Public booking | `src/app/api/public/bookings/route.ts` | 1,500 ms |
| Booking status read | `src/app/api/public/bookings/status/route.ts` | 500 ms |
| Guest live status read | `src/app/api/guest/status/route.ts` | 500 ms |
| Staff queue read | `src/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/route.ts` | 600 ms |
| Staff queue command (call, start, complete, check-in) | `src/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/commands/route.ts` | 1,000 ms |
| Readiness | `src/app/api/ready/route.ts` | 200 ms |

A budget breach in a rehearsal is a finding, not something to fix by raising the number.

## 3. Drills

Run every drill against a non-production target with synthetic data only. Record operator, target build SHA, date, result and evidence for each.

1. **Backup and restore.** Run `npm run db:rehearse-recovery` as described in `docs/DATABASE_RECOVERY_REHEARSAL.md`. Pass condition: exits zero, migration names and checksums match, bounded row counts match. Record the elapsed time and compare it with the database RTO above.
2. **Clinic-day load.** Run `npm run db:clinic-day-load` as described in `docs/release/clinic-day-load-baseline.md`. Pass condition: zero operation errors. Compare the reported p95 with the budgets above and record any breach.
3. **Web restart.** With synthetic queue activity running, stop and start the web container. Pass condition: `GET /api/health` and `GET /api/ready` return 200 within the web RTO, no committed queue entry is lost or reordered, and a guest status stream reconnects and shows the same queue version or a newer one.
4. **Worker restart.** Stop `npm run worker:notifications`, create notification intents, restart it. Pass condition: due intents are delivered once, none twice, and logs carry counts only.
5. **Database unavailable.** Make the database unreachable for one minute. Pass condition: `GET /api/health` stays 200, `GET /api/ready` returns 503, API calls fail closed with an error and no partial write, and service recovers without a restart once the database returns.
6. **Cutover and rollback.** Rehearse the sequence in `docs/release/deployment-cutover-rollback-runbook.md` end to end, including the previous known-good SHA.

## 4. Operator launch-readiness checklist

All items must be checked, with evidence, before a clinic goes live. An unchecked item is a no-go unless the owner records an explicit written exception.

- [ ] Recovery and latency targets in sections 1 and 2 are confirmed or replaced by the owner, with the date.
- [ ] Every drill in section 3 has been run on the release candidate SHA and passed, or has a recorded finding with an owner.
- [ ] Production runtime variables listed in `docs/deploy/container.md` are set from the secret store; none is in the image, repository or logs.
- [ ] Migrations run as a separate one-off step and were rehearsed against a copy of production-shaped data.
- [ ] A backup exists, was restored successfully into a fresh database, and is stored off-host.
- [ ] The notification worker runs as its own process and its restart was rehearsed.
- [ ] `docs/release/penetration-checklist.md` was executed on the release candidate and every row has a recorded result.
- [ ] `docs/release/release-threat-model-delta.md` no-go invariants all hold.
- [ ] Receptionists and doctors have practised the paper fallback: how to continue the day during an outage and how to enter paper records afterwards.
- [ ] Receptionists know where the notification delivery exceptions page is and what to do with a delivery that failed.
- [ ] A named person is on call for the first clinic day, with the rollback owner and contact path written down.

## 5. Not covered here

Hosting vendor selection, the production backup scheduler, off-host storage choice, monitoring and alerting vendor, executing the drills, and marking TAB-P1-08 `VERIFIED` (which needs an exact commit, test and release artifact and an independent review).
