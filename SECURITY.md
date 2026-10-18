# Tabibi Security & Privacy Baseline v0.6

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
**Two separate guest bearer classes exist; neither is interchangeable or a staff identity.** Every read and mutation must authorize against the server's durable booking/queue/clinic/tenant binding, lifecycle and revocation state, not caller-provided IDs or display labels.

- **Booking-origin `guestBearer` (WU63/WU64/WU65):** the trusted booking frontend obtains it only from the successful `POST /api/public/bookings` response. The WU64 host hands it to read-only polling or the WU65 explicit check-in component in memory in the **same document**, clearing the host reference afterward. Consumers send it only in an `Authorization` header for WU63/WU64 status polling, the merged WU95/WU119 bearer-safe `fetch()` change-hint stream, or WU65 check-in. It must never enter a cookie, URL, browser storage, DOM, logs, analytics or error payload. **The separate server-side authenticated-encrypted WU59 receipt-replay copy is permitted only as defined below; this browser memory rule does not forbid that receipt.** It is invalid across different durable booking/clinic/queue scopes, cannot be recovered from a reload or exchange cookie, and does not grant staff or other patient privileges. WU65 additionally binds a high-entropy body `operationId` to its authorized booking, one serialized eligible check-in transition and safe replay.
- **Exchange-origin status-only bearer (TAB-FND-024/028):** minted **only** when a valid single-use exchange ID is atomically consumed, returned **only** via a Secure/HttpOnly cookie response, never exposed to JavaScript. Persist only a one-way status-bearer verifier bound to the target entry/session. This cookie can read the narrow authorized status route only; it cannot authorize WU65 check-in or produce/hydrate any header-bearing booking capability. The verifier itself must not authenticate. Staff-created, exchange-only and contact-less guests use authorized receptionist check-in; contact-less entries without a valid channel do not receive remote credentials.

**Class non-interchangeability is a release requirement:** send a booking bearer to the cookie-only route, or a status cookie to a WU64/WU65 bearer-only route, and it must fail closed. A cross-class fallback, cookie-to-bearer conversion, URL injection or JS read of the status cookie is forbidden. Booking responses carrying a booking `guestBearer` require no-store/no-referrer headers and scoped redaction. Rotation/terminal/transfer rules revoke each credential class independently; a target transfer never carries source scope authority.

### Single-use exchange transport (status-cookie class only)
The patient contact channel receives a short-TTL single-use opaque exchange ID, **not** an exchange-origin durable status bearer or a booking-origin `guestBearer`.

