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
          input.active ?? true,
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate))
      throw new TypeError('startDate must use YYYY-MM-DD');

    return inTransaction(this.pool, async (client) => {
      await requireScheduleWrite(client, scope, input.doctorId);
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
}

export { AuthorizationError };
