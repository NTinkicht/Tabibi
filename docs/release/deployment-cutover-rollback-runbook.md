# Deployment, cutover and rollback runbook

This WU52 runbook turns Epic #7 release evidence into a deterministic operator sequence. It is intentionally hosting-provider-neutral: the repository does not define a production cloud/vendor, so this document names only repository-supported commands and evidence boundaries.

No production credentials, patient data, external provider traffic, paid APIs, PAYG/overage/credits, Vertex, OpenRouter, auto-topups, or retired Gemini Agent/Chat are required by this runbook.

## Release inputs

Before a deployment attempt, record all of the following in the release record:

- exact Git commit SHA being deployed;
- exact-head CI run showing `Quality and build`, `PostgreSQL integration`, and `Browser smoke` success;
- independent non-author review verdict for that unchanged SHA;
- database target/environment identifier without embedding credentials;
- operator identity and start time;
- latest successful non-production recovery rehearsal evidence.

A head mutation invalidates the prior CI/review pair. Do not deploy a different SHA under an older approval.

## Pre-deploy GO / NO-GO gate

Deployment is **NO-GO** if any item below is false:

1. `npm ci` can resolve the lockfile-supported dependency set using Node 20 and npm 10+.
2. `npm run format`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` are represented by green exact-head CI evidence.
3. PostgreSQL integration and browser smoke are green on that exact head.
4. The independent non-author reviewer reports no unresolved Medium+/Major+/High+/Critical/Blocker finding.
5. The release threat-model security invariants remain satisfied.
6. A recoverable database backup exists according to the production platform's approved backup mechanism.
7. The repository recovery rehearsal remains green in a guarded non-production target via `npm run db:rehearse-recovery`.
8. The operator has identified the previous known-good application SHA and the schema/migration boundary between it and the candidate.

The repository rehearsal command is evidence that backup/restore mechanics are testable; it is **not** permission to point rehearsal tooling at production.

## Build and migration sequence

Use the immutable candidate SHA throughout the attempt.

1. Fetch/check out the exact approved SHA.
2. Install dependencies from the committed lockfile with `npm ci`.
3. Build the application with `npm run build`.
4. Confirm a current database backup exists using the deployment platform's approved production backup facility.
5. Apply repository migrations once with `npm run db:migrate` against the intended production database connection supplied through the platform's secret/configuration mechanism.
6. If migration fails, stop the cutover. Do not repeatedly retry a partially understood migration failure.
7. Start the built application using the platform-equivalent of `npm start`.

Do not run `db:seed`, `db:reset:test`, `db:clinic-day-load`, or `db:rehearse-recovery` against production.

## Cutover verification

Immediately after the new application instance is serving traffic, verify with privacy-minimal operational checks:

- the application process remains healthy and responsive;
- a non-sensitive landing/readiness path responds successfully;
- authentication/session initialization behaves as expected without exposing token or credential material;
- a clinic-scoped read remains tenant-scoped;
- the public waiting-room path renders only privacy-safe public labels/status fields;
- Arabic/RTL and French/LTR surfaces load without changing authorization/data-shaping behavior;
- no new repeated database, migration, provider, or unhandled-exception errors appear in bounded operational logs;
- notification state is not interpreted as confirmed delivery when durable completion evidence is absent.

Use synthetic/non-patient verification data where a mutation check is required. Do not place real patient/contact/clinical content into release notes, screenshots, logs, or metrics.

## Observation window and stop conditions

Keep the candidate under explicit observation until the deployment platform's normal release stabilization window has passed. Rollback evaluation is mandatory if any of these occurs:

- cross-clinic or cross-patient data exposure;
- public display leaks private names, internal patient IDs, queue-entry IDs, contact details, or clinical content;
- unauthorized/malformed mutations create durable side effects;
- retries/refreshes duplicate a release-critical mutation or regress terminal queue state;
- database errors indicate migration/schema incompatibility;
- notification faults become false confirmed-delivery states;
- sustained health/readiness failure or crash loop;
- a new Medium+/Major+/High+/Critical/Blocker release-safety defect is confirmed.

Security/privacy isolation failure is an immediate stop condition, not an observe-and-wait condition.

## Rollback decision tree

### A. Application-only defect with backward-compatible schema

If the schema remains compatible with the previous known-good application SHA:

1. remove/stop traffic to the faulty candidate according to the hosting platform's normal mechanism;
2. redeploy the previous known-good application SHA;
3. do **not** automatically reverse database migrations merely because application code was rolled back;
4. perform the post-rollback checks below.

### B. Migration or schema defect

Treat database rollback separately from code rollback. Repository migrations are forward operations; this runbook does not claim every migration is mechanically reversible.

1. stop further rollout/migration attempts;
2. preserve logs and the exact failing SHA/migration evidence without sensitive payloads;
3. determine whether the previous application can safely run against the current schema;
4. if yes, roll application code back while leaving the schema intact and verify behavior;
5. if no, use the approved production database restore procedure from the pre-deploy backup rather than inventing ad-hoc reverse SQL;
6. after restore, deploy the application SHA known to match the restored database state.

Never perform destructive reverse-SQL improvisation on production when the repository does not contain an independently reviewed reversible migration procedure.

### C. Notification/provider incident only

If core application/database state is sound but a notification provider or completion-persistence path is degraded:

- do not claim confirmed delivery without durable evidence;
- preserve uncertain/reconcilable state rather than blindly re-sending;
- prefer disabling/isolating the affected dispatch path through an approved operational control over rolling back unrelated queue functionality;
- escalate to code rollback only when the candidate introduced the fault and rollback is schema-safe.

## Post-rollback verification

A rollback is not complete until all applicable checks pass:

1. record the active application SHA and database restore/schema state;
2. verify application health/readiness;
3. verify one clinic cannot read or mutate another clinic's state;
4. verify public display still excludes private names and internal identifiers;
5. verify Arabic and French surfaces reach the same authorization/data-shaping behavior;
6. verify a terminal queue state does not regress after refresh/reconnect;
7. verify notification status does not falsely report delivery after provider/store faults;
8. confirm operational logs remain privacy-minimal;
9. open a bounded remediation issue/PR for the failed candidate before any re-attempt.

## Release evidence record

For every deployment or rollback, retain a concise record containing:

- candidate SHA;
- previous known-good SHA;
- CI run identifier;
- independent reviewer/verdict reference;
- migration outcome;
- backup/recovery evidence reference;
- cutover start/end times;
- GO/NO-GO decision and reason;
- rollback decision and resulting active SHA, if applicable;
- privacy-safe verification outcomes.

Never copy secrets, database URLs, access tokens, patient names, phone numbers, clinical content, or raw notification payloads into this record.

## WU52 gate

This runbook is merge-eligible only when exact-head CI is green and an eligible non-author reviewer verifies that the sequence is grounded in repository capabilities, does not imply unsafe production rehearsal behavior, distinguishes code rollback from schema recovery, and contains no unresolved Medium+/Major+/High+/Critical/Blocker finding.