Rules:
- exchange ID default TTL <=10 minutes;
- only a one-way exchange verifier is stored;
- before consumption, store only the exchange record/verifier, target entry/session binding, expiry, purpose, rate-limit metadata and permitted envelope-encrypted delivery material; never pre-create a bearer verifier;
- first successful use transactionally validates and consumes it, generates a fresh high-entropy bearer, persists only the bearer verifier, and sets the raw bearer in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie before redirecting to a clean credential-free URL;
- an exact retry of a consumed exchange cannot mint another credential; return an already-consumed clean recovery outcome and require rate-limited resend if the cookie was lost;
- cookie `Max-Age` is bounded by the earlier of 24 hours or server-side credential expiry; planned session timing never shortens it, while terminal-state revocation remains authoritative;
- exchange route uses `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, restrictive CSP, no third-party resources and no analytics;
- access logging redacts exchange path segments before persistence;
- exchange and guest endpoints are rate-limited and protected against enumeration.

### Credential recovery
An active guest who loses the cookie may request a fresh exchange link through a rate-limited resend flow. Resend is permitted only while the target entry is active and the intended contact channel still matches the entry. Rate-limit by entry/contact/IP and audit repeated abuse-sensitive attempts.

### Terminal-state expiry — TAB-FND-024
Both guest credential classes are state-bound, not merely time-bound. **Booking-origin WU64 header bearer** loses *live queue* and **all mutation** authority immediately on an entry's committed `completed`, `cancelled` or `no_show` or whole-session closed/cancelled transition. Only if the original booking bearer is still otherwise valid may the WU63/WU64 header status read return one privacy-minimal terminal state during an **at-most 15-minute grace measured from the committed transition timestamp**. No ETA, work-ahead, identity or next-action capability is exposed. The token's own expiry/revocation always ends that grace earlier. At grace expiry return the same generic unavailable denial; a delayed/replayed poll must never restart the window. WU64 must stop and clear its memory on observing the terminal state; no persisted reload recovery or cookie downgrade. Transfer revokes the old booking bearer and may expose only separately authorized non-sensitive transferred outcome, not target status. WU65 check-in does not inherit any terminal grace.
**Exchange-origin HttpOnly status bearer** follows the same maximum terminal-summary timing but via its cookie-only status route; it cannot authorize mutation or be read back as a booking header bearer.
- On queue entry `completed`, `cancelled`, or `no_show`, or whole-session `closed`/`cancelled`, *both credential classes* revoke live-data authority immediately. Their distinct header-only or cookie-only status routes may return **only** a final allow-listed terminal-state summary for ≤15 minutes measured from committed terminal time and bounded by earlier bearer expiry; this never permits mutation or other sensitive reads.
- After the grace period, the verifier is invalid and the cookie authorizes no queue endpoint.
- Max lifetime cannot extend a credential past terminal-state revocation.

### Transfer — CLAUDE-017
A transfer must never silently carry a source-entry credential into a target entry.
- In the same transfer transaction, invalidate every source verifier and outstanding exchange ID.
- Create a new target-bound single-use exchange ID/verifier and permitted encrypted delivery material, but no target bearer verifier; the bearer/verifier pair is created only when this exchange is consumed.
- Commit a transfer notification containing only the fresh exchange link.
- The old cookie may receive only a non-sensitive `transferred` terminal response and cannot read target status.

Contact-less guest/walk-in entries are permitted. They receive no remote credential and no notification/live-remote feature until authorized staff add a valid contact channel.

Never place either class of durable guest credential in URLs, logs, analytics or notification payload logs; the booking-origin bearer is emitted **only to a validated same-booking successful first or idempotent replay response** with no-store/no-referrer controls, and consumed only by same-document memory/header transport; the exchange-origin status bearer is only in the HttpOnly cookie response. The separate WU59 at-rest authenticated-encrypted replay copy is governed below and never exposed through general projections.

### Authenticated-encrypted public-booking retry receipt (WU59)

**Narrowly scoped exception, already implemented:** `public_guest_booking_receipts.access_ciphertext` retains an AES-256-GCM-encrypted copy of the **booking-origin** `guestBearer` so identical clinic-scoped idempotency-key + request-fingerprint retries converge on the same committed appointment/queue/credential and logical public result. The receipt encryption key is domain-separated from the configured bearer-signing secret, with per-encryption random IV and authenticated envelope; **never confuse this receipt with a guest-exchange delivery outbox**. Only the server's WU59 replay path may decrypt after exact fingerprint and clinic scope checks. It returns the capability only in a successful no-store public booking/replay response, not staff APIs, logs, metrics, analytics, URL/referrer, event payloads, browser storage, or general queue projections. Ciphertext tampering, wrong key, missing material or unauthorized/fingerprint-mismatched replay must fail closed without creating a second credential or exposing prior guest state. Existing durable WU59 receipt storage is **not evidence of durable client memory**; the client still keeps the plaintext bearer solely in volatile same-document memory.

**Outstanding bounded-retention gate:** WU59's existing SQL receipt schema stores ciphertext but does not by itself demonstrate a scrubber or maximum retained lifetime. Before production qualification, document and test secure expiration/scrubbing or otherwise bounded-at-rest retention of decryptable booking receipts, and prevent revoked/expired/terminal credentials from regaining live access through old replay ciphertext. Keep only necessary non-secret fingerprint/audit metadata after eligibility ends. Do not claim this cleanup already shipped, and do not delete the encrypted receipt prematurely, because WU59's required identical-retry convergence depends on it. Test key rotation, replay after credential expiry/revocation, exact request scope, rollback and ciphertext corruption.

### Encrypted exchange-link outbox exception — TAB-FND-028-secret-outbox
Credential and exchange tables store only one-way verifiers. To preserve durable asynchronous exchange-link delivery, an outbox row may contain a short-lived envelope-encrypted secret payload plus non-secret metadata; plaintext exchange IDs/links remain forbidden in database columns, logs, metrics, errors and audit snapshots. The wrapping key comes from runtime secret management/KMS-equivalent, never the database or Git, and only the notification worker may decrypt immediately before dispatch.

Ciphertext lifetime cannot exceed the exchange ID TTL (default 10 minutes). Before expiry, retry uses the same logical exchange ID/provider idempotency key. After expiry the stale link is not retried; resend creates a fresh exchange ID and encrypted payload. Recoverable ciphertext is scrubbed after delivery, terminal failure or expiry as soon as audit requirements permit. Missing keys or decryption/authentication failures fail closed, are observable and retry-bounded, and never fall back to plaintext.

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
HTTPS only; secure cookie/session configuration; CSRF for cookie-authenticated mutations (no guest status-cookie mutation in MVP); schema validation; rate limits for auth/exchange/guest/resend endpoints; timing-safe verifier comparison; CSP/security headers; dependency/secret scanning in CI; tenant-isolation API tests. Positive and negative tests must validate both approved guest credential classes and reject cross-class authorization, browser cookie fallback on WU64, cookie-only WU65 mutation, bearer-in-URL/DOM/storage or status-bearer JavaScript access; no fabricated credential may be promoted to staff/account authority.

## Notification privacy and reliability
Messages reveal only minimum operational information. Avoid medical specialty/condition details in lock-screen-visible text. Notification failure never rolls queue state back. Material dead-lettered events must surface to clinic operations staff without exposing provider secrets or sensitive payloads.

## Retention/deletion
Explicit retention/anonymization policy is required before production for accounts, appointments, queue records, audit history and analytics. Do not retain operational history indefinitely merely because storage is cheap.

## Threats to test/review
- cross-clinic authorization bypass;
- patient A reading patient B state;
- guest/exchange enumeration/brute force;
- persisted verifier used as credential;
- bearer verifier existing before exchange consumption or recoverable bearer material persisted during normal/transfer issuance;
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
