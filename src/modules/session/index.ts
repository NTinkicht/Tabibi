import type { Pool } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import {
  type ClinicScope,
  requireClinicRole,
  requireDoctorIdentity,
  type Queryable,
} from '@/modules/identity';
import { inTransaction } from '@/platform/database/transaction';

export type SessionStatus =
  | 'planned'
  | 'open'
  | 'paused'
  | 'closed'
  | 'cancelled';

export interface ConsultationSession {
  id: string;
  clinicId: string;
  doctorId: string;
  templateId: string | null;
  serviceDate: string;
  startsAt: Date;
  endsAt: Date;
  status: SessionStatus;
}

interface SessionRow {
  id: string;
  clinic_id: string;
  doctor_id: string;
  template_id: string | null;
  service_date: string;
  starts_at: Date;
  ends_at: Date;
  status: SessionStatus;
}

const transitions: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  planned: ['open', 'cancelled'],
  open: ['paused', 'closed', 'cancelled'],
  paused: ['open', 'closed', 'cancelled'],
  closed: [],
  cancelled: [],
};

export function canTransitionSession(
  from: SessionStatus,
  to: SessionStatus,
): boolean {
  return transitions[from].includes(to);
}

export class SessionConflictError extends Error {
  constructor(message = 'Session transition conflicts with current state') {
    super(message);
    this.name = 'SessionConflictError';
  }
}

function sessionFromRow(row: SessionRow): ConsultationSession {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    doctorId: row.doctor_id,
    templateId: row.template_id,
    serviceDate: row.service_date,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
  };
}

async function requireSessionWrite(
  db: Queryable,
  scope: ClinicScope,
  doctorId: string,
): Promise<void> {
  const role = await requireClinicRole(db, scope, [
    'doctor',
    'receptionist',
    'clinic_admin',
  ]);
  if (role === 'doctor') await requireDoctorIdentity(db, scope, doctorId);
}

export class SessionService {
  constructor(private readonly pool: Pool) {}

  async listSessions(
    scope: ClinicScope,
    fromDate: string,
    throughDate: string,
  ): Promise<ConsultationSession[]> {
    await requireClinicRole(this.pool, scope, [
      'doctor',
      'receptionist',
      'clinic_admin',
    ]);
    const result = await this.pool.query<SessionRow>(
      `SELECT id, clinic_id, doctor_id, template_id, service_date::text,
              starts_at, ends_at, status
         FROM consultation_sessions
        WHERE clinic_id = $1 AND service_date BETWEEN $2 AND $3
        ORDER BY starts_at, id`,
      [scope.clinicId, fromDate, throughDate],
    );
    return result.rows.map(sessionFromRow);
  }

  async transition(
    scope: ClinicScope,
    sessionId: string,
    target: SessionStatus,
  ): Promise<ConsultationSession> {
    return inTransaction(this.pool, async (client) => {
      const selected = await client.query<SessionRow>(
        `SELECT id, clinic_id, doctor_id, template_id, service_date::text,
                starts_at, ends_at, status
           FROM consultation_sessions
          WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
        [sessionId, scope.clinicId],
      );
      const current = selected.rows[0];
      if (!current)
        throw new SessionConflictError('Session not found in clinic');
      await requireSessionWrite(client, scope, current.doctor_id);
      if (!canTransitionSession(current.status, target))
        throw new SessionConflictError(
          `Cannot transition session from ${current.status} to ${target}`,
        );

      if (target === 'open') {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          current.doctor_id,
        ]);
      }

      try {
        const updated = await client.query<SessionRow>(
          `UPDATE consultation_sessions SET status = $3, updated_at = now()
            WHERE id = $1 AND clinic_id = $2
            RETURNING id, clinic_id, doctor_id, template_id, service_date::text,
                      starts_at, ends_at, status`,
          [sessionId, scope.clinicId, target],
        );
        await appendAuditEvent(client, {
          ...scope,
          entityType: 'consultation_session',
          entityId: sessionId,
          action: 'consultation_session.transitioned',
          metadata: { from: current.status, to: target },
        });
        return sessionFromRow(updated.rows[0]!);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505'
        ) {
          throw new SessionConflictError(
            'Doctor already has an open session in a clinic',
          );
        }
        throw error;
      }
    });
  }
}
