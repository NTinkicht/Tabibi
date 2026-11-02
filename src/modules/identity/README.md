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
