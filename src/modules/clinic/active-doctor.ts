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

interface AssociationQueryable {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

/**
 * True when the doctor's association with the clinic is active, holding a
 * FOR SHARE lock on it until the caller's transaction ends. A concurrent
 * departure (markDoctorDeparted's UPDATE) then waits for this transaction,
 * and a check that waited for a departure re-evaluates `departed_at` on the
 * committed row, so a new session or booking can never be admitted against a
 * stale snapshot of an association that is being departed.
 */
export async function lockActiveDoctorAssociation(
  db: AssociationQueryable,
  clinicId: string,
  doctorId: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM doctor_clinics association
      WHERE association.clinic_id = $1 AND association.doctor_id = $2
        AND ${activeDoctorAssociationSql('association')}
      FOR SHARE`,
    [clinicId, doctorId],
  );
  return result.rowCount === 1;
}
