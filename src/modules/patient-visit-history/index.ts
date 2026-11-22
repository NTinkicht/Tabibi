import type { Pool } from 'pg';

export const VISIT_HISTORY_RETENTION_MONTHS = 24;
export const VISIT_HISTORY_DEFAULT_LIMIT = 20;
export const VISIT_HISTORY_MAX_LIMIT = 50;

export type VisitStatus =
  | 'booked'
  | 'confirmed'
  | 'checked_in'
  | 'completed'
  | 'cancelled'
  | 'no_show';

/** Operational facts only: no clinical data, contact details or queue position. */
export interface PatientVisit {
  appointmentId: string;
  clinicId: string;
  clinicName: string;
  doctorId: string;
  doctorDisplayName: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  status: VisitStatus;
  /** Null when the visit is for the account holder, else the owned dependent. */
  dependentId: string | null;
}

export interface PatientVisitPage {
  visits: PatientVisit[];
  nextCursor: string | null;
}

export class PatientVisitHistoryValidationError extends Error {
  constructor() {
    super('Visit history input is invalid');
    this.name = 'PatientVisitHistoryValidationError';
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Cursor {
  startedAt: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.startedAt}|${cursor.id}`).toString('base64url');
}

function roundTripsAsUtcInstant(value: string): boolean {
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

function decodeCursor(raw: string): Cursor {
  const [startedAt, id, ...rest] = Buffer.from(raw, 'base64url')
    .toString('utf8')
    .split('|');
  if (
    rest.length > 0 ||
    startedAt === undefined ||
    id === undefined ||
    !uuidPattern.test(id) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(startedAt) ||
    !roundTripsAsUtcInstant(startedAt)
  )
    throw new PatientVisitHistoryValidationError();
  return { startedAt, id: id.toLowerCase() };
}

/**
 * Read-only operational visit history for one authenticated patient account.
 * The owner always comes from the verified patient session. A visit is the
 * account's when its patient record belongs to the account, or when it was
 * booked for a dependent the account owns; archived dependents are excluded.
 * History is newest first, keyset paginated and limited to the retention window.
 */
export class PatientVisitHistoryService {
  constructor(private readonly pool: Pool) {}

  async list(
    ownerUserId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<PatientVisitPage> {
    if (!uuidPattern.test(ownerUserId))
      throw new PatientVisitHistoryValidationError();
    const limit = options.limit ?? VISIT_HISTORY_DEFAULT_LIMIT;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > VISIT_HISTORY_MAX_LIMIT
    )
      throw new PatientVisitHistoryValidationError();
    const cursor =
      options.cursor === undefined ? null : decodeCursor(options.cursor);
    const { rows } = await this.pool.query<{
      id: string;
      clinic_id: string;
      clinic_name: string;
      doctor_id: string;
      doctor_name: string;
      scheduled_start_at: Date;
      scheduled_end_at: Date;
      status: VisitStatus;
      dependent_id: string | null;
    }>(
      `SELECT appt.id, appt.clinic_id, clinic.name AS clinic_name,
              appt.doctor_id, doctor.display_name AS doctor_name,
              appt.scheduled_start_at, appt.scheduled_end_at, appt.status,
              appt.dependent_id
         FROM appointments appt
         JOIN patient_operational_records patient
           ON patient.id = appt.patient_id AND patient.clinic_id = appt.clinic_id
         JOIN clinics clinic ON clinic.id = appt.clinic_id
         JOIN doctor_profiles doctor ON doctor.id = appt.doctor_id
         LEFT JOIN patient_dependents dependent
           ON dependent.id = appt.dependent_id
        WHERE appt.scheduled_start_at >=
                now() - make_interval(months => $2::int)
          AND (
            (appt.dependent_id IS NULL AND patient.account_user_id = $1)
            OR (dependent.owner_user_id = $1 AND dependent.status = 'active')
          )
          AND ($3::timestamptz IS NULL
               OR (appt.scheduled_start_at, appt.id) < ($3::timestamptz, $4::uuid))
        ORDER BY appt.scheduled_start_at DESC, appt.id DESC
        LIMIT $5`,
      [
        ownerUserId.toLowerCase(),
        VISIT_HISTORY_RETENTION_MONTHS,
        cursor?.startedAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      visits: page.map((row) => ({
        appointmentId: row.id,
        clinicId: row.clinic_id,
        clinicName: row.clinic_name,
        doctorId: row.doctor_id,
        doctorDisplayName: row.doctor_name,
        scheduledStartAt: row.scheduled_start_at.toISOString(),
        scheduledEndAt: row.scheduled_end_at.toISOString(),
        status: row.status,
        dependentId: row.dependent_id,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              startedAt: last.scheduled_start_at.toISOString(),
              id: last.id,
            })
          : null,
    };
  }
}

export {
  PatientVisitCancellationConflictError,
  PatientVisitCancellationService,
  PatientVisitNotFoundError,
} from './cancellation';
export type { PatientVisitCancellationResult } from './cancellation';
