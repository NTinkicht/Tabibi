# WU67 — Account-owned dependent foundation

Parent: #273 / Epic #2

## Objective

Add the smallest privacy-preserving foundation needed for an authenticated patient account to manage dependents before any dependent booking workflow is introduced.

## Domain boundary

A dependent is operational identity data owned by exactly one authenticated patient account. WU67 does not add clinical data, guest ownership, sharing between accounts, or dependent booking.

Minimum durable fields:
- opaque dependent identifier;
- internal owner account identifier;
- display name, normalized and validated as Unicode text;
- lifecycle state: `active` or `archived`;
- created/updated timestamps.

No clinical notes, diagnosis, medication, government identifier, address, independent contact destination, or other unnecessary sensitive fields belong in this work unit.

## Authorization contract

Every dependent read and mutation is scoped by the authenticated owner on the server. A dependent belonging to another account is returned using the same not-found behavior as an unknown identifier. Client-supplied owner identifiers are never authoritative and raw owner identifiers are never returned by the dependent API.

## Lifecycle contract

- Create produces an `active` dependent.
- List returns only dependents owned by the caller; archived records may be represented only when the endpoint explicitly requests lifecycle history.
- Update may change permitted operational identity fields for an owner-scoped active dependent.
- Archive is idempotent and durable; it does not physically delete the row.
- Archived dependents are ineligible for future new booking/queue operations.
- WU67 does not retroactively mutate historical references.

## Text handling

Names must accept legitimate Arabic and French/Latin Unicode text without ASCII-only assumptions. Validation trims surrounding whitespace, rejects empty/whitespace-only values, rejects control characters, applies a bounded length after normalization, and preserves human-readable Unicode. Do not transliterate names or silently strip meaningful diacritics.

## Privacy and observability

Dependent names and other user-entered identity data must not be written to logs, telemetry, URLs, exception messages, or audit metadata. Structured events may use bounded non-identifying outcome/category fields only.

## Required evidence

Implementation is not complete until the canonical PR contains:
1. PostgreSQL migration with owner/lifecycle constraints and owner-scoped lookup indexes.
2. Owner-scoped service/API create, list, update and archive behavior.
3. Cross-account read and mutation tests proving not-found-equivalent behavior.
4. Archive idempotency and archived-ineligibility tests.
5. Arabic, French/diacritic and representative Unicode validation tests, including control-character rejection.
6. Regression evidence showing existing guest flows remain green.
7. Exact-head CI green.
8. Eligible independent non-author exact-SHA review with no unresolved Medium+/Major+/High+/Critical/Blocker findings.

## Explicit non-goals

Dependent booking, guardian delegation/sharing, clinical records, patient-account registration/auth redesign, guest-to-account migration, notifications and UI beyond what is strictly required to exercise this foundation are deferred to later bounded work units.