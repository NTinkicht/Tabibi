# clinic

This directory owns clinics, clinic memberships, and doctor-to-clinic associations.
Clinics default to `Africa/Algiers` and Arabic plus French. `ClinicService` performs
server-side membership checks inside the same transaction as every mutation and
writes metadata-only audit events.
`updateClinic` accepts only a timezone that is a name in PostgreSQL's
`pg_timezone_names` (for example `Europe/Paris`); anything else is rejected with
`InvalidClinicTimezoneError` before any write. Every field of `updateClinic`,
including `name`, is optional; an omitted field keeps its stored value.
`setMembership` (clinic admins only) serializes role changes per clinic by locking
the clinic row and re-checking the actor's admin role under that lock. It rejects
removing a clinic's last `clinic_admin` (`LastClinicAdminError`), accepts the
`doctor` role only for a doctor already associated with the clinic through
`addDoctor` (`DoctorMembershipRequiresAssociationError`), rejects an unknown user
(`MembershipUserNotFoundError`), and treats setting the current role as a no-op
with no audit event.
With `{ existingMemberOnly: true }` it also rejects, under the same lock, a user
who is not already a member of this clinic (`MembershipNotFoundError`, also used
for unknown and malformed user ids), so a role change never adds a member.

Staff HTTP routes (#663): `GET /api/clinics/{clinicId}/doctors` (`listDoctors`),
`GET /api/clinics/{clinicId}/memberships` (`listMemberships`) and
`PATCH /api/clinics/{clinicId}/memberships/{userId}` with `{ role }`
(`setMembership` with `existingMemberOnly`). Unknown/non-member users are 404,
`LastClinicAdminError` and `DoctorMembershipRequiresAssociationError` are 409.

`addDoctor` (#667, clinic admins only, `POST /api/clinics/{clinicId}/doctors`
with `{ userId, displayName }`) associates an existing member of this clinic as
one of its doctors and sets their role to `doctor`. It serializes with
`setMembership` on the clinic row, never adds a member (unknown, malformed or
other-clinic users are `MembershipNotFoundError`, 404), refuses to turn the last
`clinic_admin` into a doctor (`LastClinicAdminError`, 409) and generates the
profile id itself. A doctor profile is shared by every clinic the doctor works
in, so an existing profile keeps its display name; `displayName` only names a
new profile. The route returns 201 `{ doctor }` when the association or role is
new and 200 with no audit event when nothing changed.
