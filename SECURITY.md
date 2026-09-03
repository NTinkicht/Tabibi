# Tabibi Security & Privacy Baseline v0.1

Tabibi is healthcare-adjacent software. Treat patient and operational clinic data as sensitive by default.

## Data minimization
- Do not collect diagnosis, treatment, prescription or insurance data for the MVP.
- Separate authentication identity from queue-specific operational data.
- Prefer opaque internal IDs and non-enumerable external access tokens.
- Do not expose patient names or phone numbers in shared/public queue views.

## Authentication and authorization
- Clinic staff must authenticate.
- Authorization is clinic-scoped and role-aware.
- Patient access to an account-linked queue entry requires ownership or explicit delegated access.
- Guest/reception-created queue access requires a high-entropy secret token or equivalent mechanism.
- Administrative operations such as reorder/priority insertion/recovery transitions require explicit permission and audit reason.

## Secrets
- Never commit secrets, provider credentials, tokens or production connection strings.
- Use environment variables/secrets management.
- Example env files must contain placeholders only.

## Auditability
Audit meaningful operational changes including:
- queue entry creation/removal;
- check-in;
- call;
- consultation start/completion;
- cancellation/no-show;
- manual reorder/priority insertion;
- session pause/resume/delay;
- administrative recovery transitions.

Audit records should identify actor, action, target, clinic/session context, timestamp and relevant reason while avoiding unnecessary sensitive snapshots.

## Logging
Operational logs must not include:
- passwords;
- session tokens;
- guest access tokens;
- phone numbers unless strictly redacted;
- patient names unless unavoidable and appropriately protected;
- raw notification payloads containing sensitive data.

## Queue privacy
- Never provide an API that allows unauthenticated enumeration of queue entries.
- Do not reveal identities of patients ahead/behind another patient.
- Patient-facing queue position should be derived only for the authorized entry.
- Public waiting-room displays must use non-identifying labels if implemented.

## Integrity and concurrency
- Queue state/order changes require a transaction/consistency strategy.
- State transitions are validated server-side.
- Client-provided queue position/order is never trusted directly.
- Idempotency is required for externally retried mutation/notification flows where duplicate effects would be harmful.

## Web/API baseline
Before public pilot:
- HTTPS only in production;
- secure cookies/session configuration where applicable;
- CSRF protection for cookie-authenticated mutations;
- input/schema validation at trust boundaries;
- rate limiting for authentication and guest-token endpoints;
- protections against token enumeration/brute force;
- safe headers/CSP appropriate to framework;
- dependency and secret scanning in CI where feasible.

## Retention and deletion
Retention rules must be explicit before production. Operational queue history should not be retained indefinitely merely because storage is cheap.

Deletion/anonymization requirements must be considered separately for authentication accounts, queue records, audit obligations and analytics.

## Notification privacy
SMS/WhatsApp/push content should reveal the minimum required information. Avoid medical specialty/condition details in lock-screen-visible messages unless product policy explicitly permits it.

## Threats to explicitly test/review
- cross-clinic authorization bypass;
- patient A reading patient B queue state;
- guest token enumeration;
- stale concurrent reorder/update causing lost entries;
- duplicate request causing duplicate queue entry;
- privilege escalation receptionist -> platform/other clinic;
- stored/reflected XSS through clinic/patient-entered display strings;
- SQL/query injection at dynamic filters;
- sensitive-data leakage through logs/errors/analytics;
- notification sent to wrong/recycled contact information;
- replay of state-transition requests.

## Regulatory note
The engineering team must not invent legal compliance claims. Algeria-specific health/privacy regulatory requirements must be researched and confirmed before production deployment and translated into explicit requirements/decisions.
