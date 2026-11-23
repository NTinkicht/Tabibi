import type { Pool } from 'pg';
import { PatientVisitNotFoundError } from './cancellation';
import { PatientVisitRescheduleConflictError } from './reschedule';

// TAB-P1-04 slice 7: read-only list of the sessions a signed-in patient may
// move an upcoming visit to. The predicate mirrors the reschedule service
// (same clinic and doctor, planned, in the future, active clinic, doctor still
// associated, no other appointment of the same patient in the target) so every
// returned id is a valid target at read time. Only identifiers and times are
// exposed.
export const RESCHEDULE_OPTIONS_LIMIT = 20;
const MOVABLE_APPOINTMENT_STATES = ['booked', 'confirmed'];

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RescheduleOption {
  sessionId: string;
  startsAt: string;
  endsAt: string;
}

export class PatientVisitRescheduleOptionsService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(
    ownerUserId: string,
    appointmentId: string,
  ): Promise<{ options: RescheduleOption[] }> {
    if (!uuidPattern.test(ownerUserId) || !uuidPattern.test(appointmentId))
      throw new PatientVisitNotFoundError();
    const visit = await this.pool.query<{
      clinic_id: string;
      doctor_id: string;
      patient_id: string;
      session_id: string;
      appointment_status: string;
      queue_state: string;
    }>(
      `SELECT appt.clinic_id, appt.doctor_id, appt.patient_id, appt.session_id,
              appt.status::text AS appointment_status,
              entry.state::text AS queue_state
         FROM appointments appt
         JOIN patient_operational_records patient
           ON patient.id = appt.patient_id AND patient.clinic_id = appt.clinic_id
         JOIN queue_entries entry
           ON entry.id = appt.queue_entry_id AND entry.clinic_id = appt.clinic_id
          AND entry.session_id = appt.session_id
         LEFT JOIN patient_dependents dependent
           ON dependent.id = appt.dependent_id
        WHERE appt.id = $1
          AND (
            (appt.dependent_id IS NULL AND patient.account_user_id = $2)
            OR (dependent.owner_user_id = $2 AND dependent.status = 'active')
          )`,
      [appointmentId.toLowerCase(), ownerUserId.toLowerCase()],
    );
    const row = visit.rows[0];
    if (!row) throw new PatientVisitNotFoundError();
    if (
      !MOVABLE_APPOINTMENT_STATES.includes(row.appointment_status) ||
      row.queue_state !== 'waiting'
    )
      throw new PatientVisitRescheduleConflictError();

    const sessions = await this.pool.query<{
      id: string;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT session.id, session.starts_at, session.ends_at
         FROM consultation_sessions session
         JOIN clinics clinic
           ON clinic.id = session.clinic_id AND clinic.status = 'active'
         JOIN doctor_clinics association
           ON association.clinic_id = session.clinic_id
          AND association.doctor_id = session.doctor_id
        WHERE session.clinic_id = $1 AND session.doctor_id = $2
          AND session.status = 'planned' AND session.starts_at > $3
          AND session.id <> $4
          AND NOT EXISTS (
            SELECT 1 FROM appointments other
             WHERE other.clinic_id = session.clinic_id
               AND other.session_id = session.id
               AND other.patient_id = $5)
        ORDER BY session.starts_at, session.id
        LIMIT $6`,
      [
        row.clinic_id,
        row.doctor_id,
        this.clock(),
        row.session_id,
        row.patient_id,
        RESCHEDULE_OPTIONS_LIMIT,
      ],
    );
    return {
      options: sessions.rows.map((session) => ({
        sessionId: session.id,
        startsAt: session.starts_at.toISOString(),
        endsAt: session.ends_at.toISOString(),
      })),
    };
  }
}
