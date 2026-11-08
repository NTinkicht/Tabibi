import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

export const CLINIC_ROLES = ['doctor', 'receptionist', 'clinic_admin'] as const;
export type ClinicRole = (typeof CLINIC_ROLES)[number];

export interface ClinicScope {
  actorUserId: string;
  clinicId: string;
}

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export class AuthorizationError extends Error {
  constructor() {
    super('Actor is not authorized for this clinic operation');
    this.name = 'AuthorizationError';
  }
}

export async function requireClinicRole(
  db: Queryable,
  scope: ClinicScope,
  allowed: readonly ClinicRole[],
): Promise<ClinicRole> {
  const result = await db.query<{ role: ClinicRole }>(
    `SELECT role FROM clinic_memberships
       WHERE clinic_id = $1 AND user_id = $2 AND role = ANY($3::membership_role[])`,
    [scope.clinicId, scope.actorUserId, allowed],
  );
  const role = result.rows[0]?.role;
  if (!role) throw new AuthorizationError();
  return role;
}

export async function requireDoctorIdentity(
  db: Queryable,
  scope: ClinicScope,
  doctorId: string,
): Promise<void> {
  const result = await db.query(
    `SELECT 1 FROM clinic_memberships membership
       JOIN doctor_profiles doctor ON doctor.user_id = membership.user_id
       JOIN doctor_clinics association
         ON association.clinic_id = membership.clinic_id AND association.doctor_id = doctor.id
      WHERE membership.clinic_id = $1 AND membership.user_id = $2
        AND membership.role = 'doctor' AND doctor.id = $3`,
    [scope.clinicId, scope.actorUserId, doctorId],
  );
  if (result.rowCount !== 1) throw new AuthorizationError();
}

/**
 * Owner decision #799 (option A): a doctor may act only on a consultation
 * session whose doctor is the caller's OWN doctor identity in this clinic.
 * A session that does not exist in this clinic is denied, not "not found", so
 * a doctor cannot probe other clinics' or doctors' session ids.
 */
export async function requireOwnSessionDoctor(
  db: Queryable,
  scope: ClinicScope,
  sessionId: string,
): Promise<void> {
  const owner = await db.query<{ doctor_id: string }>(
    `SELECT doctor_id FROM consultation_sessions
      WHERE id = $1 AND clinic_id = $2`,
    [sessionId, scope.clinicId],
  );
  const doctorId = owner.rows[0]?.doctor_id;
  if (!doctorId) throw new AuthorizationError();
  await requireDoctorIdentity(db, scope, doctorId);
}

export type TransactionClient = PoolClient;
