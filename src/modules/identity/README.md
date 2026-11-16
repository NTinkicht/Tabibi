# identity

This directory owns authentication identities and clinic-scoped authorization. Its
public contract defines the `doctor`, `receptionist`, and `clinic_admin` membership
roles and requires an explicit actor and clinic for every protected operation.
`platform_admin` is an identity-level role only and receives no implicit clinic-data
access. Patient identities are intentionally outside this slice.

## Staff credentials (TAB-P0-01, #723)

`staff-credentials.ts` stores one salted scrypt hash per staff user in
`staff_credentials`, together with the scrypt parameters so they can be raised
later. `setStaffPassword` enforces the password policy (12 to 256 characters, not
equal to the user's `auth_subject` or its local part). `verifyStaffPassword`
returns `{ ok: true, userId }` or `{ ok: false }`; unknown users, wrong passwords
and locked accounts run the same scrypt path and return the same shape. Failed
attempts increment and lock in one atomic statement (default 5 failures, 900 s),
and a correct password never succeeds while the lock is active. No password, hash,
salt or parameter is returned, thrown or logged. The HTTP sign-in route, UI,
invites and password reset are separate work units.

## Bootstrap and staff invites (#727)

`npm run db:bootstrap-admin -- --clinic-id <uuid> --email <email> --display-name <name>`
creates the first `clinic_admin` of a clinic (operator-only script, password from
stdin only, idempotent, refuses weak passwords and existing accounts).
`StaffInviteService` creates, revokes and accepts single-use invites: clinic
admins may invite `doctor` or `receptionist` only, the token is stored as a
SHA-256 verifier, a second open invite for the same clinic and email is refused,
and accepting never changes an existing account password or membership.

HTTP surface (G-18, #824). Clinic admins only, same-origin for mutations:
`POST /api/clinics/{clinicId}/staff-invites` with `{ email, role, ttlSeconds? }`
→ 201 `{ invite: { inviteId, token, expiresAt } }` (the only response that ever
carries the token; `no-store`), `GET …/staff-invites` → open invites
(`status: pending | expired`; an expired one blocks a new invite for that email
until it is revoked), `DELETE …/staff-invites/{inviteId}` → 200, or 404 for
unknown, malformed, other-clinic, revoked and accepted invites
(`InviteNotFoundError`). The admin UI builds the one-time link
`/staff/invite#<token>`: the token sits in the URL fragment, which never
reaches the server. The public page reads it, removes it from the address bar
and posts it to `POST /api/staff/invites/preview` (clinic name, role, email,
expiry) and `POST /api/staff/invites/accept` with
`{ token, displayName, password }`. Both are same-origin, size-bounded,
rate-limited (one ingress bucket plus 20 attempts per invite id per 15
minutes), answer every unusable token with the one 400 `invite_invalid`,
password-policy failures with 400 `password_policy` and its `code`, and any
malformed body with a generic 400 that echoes nothing. Accepting does not sign
the person in. A doctor invited back after leaving clears the departure marker
(G-19).

## Patient credentials (TAB-P1-01 slice 1, #875)

`patient-credentials.ts` registers a patient account as a `users` row with the
namespaced subject `patient:<normalized email>` plus a `patient_credentials` row
(same scrypt hardening and atomic lockout as staff), created in one statement.
`registerPatientAccount` returns `{ ok: true, userId }` or one uniform
`{ ok: false }` for an existing account; `verifyPatientPassword` returns the same
`{ ok: false }` for unknown, wrong and locked. Patient and staff credentials live in
separate tables and never authenticate each other. Identity
verification, registration routes and recovery are later slices.

### Patient sessions (slice 2)

`POST /api/patient/session` `{ email, password }` signs in (same-origin, bounded
strict body, 10 attempts per account and one ingress bucket per 15 minutes,
uniform 401) and sets the HttpOnly `tabibi_patient_session` cookie; `GET` returns
`{ account: { displayName } }`; `POST /api/patient/session/logout` revokes the
server-side `patient_sessions` row (verifier only). The token is signed with a key
derived from `STAFF_SESSION_SECRET` under a patient-only context and the row lives
in its own table, so patient and staff sessions never verify on each other's
routes.

### Patient registration (slice 3)

`POST /api/patient/register` `{ email, displayName, password }` (same-origin,
bounded strict body, 5 attempts per email and one ingress bucket per 15 minutes)
creates the account and answers `202 { status: "accepted" }` for a new and an
already-registered email alike, with no session or cookie, so it cannot enumerate
or take over accounts; the patient then signs in. Invalid input is one generic 400.
Identity verification and recovery are later slices.

### Patient password change (slice 4)

`POST /api/patient/password` `{ currentPassword, newPassword }` requires a patient
session (a staff cookie never authorizes it), then same-origin, a bounded strict
body, 5 attempts per account and one ingress bucket per 15 minutes. The current
password is checked through the lockout-aware `verifyPatientPassword` (a wrong
one is the single 403 `current_password_invalid` and counts toward the lockout);
the new one must pass the shared policy (400 `password_policy` with its `code`,
nothing changed). The hash is replaced with a compare-and-set on the hash that
was read, and every other session of the account is revoked while the calling
session stays valid.

### Patient recovery redemption (slice 6)

`POST /api/patient/recovery/redeem` `{ token, newPassword }` (same-origin, bounded
strict body, 5 attempts per token and one ingress bucket per 15 minutes) redeems
a slice-5 reset token: it replaces the password, clears the lockout and revokes
every session of the account, then answers `200 { status: "changed" }` with no
cookie. Malformed, unknown, superseded, expired and replayed tokens are one 400
`invalid_token`; a policy failure is 400 `password_policy` and leaves a valid
token unconsumed. Requesting a reset (and delivering the token) is a later slice
because it needs an approved delivery channel.

### Patient dependent routes (slice 7)

First account-owned routes behind the patient session, wiring the WU69
`AccountDependentService`: `GET|POST /api/patient/dependents`,
`GET|PATCH /api/patient/dependents/{id}` and
`POST /api/patient/dependents/{id}/archive`. The owner is only ever the
authenticated patient (a staff token, garbage cookie or logged-out session is
401, and owner fields in a body or query are refused as unknown). Another
account's, unknown, malformed and (for rename) archived ids are one 404.
Mutations are same-origin, strict-bodied (2 KiB) and limited to 30 per account
and one ingress bucket per 15 minutes. Dependent booking, delegation and UI
stay with TAB-P1-03.
