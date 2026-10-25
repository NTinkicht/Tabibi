import type { Pool } from 'pg';
import type { AvailabilitySelectionInput } from '@/modules/public-availability-selection';
import { abortableQuery } from '@/platform/database/abortable-query';

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

export const BOOKABLE_SESSION_HORIZON_DAYS = 14;
export const BOOKABLE_SESSIONS_PER_DOCTOR = 5;

export interface PublicBookableSession {
  serviceDate: string;
  startsAt: string;
  endsAt: string;
  selectionReference: string;
}

export interface PublicBookableDoctor {
  displayName: string;
  sessions: PublicBookableSession[];
}

export interface PublicBookableClinic {
  name: string;
  defaultLocale: string;
  enabledLocales: string[];
  doctors: PublicBookableDoctor[];
}

/** Seals a just-read clinic/doctor/session window into an opaque reference. */
export interface BookableSessionSealer {
  seal(input: AvailabilitySelectionInput): string;
}

interface PublicBookableSessionRow {
  clinic_id: string;
  clinic_name: string;
  default_locale: string;
  enabled_locales: string[];
  doctor_id: string;
  doctor_display_name: string;
  session_id: string;
  service_date: string;
  starts_at: Date;
  ends_at: Date;
}

/**
 * Public read model of the next bookable sessions per active clinic doctor.
 *
 * Internal clinic/doctor/session identifiers never leave this service: each
 * window is returned only with an opaque WU58 selection reference, which the
 * booking boundary re-validates against current durable truth. Read-only.
 */
export class PublicBookableSessionService {
  constructor(
    private readonly pool: Pool,
    private readonly sealer: BookableSessionSealer,
  ) {}

  async list(signal?: AbortSignal): Promise<PublicBookableClinic[]> {
    const text = `WITH bookable AS (
         SELECT clinic.id AS clinic_id,
                clinic.name AS clinic_name,
                clinic.default_locale,
                clinic.enabled_locales,
                doctor.id AS doctor_id,
                doctor.display_name AS doctor_display_name,
                session.id AS session_id,
                session.service_date::text AS service_date,
                session.starts_at,
                session.ends_at,
                row_number() OVER (
                  PARTITION BY session.clinic_id, session.doctor_id
                  ORDER BY session.starts_at, session.id
                ) AS doctor_rank
           FROM consultation_sessions session
           JOIN clinics clinic
             ON clinic.id = session.clinic_id
            AND clinic.status = 'active'
           JOIN doctor_clinics association
             ON association.clinic_id = session.clinic_id
            AND association.doctor_id = session.doctor_id
           JOIN doctor_profiles doctor
             ON doctor.id = session.doctor_id
          WHERE session.status IN ('planned', 'open', 'paused')
            AND session.starts_at > now()
            AND session.starts_at < now() + make_interval(days => $1::int)
       )
       SELECT clinic_id, clinic_name, default_locale, enabled_locales,
              doctor_id, doctor_display_name, session_id, service_date,
              starts_at, ends_at
         FROM bookable
        WHERE doctor_rank <= $2::int
        ORDER BY clinic_name, clinic_id, doctor_display_name, doctor_id,
                 starts_at, session_id`;
    const values = [BOOKABLE_SESSION_HORIZON_DAYS, BOOKABLE_SESSIONS_PER_DOCTOR];
    const result = await abortableQuery<PublicBookableSessionRow>(
      this.pool,
      text,
      values,
      signal,
    );

    const clinics: PublicBookableClinic[] = [];
    let clinic: PublicBookableClinic | undefined;
    let clinicKey: string | undefined;
    let doctor: PublicBookableDoctor | undefined;
    let doctorKey: string | undefined;

    for (const row of result.rows) {
      if (row.clinic_id !== clinicKey) {
        clinic = {
          name: row.clinic_name,
          defaultLocale: row.default_locale,
          enabledLocales: [...row.enabled_locales],
          doctors: [],
        };
        clinics.push(clinic);
        clinicKey = row.clinic_id;
        doctorKey = undefined;
      }
      if (row.doctor_id !== doctorKey) {
        doctor = { displayName: row.doctor_display_name, sessions: [] };
        clinic!.doctors.push(doctor);
        doctorKey = row.doctor_id;
      }
      const startsAt = row.starts_at.toISOString();
      const endsAt = row.ends_at.toISOString();
      doctor!.sessions.push({
        serviceDate: row.service_date,
        startsAt,
        endsAt,
        selectionReference: this.sealer.seal({
          clinicId: row.clinic_id,
          doctorId: row.doctor_id,
          sessionId: row.session_id,
          startsAt,
          endsAt,
        }),
      });
    }

    return clinics;
  }
}
