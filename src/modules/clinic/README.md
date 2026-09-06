# clinic

This directory owns clinics, clinic memberships, and doctor-to-clinic associations.
Clinics default to `Africa/Algiers` and Arabic plus French. `ClinicService` performs
server-side membership checks inside the same transaction as every mutation and
writes metadata-only audit events.
