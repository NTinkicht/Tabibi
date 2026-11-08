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
