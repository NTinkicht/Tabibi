# Tabibi Security & Privacy Baseline v0.4

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

### Single-use exchange transport
The patient contact channel receives a short-TTL single-use opaque exchange ID, not the durable bearer credential.

Rules:
- exchange ID default TTL <=10 minutes;
- only a one-way exchange verifier is stored;
- first successful use atomically consumes it;
- server sets the durable guest credential in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie and redirects to a clean credential-free URL;
- cookie `Max-Age` is bounded by the earlier of 24 hours, session planned end + 4 hours, or server-side credential expiry;
- exchange route uses `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, restrictive CSP, no third-party resources and no analytics;
- access logging redacts exchange path segments before persistence;
- exchange and guest endpoints are rate-limited and protected against enumeration.

### Credential recovery
An active guest who loses the cookie may request a fresh exchange link through a rate-limited resend flow. Resend is permitted only while the target entry is active and the intended contact channel still matches the entry. Rate-limit by entry/contact/IP and audit repeated abuse-sensitive attempts.

### Terminal-state expiry — TAB-FND-024
Guest credentials are state-bound, not merely time-bound.
- On queue entry `completed`, `cancelled`, or `no_show`, or whole-session `closed`/`cancelled`, live-data authorization is immediately revoked except for a <=15 minute terminal-summary grace response containing only the minimum final operational status.
- After the grace period, the verifier is invalid and the cookie authorizes no queue endpoint.
- Max lifetime cannot extend a credential past terminal-state revocation.

### Transfer — CLAUDE-017
A transfer must never silently carry a source-entry credential into a target entry.
- In the same transfer transaction, invalidate every source verifier and outstanding exchange ID.
- Create the target-entry verifier and a new single-use exchange ID.
- Commit a transfer notification containing only the fresh exchange link.
- The old cookie may receive only a non-sensitive `transferred` terminal response and cannot read target status.

Contact-less guest/walk-in entries are permitted. They receive no remote credential and no notification/live-remote feature until authorized staff add a valid contact channel.

Never place durable guest credentials in URLs, logs, analytics or notification payload logs.

## Secrets
- Never commit provider credentials/production connection strings.
- Use environment secret management.
- Example env files contain placeholders only.
- Guest bearer and exchange IDs are patient-scoped secrets and require the redaction controls above.

## Auditability
Audit queue creation/removal, appointment changes, check-in, call, consultation start/completion, cancellation/no-show, priority, restore/transfer, session open/pause/resume/delay/close/cancel, credential issuance/rotation/revocation/resend and elevated recovery.

## Logging
Operational logs must not contain passwords, session tokens, raw guest credentials, raw exchange IDs, unredacted phone numbers/patient names, or raw sensitive notification bodies. Correlation IDs must be non-sensitive.

## Queue privacy
- No unauthenticated enumeration endpoint.
- Never reveal identities of patients ahead/behind.
- Public waiting-room labels are non-secret and cannot authorize any patient endpoint.
- Guest credential and public label are distinct fields.

## Integrity and concurrency
- Queue/session/appointment transitions validated server-side.
- Appointment and linked QueueEntry states are synchronized transactionally as defined in `ARCHITECTURE.md`.
- Lifecycle state gates every mutation.
- Client-provided queue order is never trusted directly.
- PostgreSQL constraints/locking provide defense-in-depth for canonical states, session generation uniqueness, priority-slot consistency, clinic-local service stream, doctor-global active consultation and appointment/queue cardinality.
- Idempotency is mandatory for externally retried mutation/notification flows.

## Web/API baseline before pilot
HTTPS only; secure cookie/session configuration; CSRF for cookie-authenticated mutations; schema validation; rate limits for auth/exchange/guest/resend endpoints; timing-safe verifier comparison; CSP/security headers; dependency/secret scanning in CI; tenant-isolation API tests.

## Notification privacy and reliability
Messages reveal only minimum operational information. Avoid medical specialty/condition details in lock-screen-visible text. Notification failure never rolls queue state back. Material dead-lettered events must surface to clinic operations staff without exposing provider secrets or sensitive payloads.

## Retention/deletion
Explicit retention/anonymization policy is required before production for accounts, appointments, queue records, audit history and analytics. Do not retain operational history indefinitely merely because storage is cheap.

## Threats to test/review
- cross-clinic authorization bypass;
- patient A reading patient B state;
- guest/exchange enumeration/brute force;
- persisted verifier used as credential;
- exchange replay;
- revoked/rotated/transferred credential replay;
- credential surviving terminal queue/session state;
- cookie-loss recovery abuse;
- credential leakage through URL/access log/Referer/browser history;
- public label used for guest authorization;
- stale concurrent reorder/update/lifecycle races;
- stale Appointment/QueueEntry state mismatch;
- duplicate requests creating duplicate appointments/queue entries;
- privilege escalation;
- XSS/SQL/query injection;
- notification to wrong/recycled contact;
- state-transition replay;
- cross-clinic same-doctor parallel consultation.

## Regulatory note
Do not invent legal compliance claims. Algeria-specific personal-data/health-adjacent requirements must be researched and confirmed before production deployment and translated into explicit requirements/decisions. This remains a release-hardening item requiring owner/legal confirmation rather than an engineering assumption.