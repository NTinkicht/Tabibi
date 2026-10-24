# clinic

This directory owns clinics, clinic memberships, and doctor-to-clinic associations.
Clinics default to `Africa/Algiers` and Arabic plus French. `ClinicService` performs
server-side membership checks inside the same transaction as every mutation and
writes metadata-only audit events.
`updateClinic` accepts only a timezone that is a name in PostgreSQL's
`pg_timezone_names` (for example `Europe/Paris`); anything else is rejected with
`InvalidClinicTimezoneError` before any write.
