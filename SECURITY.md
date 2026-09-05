# Tabibi Security & Privacy Baseline v0.3

Tabibi is healthcare-adjacent software. Treat patient and operational clinic data as sensitive by default.

## Data minimization
- Do not collect diagnosis, treatment, prescription or insurance data for the MVP.
- Separate authentication identity from queue operational data.
- Prefer opaque internal IDs and non-enumerable external access credentials.
- Do not expose patient names/phone numbers in shared/public queue views.

## Authentication and authorization
- Clinic staff authenticate.
- Authorization is clinic-scoped and role-aware.
- Minimum MVP roles: `doctor`, `receptionist`, `clinic_admin`, `platform_admin`.
- `platform_admin` has no implicit unrestricted patient-data access.
- Account-linked patient access requires ownership or explicit delegated access.
- Every mutation revalidates clinic scope server-side; client-supplied IDs never expand scope.
- Priority, restore and transfer require explicit permission and non-empty audit reason.

## Guest access credential model
The durable guest credential is a high-entropy bearer secret. The raw bearer value is issued once and never persisted. Persist only a one-way verifier; the verifier itself must not authenticate.

### Transport decision: single-use exchange link
The patient contact channel receives a short-TTL single-use opaque **exchange ID**, not the durable guest bearer credential.

Rules:
- exchange ID default TTL <=10 minutes;
- only a one-way exchange verifier is stored;
- first successful use atomically consumes the exchange ID;
- the server sets the real guest bearer credential in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie and redirects to a clean URL with no credential;
- exchange route uses `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, restrictive CSP and no third-party resources;
- analytics are disabled on exchange endpoints;
- reverse-proxy/CDN/application access logging must redact the exchange path segment before persistence;
- browser history may contain the expired one-time exchange URL but it cannot grant access after first use/expiry;
- rotation/reissue atomically revokes previous guest verifier and outstanding exchange links;
- exchange and guest endpoints are rate-limited and protected against brute force/enumeration.

Never place the durable guest bearer credential in a URL, logs, analytics or notification payload logs.

## Secrets
- Never commit secrets/provider credentials/production connection strings.
- Use environment secrets management.
- Example env files contain placeholders only.
- Guest bearer and exchange IDs are patient-scoped secrets and require redaction controls above.

## Auditability
Audit: queue creation/removal, appointment changes, check-in, call, consultation start/completion, cancellation/no-show, priority, restore/transfer, session open/pause/resume/delay/close/cancel, credential rotation/revocation and elevated admin recovery.

Audit records identify actor/action/target/clinic/session/timestamp/reason while avoiding unnecessary sensitive snapshots.

## Logging
Operational logs must not contain passwords, session tokens, raw guest credentials, raw exchange IDs, unredacted phone numbers/patient names, or raw sensitive notification bodies. Correlation IDs must be non-sensitive.

## Queue privacy
- No unauthenticated enumeration endpoint.
- Never reveal identities of patients ahead/behind.
- Public waiting-room labels are non-secret and cannot authorize any patient endpoint.
- Guest credential and public label are distinct fields.

## Integrity and concurrency
- Queue/session/appointment transitions validated server-side.
- Lifecycle state gates every mutation.
- Client-provided queue order is never trusted directly.
- PostgreSQL constraints/locking provide defense-in-depth for canonical states, session generation uniqueness, priority-slot consistency, one active doctor service stream and appointment/queue cardinality.
- Idempotency is mandatory for externally retried mutation/notification flows.

## Web/API baseline before pilot
- HTTPS only;
- secure cookie/session configuration;
- CSRF protection for cookie-authenticated mutations;
- trust-boundary schema validation;
- rate limits for auth/exchange/guest endpoints;
- timing-safe verifier comparison appropriate to construction;
- CSP/security headers;
- dependency/secret scanning in CI;
- tenant-isolation API tests.

## Notification privacy and reliability
Messages reveal only minimum operational information. Avoid medical specialty/condition information in lock-screen-visible text.

Notification provider failure never rolls queue state back. Delivery lifecycle, retry limits, idempotency, supersession and dead-letter behavior are defined in `ARCHITECTURE.md`. Dead-letter/operator signals must not expose raw provider credentials or sensitive payloads.

## Retention/deletion
Explicit retention/anonymization policy is required before production for accounts, appointments, queue records, audit history and analytics. Do not retain operational history indefinitely merely because storage is cheap.

## Threats to test/review
- cross-clinic authorization bypass;
- patient A reading patient B state;
- guest/exchange enumeration or brute force;
- persisted verifier used as a credential;
- exchange-link replay;
- revoked/rotated credential replay;
- credential leakage through URL/access log/Referer/browser history;
- public label used for guest authorization;
- stale concurrent reorder/update/lifecycle races;
- duplicate requests creating duplicate appointments/queue entries;
- privilege escalation;
- XSS/SQL/query injection;
- sensitive log/error/analytics leakage;
- notification to wrong/recycled contact;
- state-transition replay;
- cross-session same-doctor parallel consultation.

## Regulatory note
Do not invent legal compliance claims. Algeria-specific personal-data/health-adjacent requirements must be researched and confirmed before production deployment and translated into explicit requirements/decisions. This is tracked as a release-hardening item, not assumed satisfied by this baseline.
