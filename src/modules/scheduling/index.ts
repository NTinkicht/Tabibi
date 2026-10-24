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

// Closure creation and session generation for one clinic are serialized, so a
// concurrent closure and generation can never both commit for the same day.
async function lockClinicCalendar(
  client: Queryable,
  clinicId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('clinic-calendar:' || $1::uuid::text, 0))`,
    [clinicId],
  );
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
      const generated = await client.query<{ id: string }>(
        `INSERT INTO consultation_sessions
           (id, clinic_id, doctor_id, template_id, service_date,
            template_occurrence, starts_at, ends_at)
         SELECT (
                  substr(md5(t.id::text || ':' || day::date::text || ':' || t.occurrence_index::text), 1, 8) || '-' ||
                  substr(md5(t.id::text || ':' || day::date::text || ':' || t.occurrence_index::text), 9, 4) || '-' ||
                  substr(md5(t.id::text || ':' || day::date::text || ':' || t.occurrence_index::text), 13, 4) || '-' ||
                  substr(md5(t.id::text || ':' || day::date::text || ':' || t.occurrence_index::text), 17, 4) || '-' ||
                  substr(md5(t.id::text || ':' || day::date::text || ':' || t.occurrence_index::text), 21, 12)
                )::uuid,
                t.clinic_id, t.doctor_id, t.id, day::date,
                t.occurrence_index,
                (day::date + t.local_start_time) AT TIME ZONE c.timezone,
                (day::date + t.local_end_time) AT TIME ZONE c.timezone
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
         ON CONFLICT (clinic_id, doctor_id, service_date, template_id, template_occurrence)
           WHERE template_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [scope.clinicId, input.doctorId, input.startDate, daysAhead],
      );
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'doctor',
        entityId: input.doctorId,
        action: 'sessions.generated',
        metadata: {
          startDate: input.startDate,
          daysAhead,
          generated: generated.rowCount ?? 0,
        },
      });
      return generated.rowCount ?? 0;
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
