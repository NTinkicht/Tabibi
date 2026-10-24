import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import {
  AuthorizationError,
  type ClinicScope,
  requireClinicRole,
  requireDoctorIdentity,
  type Queryable,
} from '@/modules/identity';
import { inTransaction } from '@/platform/database/transaction';

export interface ScheduleTemplate {
  id: string;
  clinicId: string;
  doctorId: string;
  weekday: number;
  localStartTime: string;
  localEndTime: string;
  occurrenceIndex: number;
  active: boolean;
}

interface TemplateRow {
  id: string;
  clinic_id: string;
  doctor_id: string;
  weekday: number;
  local_start_time: string;
  local_end_time: string;
  occurrence_index: number;
  active: boolean;
}

async function requireScheduleWrite(
  db: Queryable,
  scope: ClinicScope,
  doctorId: string,
): Promise<void> {
  const role = await requireClinicRole(db, scope, ['doctor', 'clinic_admin']);
  if (role === 'doctor') await requireDoctorIdentity(db, scope, doctorId);
}

function templateFromRow(row: TemplateRow): ScheduleTemplate {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    doctorId: row.doctor_id,
    weekday: row.weekday,
    localStartTime: row.local_start_time,
    localEndTime: row.local_end_time,
    occurrenceIndex: row.occurrence_index,
    active: row.active,
  };
}

// Two active weekly templates of one doctor in one clinic must not overlap on
// the same weekday: generation would otherwise plan overlapping sessions for
// that doctor on every matching day. Ranges are half-open, so 09:00-12:00 and
// 12:00-15:00 are adjacent, not colliding.
export class ScheduleCollisionError extends Error {
  constructor() {
    super('Schedule template overlaps an existing template for this doctor');
    this.name = 'ScheduleCollisionError';
  }
}

// A clinic closure (holiday) cannot be added over a day that still has any
// non-cancelled session in that clinic: those sessions may carry queue entries
// and appointments, which must be resolved through the existing session
// cancellation flow first. Fail closed instead of silently orphaning them.
export class ClinicClosureConflictError extends Error {
  constructor() {
    super('Clinic closure day already has non-cancelled sessions');
    this.name = 'ClinicClosureConflictError';
  }
}

// Reject nonexistent calendar days before passing a date to PostgreSQL.
// JavaScript Date and PostgreSQL otherwise have different normalization
// and error paths for February 30 / non-leap February 29.
function requireCalendarDay(value: string, name: string): void {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : null;
  if (
    !parsed ||
    Number(value.slice(0, 4)) < 1 ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new TypeError(`${name} must be a real YYYY-MM-DD calendar day`);
}

// Closure creation, session generation and manual session creation for one
// clinic are serialized, so a closure and a new session can never both commit
// for the same day.
export async function lockClinicCalendar(
  client: Queryable,
  clinicId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('clinic-calendar:' || $1::uuid::text, 0))`,
    [clinicId],
  );
}

// TAB-P0-02 (#640): true when the doctor already has a non-cancelled session
// in this clinic overlapping the half-open range [startsAt, endsAt). Callers
// must hold the clinic calendar lock so the check and their insert are atomic.
export async function doctorSessionOverlaps(
  client: Queryable,
  input: { clinicId: string; doctorId: string; startsAt: Date; endsAt: Date },
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM consultation_sessions
      WHERE clinic_id = $1 AND doctor_id = $2 AND status <> 'cancelled'
        AND starts_at < $4::timestamptz AND $3::timestamptz < ends_at
      LIMIT 1`,
    [input.clinicId, input.doctorId, input.startsAt, input.endsAt],
  );
  return (result.rowCount ?? 0) > 0;
}

export class SchedulingService {
  constructor(private readonly pool: Pool) {}

  async listTemplates(
    scope: ClinicScope,
    doctorId: string,
  ): Promise<ScheduleTemplate[]> {
    await requireClinicRole(this.pool, scope, [
      'doctor',
      'receptionist',
      'clinic_admin',
    ]);
    const result = await this.pool.query<TemplateRow>(
      `SELECT id, clinic_id, doctor_id, weekday, local_start_time::text,
              local_end_time::text, occurrence_index, active
         FROM schedule_templates WHERE clinic_id = $1 AND doctor_id = $2
         ORDER BY weekday, occurrence_index`,
      [scope.clinicId, doctorId],
    );
    return result.rows.map(templateFromRow);
  }

