# clinic

This directory owns clinics, clinic memberships, and doctor-to-clinic associations.
Clinics default to `Africa/Algiers` and Arabic plus French. `ClinicService` performs
server-side membership checks inside the same transaction as every mutation and
writes metadata-only audit events.
`updateClinic` accepts only a timezone that is a name in PostgreSQL's
`pg_timezone_names` (for example `Europe/Paris`); anything else is rejected with
`InvalidClinicTimezoneError` before any write.
`setMembership` (clinic admins only) serializes role changes per clinic by locking
the clinic row and re-checking the actor's admin role under that lock. It rejects
removing a clinic's last `clinic_admin` (`LastClinicAdminError`), accepts the
`doctor` role only for a doctor already associated with the clinic through
`addDoctor` (`DoctorMembershipRequiresAssociationError`), rejects an unknown user
(`MembershipUserNotFoundError`), and treats setting the current role as a no-op
with no audit event.
