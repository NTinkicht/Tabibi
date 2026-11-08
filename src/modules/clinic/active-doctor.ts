/**
 * Gap register G-19: a doctor is publicly listed and bookable at a clinic only
 * while their clinic-doctor association is not marked departed. Removing the
 * doctor's membership, or changing their role away from doctor, sets
 * `doctor_clinics.departed_at` (migration 0052); re-joining as a doctor (addDoctor
 * or an accepted doctor invite) clears it. The association row itself is kept,
 * so sessions, appointments and audit history stay intact.
 *
 * `association` is the SQL alias of a `doctor_clinics` row. Keep every public
 * discovery / availability / booking query on this predicate.
 */
export function activeDoctorAssociationSql(association: string): string {
  return `${association}.departed_at IS NULL`;
}
