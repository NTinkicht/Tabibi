import type { Pool } from 'pg';

export interface PublicDoctorAvailability {
  serviceDate: string;
  startsAt: string;
  endsAt: string;
}

interface PublicDoctorAvailabilityRow {
  service_date: string;
  starts_at: Date;
  ends_at: Date;
}

export class PublicDoctorAvailabilityService {
  constructor(private readonly pool: Pool) {}

  async listForDoctor(
    clinicId: string,
    doctorId: string,
  ): Promise<PublicDoctorAvailability[]> {
    const result = await this.pool.query<PublicDoctorAvailabilityRow>(
      `SELECT session.service_date::text AS service_date,
              session.starts_at,
              session.ends_at
         FROM consultation_sessions session
         JOIN clinics clinic
           ON clinic.id = session.clinic_id
          AND clinic.status = 'active'
         JOIN doctor_clinics association
           ON association.clinic_id = session.clinic_id
          AND association.doctor_id = session.doctor_id
        WHERE session.clinic_id = $1
          AND session.doctor_id = $2
          AND association.clinic_id = $1
          AND association.doctor_id = $2
          AND session.status IN ('planned', 'open', 'paused')
          AND session.starts_at >= now()
        ORDER BY session.starts_at, session.id`,
      [clinicId, doctorId],
    );

    return result.rows.map((row) => ({
      serviceDate: row.service_date,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
    }));
  }
}