  async createTemplate(
    scope: ClinicScope,
    input: Omit<ScheduleTemplate, 'id' | 'clinicId' | 'active'> & {
      active?: boolean;
    },
  ): Promise<ScheduleTemplate> {
    return inTransaction(this.pool, async (client) => {
      await requireScheduleWrite(client, scope, input.doctorId);
      const active = input.active ?? true;
      if (active) {
        // Serialize collision check and insert per doctor so two concurrent
        // overlapping creates cannot both pass the check. The key uses the
        // canonical uuid text, so equivalent spellings (for example upper
        // and lower case) of one doctor id share one lock.
        await client.query(
          `SELECT pg_advisory_xact_lock(
             hashtextextended('schedule-template:' || $1::uuid::text, 0))`,
          [input.doctorId],
        );
        const collision = await client.query(
          `SELECT 1 FROM schedule_templates
            WHERE clinic_id = $1 AND doctor_id = $2 AND weekday = $3 AND active
              AND local_start_time < $5::time AND $4::time < local_end_time
            LIMIT 1`,
          [
            scope.clinicId,
            input.doctorId,
            input.weekday,
            input.localStartTime,
            input.localEndTime,
          ],
        );
        if (collision.rowCount) throw new ScheduleCollisionError();
      }
      const id = randomUUID();
      const result = await client.query<TemplateRow>(
        `INSERT INTO schedule_templates
           (id, clinic_id, doctor_id, weekday, local_start_time, local_end_time, occurrence_index, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, clinic_id, doctor_id, weekday, local_start_time::text,
                   local_end_time::text, occurrence_index, active`,
        [
          id,
          scope.clinicId,
          input.doctorId,
          input.weekday,
          input.localStartTime,
          input.localEndTime,
          input.occurrenceIndex,
          active,
        ],
      );
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'schedule_template',
        entityId: id,
        action: 'schedule_template.created',
      });
      return templateFromRow(result.rows[0]!);
    });
  }

  async generateSessions(
    scope: ClinicScope,
    input: { doctorId: string; startDate: string; daysAhead?: number },
  ): Promise<number> {
    const daysAhead = input.daysAhead ?? 7;
    if (!Number.isInteger(daysAhead) || daysAhead < 7 || daysAhead > 366)
      throw new RangeError('daysAhead must be an integer from 7 through 366');
    requireCalendarDay(input.startDate, 'startDate');

    return inTransaction(this.pool, async (client) => {
      await requireScheduleWrite(client, scope, input.doctorId);
      await lockClinicCalendar(client, scope.clinicId);
      // Each candidate occurrence is skipped when it would overlap a
      // non-cancelled session of the same doctor in this clinic (for example a
      // manual session), other than its own already-generated occurrence,
      // which ON CONFLICT keeps idempotent. Skips are counted and audited.
      // An occurrence whose local start or end wall time does not exist on
      // its service date (a DST spring-forward gap) is skipped as well:
      // PostgreSQL would otherwise shift it to another instant, or collapse it
      // to zero length and fail the whole call on the duration CHECK.
      const generated = await client.query<{
        generated: number;
        skipped: number;
        skipped_nonexistent: number;
      }>(
        `WITH candidates AS (
           SELECT t.id AS template_id, t.clinic_id, t.doctor_id,
                  day::date AS service_date, t.occurrence_index,
                  (day::date + t.local_start_time) AT TIME ZONE c.timezone AS starts_at,
                  (day::date + t.local_end_time) AT TIME ZONE c.timezone AS ends_at,
                  (((day::date + t.local_start_time) AT TIME ZONE c.timezone) AT TIME ZONE c.timezone
                     <> day::date + t.local_start_time
                   OR ((day::date + t.local_end_time) AT TIME ZONE c.timezone) AT TIME ZONE c.timezone
                     <> day::date + t.local_end_time) AS nonexistent_local_time
             FROM schedule_templates t
             JOIN clinics c ON c.id = t.clinic_id
             CROSS JOIN generate_series(
               $3::date, $3::date + ($4::integer - 1), interval '1 day'
             ) generated(day)
            WHERE t.clinic_id = $1 AND t.doctor_id = $2 AND t.active
              AND extract(dow FROM day::date)::smallint = t.weekday
              AND NOT EXISTS (
                SELECT 1 FROM clinic_closures closure
                 WHERE closure.clinic_id = t.clinic_id
                   AND closure.closure_date = day::date)
         ), checked AS (
           SELECT candidate.*, EXISTS (
                    SELECT 1 FROM consultation_sessions existing
                     WHERE existing.clinic_id = candidate.clinic_id
                       AND existing.doctor_id = candidate.doctor_id
                       AND existing.status <> 'cancelled'
                       AND existing.starts_at < candidate.ends_at
                       AND candidate.starts_at < existing.ends_at
                       AND NOT (existing.template_id IS NOT DISTINCT FROM candidate.template_id
                                AND existing.service_date = candidate.service_date
                                AND existing.template_occurrence = candidate.occurrence_index)
                  ) AS collides
             FROM candidates candidate
            WHERE NOT candidate.nonexistent_local_time
         ), inserted AS (
           INSERT INTO consultation_sessions
             (id, clinic_id, doctor_id, template_id, service_date,
              template_occurrence, starts_at, ends_at)
           SELECT (
                    substr(md5(template_id::text || ':' || service_date::text || ':' || occurrence_index::text), 1, 8) || '-' ||
                    substr(md5(template_id::text || ':' || service_date::text || ':' || occurrence_index::text), 9, 4) || '-' ||
                    substr(md5(template_id::text || ':' || service_date::text || ':' || occurrence_index::text), 13, 4) || '-' ||
                    substr(md5(template_id::text || ':' || service_date::text || ':' || occurrence_index::text), 17, 4) || '-' ||
                    substr(md5(template_id::text || ':' || service_date::text || ':' || occurrence_index::text), 21, 12)
                  )::uuid,
                  clinic_id, doctor_id, template_id, service_date,
                  occurrence_index, starts_at, ends_at
             FROM checked WHERE NOT collides
           ON CONFLICT (clinic_id, doctor_id, service_date, template_id, template_occurrence)
             WHERE template_id IS NOT NULL DO NOTHING
           RETURNING id
         )
         SELECT (SELECT count(*) FROM inserted)::int AS generated,
                (SELECT count(*) FROM checked WHERE collides)::int AS skipped,
                (SELECT count(*) FROM candidates
                  WHERE nonexistent_local_time)::int AS skipped_nonexistent`,
        [scope.clinicId, input.doctorId, input.startDate, daysAhead],
      );
      const {
        generated: count,
        skipped,
        skipped_nonexistent: skippedNonexistent,
      } = generated.rows[0]!;
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'doctor',
        entityId: input.doctorId,
        action: 'sessions.generated',
        metadata: {
          startDate: input.startDate,
          daysAhead,
          generated: count,
          skippedCollisions: skipped,
          skippedNonexistentLocalTime: skippedNonexistent,
        },
      });
      return count;
    });
  }

  async listClosures(scope: ClinicScope): Promise<string[]> {
    await requireClinicRole(this.pool, scope, [
      'doctor',
      'receptionist',
      'clinic_admin',
    ]);
    const result = await this.pool.query<{ closure_date: string }>(
      `SELECT closure_date::text FROM clinic_closures
        WHERE clinic_id = $1 ORDER BY closure_date`,
      [scope.clinicId],
    );
    return result.rows.map((row) => row.closure_date);
  }

  async addClosure(
    scope: ClinicScope,
    closureDate: string,
  ): Promise<{ closureDate: string; created: boolean }> {
    requireCalendarDay(closureDate, 'closureDate');
    return inTransaction(this.pool, async (client) => {
      await requireClinicRole(client, scope, ['clinic_admin']);
      await lockClinicCalendar(client, scope.clinicId);
      const existing = await client.query(
        `SELECT 1 FROM clinic_closures
          WHERE clinic_id = $1 AND closure_date = $2::date`,
        [scope.clinicId, closureDate],
      );
      if (existing.rowCount) return { closureDate, created: false };
      const sessions = await client.query(
        `SELECT 1 FROM consultation_sessions
          WHERE clinic_id = $1 AND service_date = $2::date
            AND status <> 'cancelled'
          LIMIT 1`,
        [scope.clinicId, closureDate],
      );
      if (sessions.rowCount) throw new ClinicClosureConflictError();
      await client.query(
        `INSERT INTO clinic_closures (clinic_id, closure_date)
         VALUES ($1, $2::date)`,
        [scope.clinicId, closureDate],
      );
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'clinic',
        entityId: scope.clinicId,
        action: 'clinic_closure.created',
        metadata: { closureDate },
      });
      return { closureDate, created: true };
    });
  }
}

export { AuthorizationError };
