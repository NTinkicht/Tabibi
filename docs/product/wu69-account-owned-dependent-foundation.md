# WU69 — Account-owned dependent foundation

Parent: #273 / Epic #2

## Renumbering

This stream was initially opened as WU67 from a stale post-WU66 snapshot. Actual WU67 is Issue #271 / PR #272 and WU68 is Issue #275 / PR #276. The existing PR #274 remains canonical and its legacy branch name is intentionally retained to avoid duplicate-stream churn.

## Objective

Add the smallest privacy-preserving foundation needed for an authenticated patient account to manage dependents before any dependent booking workflow is introduced.

## Domain boundary

A dependent is operational identity data owned by exactly one authenticated patient account. WU69 does not add clinical data, guest ownership, sharing between accounts, or dependent booking.

Minimum durable fields:
- opaque dependent identifier;
- internal owner account identifier;
- display name, normalized and validated as Unicode text;
- lifecycle state: `active` or `archived`;
- created/updated timestamps.

No clinical notes, diagnosis, medication, government identifier, address, independent contact destination, or other unnecessary sensitive fields belong in this work unit.

## Authorization and service API contract

Every dependent read and mutation is scoped by the authenticated owner on the server. The `AccountDependentService` accepts the trusted authenticated owner scope separately from dependent input; client-supplied owner identifiers are never authoritative and raw owner identifiers are never returned by the dependent API.

A dependent belonging to another account uses the same not-found behavior as an unknown or malformed dependent identifier. The service API provides create, list, get, update, archive and active-operation lookup primitives.

Patient-account registration/session authentication and HTTP route wiring are explicitly deferred. This work unit must not invent a second authentication scheme merely to expose an HTTP endpoint before the patient-account auth boundary exists.

## Lifecycle contract

- Create produces an `active` dependent.
- List returns only dependents owned by the caller; archived records are returned only when lifecycle history is explicitly requested.
- Update may change the display name only for an owner-scoped active dependent.
- Archive is idempotent and durable; it does not physically delete the row.
- Archived dependents are ineligible for future new booking/queue operations; `getActiveForOperation` fails closed for archived records.
- WU69 does not retroactively mutate historical references.

## Text handling

Names accept legitimate Arabic and French/Latin Unicode text without ASCII-only assumptions. Validation trims surrounding whitespace, rejects empty/whitespace-only values, rejects control/format characters, normalizes to NFC, applies a 160-code-point bound after normalization, and preserves human-readable Unicode and meaningful diacritics. PostgreSQL independently rejects non-NFC persisted names and ordinary control characters.

## Privacy and observability

Dependent names and other user-entered identity data must not be written to logs, telemetry, URLs, exception messages, or audit metadata. Structured events may use bounded non-identifying outcome/category fields only. Service results never serialize `owner_user_id`.

## Required evidence

Implementation is not complete until the canonical PR contains:
1. PostgreSQL migration with owner/lifecycle constraints, NFC persistence guard and owner-scoped lookup indexes.
2. Owner-scoped server-side service API create, list, get, update and archive behavior.
3. Cross-account read and mutation tests proving not-found-equivalent behavior.
4. Archive idempotency and archived-ineligibility tests.
5. Arabic, French/diacritic and representative Unicode validation tests, including control/format-character rejection and database-level non-NFC rejection.
6. Migration-chain evidence for migration `0029_account_owned_dependents.sql`.
7. Regression evidence showing existing guest flows remain green.
8. Exact-head CI green.
9. Eligible independent non-author exact-SHA review with no unresolved Medium+/Major+/High+/Critical/Blocker findings.

## Explicit non-goals

Dependent booking, guardian delegation/sharing, clinical records, patient-account registration/auth redesign, HTTP patient-session wiring, guest-to-account migration, notifications and UI are deferred to later bounded work units.
