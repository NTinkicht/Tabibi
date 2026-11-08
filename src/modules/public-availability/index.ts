import { activeDoctorAssociationSql } from '@/modules/clinic/active-doctor';
import type { Pool } from 'pg';
import type { AvailabilitySelectionInput } from '@/modules/public-availability-selection';
import { abortableQuery } from '@/platform/database/abortable-query';
import {
  PUBLIC_DISCOVERY_MAX_PAGE,
  PUBLIC_DISCOVERY_PAGE_SIZE,
} from '@/modules/clinic/discovery-page';
import { isDiscoveryLanguageCode } from '@/modules/clinic/languages';
import { isSpecialtyCode } from '@/modules/clinic/specialties';
import { isWilayaCode } from '@/modules/clinic/wilayas';

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
          AND ${activeDoctorAssociationSql('association')}
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
  // TAB-P0-03 (#803): this clinic's specialty codes for the doctor, exactly
  // the values public discovery already publishes.
  specialtyCodes: string[];
  sessions: PublicBookableSession[];
}

export interface PublicBookableClinic {
  name: string;
  defaultLocale: string;
  enabledLocales: string[];
  // TAB-P0-03 (#803): the clinic's public location as discovery publishes it.
  wilayaCode: string | null;
  commune: string | null;
  addressLine: string | null;
  doctors: PublicBookableDoctor[];
}

// TAB-P0-03 (#803): the discovery filters honoured by the bookable-sessions
// listing (same controlled lists and semantics as PublicDiscoveryFilters).
export interface PublicBookableFilters {
  wilayaCode?: string;
  specialtyCode?: string;
  languageCode?: string;
}

export interface PublicBookablePage {
  clinics: PublicBookableClinic[];
  hasMore: boolean;
}

export class InvalidBookableFilterError extends Error {
  constructor() {
    super('Bookable sessions filter is outside the controlled lists');
    this.name = 'InvalidBookableFilterError';
  }
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
  wilaya_code: string | null;
  commune: string | null;
  address_line: string | null;
  doctor_id: string;
  doctor_display_name: string;
  doctor_specialty_codes: string[] | null;
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

  async list(
    signal?: AbortSignal,
    filters: PublicBookableFilters = {},
  ): Promise<PublicBookableClinic[]> {
    return this.query(signal, filters, null, 0);
  }

  // One server-fixed page of clinics (a clinic is never split across pages;
  // one look-ahead clinic tells whether a further page exists).
  async listPage(
    signal: AbortSignal | undefined,
    filters: PublicBookableFilters,
    page: number,
  ): Promise<PublicBookablePage> {
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > PUBLIC_DISCOVERY_MAX_PAGE
    ) {
      throw new InvalidBookableFilterError();
    }
    const clinics = await this.query(
      signal,
      filters,
      PUBLIC_DISCOVERY_PAGE_SIZE + 1,
      (page - 1) * PUBLIC_DISCOVERY_PAGE_SIZE,
    );
    return {
      clinics: clinics.slice(0, PUBLIC_DISCOVERY_PAGE_SIZE),
      hasMore: clinics.length > PUBLIC_DISCOVERY_PAGE_SIZE,
    };
  }

  private async query(
    signal: AbortSignal | undefined,
    filters: PublicBookableFilters,
    clinicLimit: number | null,
    clinicOffset: number,
  ): Promise<PublicBookableClinic[]> {
    const { wilayaCode, specialtyCode, languageCode } = filters;
    // Fail closed: a value outside the controlled lists is refused, never
    // silently ignored.
    if (
      (wilayaCode !== undefined && !isWilayaCode(wilayaCode)) ||
      (specialtyCode !== undefined && !isSpecialtyCode(specialtyCode)) ||
      (languageCode !== undefined && !isDiscoveryLanguageCode(languageCode))
    ) {
      throw new InvalidBookableFilterError();
    }
    const text = `WITH bookable AS (
         SELECT clinic.id AS clinic_id,
                clinic.name AS clinic_name,
                clinic.default_locale,
                clinic.enabled_locales,
                clinic.wilaya_code,
                clinic.commune,
                clinic.address_line,
                doctor.id AS doctor_id,
                doctor.display_name AS doctor_display_name,
                association.specialty_codes AS doctor_specialty_codes,
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
            AND ${activeDoctorAssociationSql('association')}
            AND session.starts_at > now()
            AND session.starts_at < now() + make_interval(days => $1::int)
            AND ($3::text IS NULL OR clinic.wilaya_code = $3::text)
            AND ($4::text IS NULL OR $4::text = ANY (association.specialty_codes))
            AND ($5::text IS NULL OR $5::text = ANY (clinic.enabled_locales))
       ), kept AS (
         SELECT * FROM bookable WHERE doctor_rank <= $2::int
       ), page_clinics AS (
         SELECT clinic_id
           FROM (SELECT DISTINCT clinic_id, clinic_name FROM kept) listed
          ORDER BY clinic_name, clinic_id
          LIMIT $6::int OFFSET $7::int
       )
       SELECT kept.clinic_id, clinic_name, default_locale, enabled_locales,
              wilaya_code, commune, address_line,
              doctor_id, doctor_display_name, doctor_specialty_codes,
              session_id, service_date, starts_at, ends_at
         FROM kept
         JOIN page_clinics ON page_clinics.clinic_id = kept.clinic_id
        ORDER BY clinic_name, kept.clinic_id, doctor_display_name, doctor_id,
                 starts_at, session_id`;
    const values = [
      BOOKABLE_SESSION_HORIZON_DAYS,
      BOOKABLE_SESSIONS_PER_DOCTOR,
      wilayaCode ?? null,
      specialtyCode ?? null,
      languageCode ?? null,
      clinicLimit,
      clinicOffset,
    ];
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
          wilayaCode: row.wilaya_code,
          commune: row.commune,
          addressLine: row.address_line,
          doctors: [],
        };
        clinics.push(clinic);
        clinicKey = row.clinic_id;
        doctorKey = undefined;
      }
      if (row.doctor_id !== doctorKey) {
        doctor = {
          displayName: row.doctor_display_name,
          specialtyCodes: [...(row.doctor_specialty_codes ?? [])],
          sessions: [],
        };
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
