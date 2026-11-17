# Penetration checklist (TAB-P0-15)

Manual and scripted attack checklist for a release candidate. It complements `docs/release/release-threat-model-delta.md`, which holds the threat matrix and release no-go invariants. Run it only against a non-production target seeded with synthetic data. Never point it at production, real patient data, or real credentials.

Each row names an attack to attempt, the refusal that must be observed, and the existing automated test that covers it. A row with "no automated coverage" is an honest gap: perform it by hand and record the result. A unit test (`tests/unit/penetration-checklist.test.ts`) fails when a path cited below no longer exists, so the document cannot silently drift from the repository.

Record for every row: tester, target build SHA, date, result (refused for the stated reason, or finding), and evidence. A refusal only counts when it is the stated refusal (for example 403 for role, 404 for foreign tenant), not an unrelated 400 or 500. Always run a positive control first (same request, valid actor) to prove the route works.

## 1. Tenant isolation (staff)

| Attack | Expected | Automated coverage |
| --- | --- | --- |
| Staff of clinic A calls every `src/app/api/clinics/[clinicId]/**` route with clinic B ids | Not found or forbidden, no data, no mutation | `tests/integration/cross-tenant-route-matrix.test.ts`, `tests/integration/cross-tenant-sessions-queue.test.ts`, `tests/integration/cross-tenant-appointments.test.ts` |
| Role downgrade: receptionist calls doctor-only or admin-only routes (`src/app/api/clinics/[clinicId]/memberships/route.ts`, `src/app/api/clinics/[clinicId]/staff-invites/route.ts`) | 403 | `tests/api/staff-route-boundary-matrix.test.ts` |
| Malformed or non-UUID clinic id before authorization | Rejected without database side effect | `tests/api/wu189-session-operation-params.test.ts` |
| Revoked, expired or tampered staff session token | 401 | `tests/integration/staff-session-revocation.test.ts` |

## 2. Guest credential classes

| Attack | Expected | Automated coverage |
| --- | --- | --- |
| Present the booking-origin bearer to the cookie-only status route, and the status cookie as an `Authorization` bearer | Both rejected; classes are non-interchangeable | `tests/api/guest-credential-class-boundary.test.ts` |
| Replay a consumed or expired exchange id (`src/app/api/guest/exchange/[exchangeId]/route.ts`) | Single use, rejected after consumption or expiry | `tests/api/guest-exchange.test.ts` |
| Use a credential from a source entry after transfer | Source credential revoked | `tests/integration/guest-status-credential-rotation.test.ts` |
| Read status or inbox of another guest by guessing item ids (`src/app/api/guest/inbox/[itemId]/read/route.ts`) | Not found | `tests/api/guest-inbox.test.ts` |
| Open the live stream without a valid credential (`src/app/api/guest/status/stream/route.ts`) | Rejected, no event data | `tests/api/guest-status-stream.test.ts` |

## 3. Public surfaces

| Attack | Expected | Automated coverage |
| --- | --- | --- |
| Inspect discovery and bookable-session responses (`src/app/api/public/discovery/route.ts`, `src/app/api/public/bookable-sessions/route.ts`) for contacts, patient data or other tenant data | Privacy-minimal fields only | `tests/api/public-discovery.test.ts`, `tests/api/public-bookable-sessions.test.ts` |
| Read the public waiting-room display for names, patient ids or queue-entry ids (`src/app/api/public/clinics/[clinicId]/sessions/[sessionId]/waiting-room/route.ts`) | Display labels only, rendered row present (positive control) | `tests/integration/waiting-room-public.test.ts` |
| Replay a booking request, or swap ciphertext between two bookings (`src/app/api/public/bookings/route.ts`) | One booking per key, authentic-but-foreign ciphertext rejected | `tests/integration/public-guest-booking.test.ts` (replay convergence; 'rejects swapping two genuine encrypted replay receipts between bookings') |
| Cancel or check in with a foreign or malformed bearer (`src/app/api/public/bookings/cancel/route.ts`, `src/app/api/public/bookings/check-in/route.ts`) | Rejected, entry unchanged | `tests/api/guest-credential-class-boundary.test.ts` |

## 4. Patient accounts

| Attack | Expected | Automated coverage |
| --- | --- | --- |
| Use a staff token on patient routes, or a patient token on staff routes (`src/app/api/patient/session/route.ts`) | Rejected with the unauthenticated response; neither class is accepted by the other's routes | `tests/integration/patient-session.test.ts` |
| Access another account's dependent by id (`src/app/api/patient/dependents/[dependentId]/route.ts`) | Not found | `tests/integration/patient-dependents-route.test.ts` |
| Brute-force sign-in or recovery redemption (`src/app/api/patient/recovery/redeem/route.ts`) | Uniform refusal with no account enumeration; throttling to be confirmed by hand and recorded | `tests/integration/patient-recovery-route.test.ts` |

## 5. Notification delivery

| Attack | Expected | Automated coverage |
| --- | --- | --- |
| Inspect outbox and receipt rows at rest in a seeded database for plaintext guest link material | Envelope ciphertext only | `tests/integration/guest-link-intents.test.ts` |
| Dispatch route with a foreign clinic id or malformed id (`src/app/api/clinics/[clinicId]/notifications/dispatch/route.ts`) | Rejected, no dispatch state change | `tests/integration/notification-dispatch-api.test.ts` |
| Dead-letter view or handled marker across tenants (`src/app/api/clinics/[clinicId]/notifications/dead-letters/route.ts`) | Foreign rows invisible | `tests/integration/notification-dead-letter-api.test.ts` |
| Force provider or store faults and look for false delivered state | Inbox persistence, provider/network, claim-store and completion-store failures are surfaced, never reported delivered | `tests/unit/notification-fault-injection.test.ts` |

## 6. Queue integrity under concurrency

| Attack | Expected | Automated coverage |
| --- | --- | --- |
| Concurrent call versus call, and call versus transfer, on the same session | At most one called or consulting patient; the loser is rejected as stale or not next | `tests/integration/queue-lifecycle.test.ts` |
| Concurrent restore versus cancel (or cancel versus restore) of the same entry | Both may succeed in lock order (the later command applies to the state left by the earlier one); the entry and its appointment end in the state of the last command, with no duplicate entry | `tests/integration/queue-restore-race.test.ts` |
| Second restore queued behind a first restore, or a priority insert queued behind a transfer of the same entry | The later command is rejected and leaves no priority state | `tests/integration/queue-restore-race.test.ts` |
| Priority move versus call or cancel of the same or another entry | Move queued behind a call or cancel is rejected as stale; a move queued ahead applies and the later call is rejected as not next | `tests/integration/queue-priority-race.test.ts` |
| Replay a command with the same idempotency key | Exact retry returns the original result, no second event | `tests/integration/notification-outbox.test.ts` |

## 7. Operator tooling

| Attack | Expected | Automated coverage |
| --- | --- | --- |
| Run load or recovery tooling with a production-like database name or without the explicit opt-in | Refused before any connection | `tests/unit/clinic-day-load.test.ts` |
| Apply the migration chain from empty and re-apply | Clean, ordered, repeatable | `tests/integration/migration-chain.test.ts` |

## Not covered by this checklist

- CI secret scanning (the workflow lives under protected `.github/**` and needs an owner-approved change).
- Forward and rollback migration drills: see `docs/DATABASE_RECOVERY_REHEARSAL.md` and `docs/release/deployment-cutover-rollback-runbook.md`.
- Dependency audit: run `npm audit` as part of release acceptance.
