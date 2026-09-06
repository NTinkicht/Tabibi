import { createHash } from 'node:crypto';
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
export type SessionCommand =
  | 'open'
  | 'pause'
  | 'resume'
  | 'close'
  | 'cancel'
  | 'delay_declare'
  | 'delay_update'
  | 'delay_clear';

export interface ConsultationSession {
  id: string;
  clinicId: string;
  doctorId: string;
  doctorName: string;
  templateId: string | null;
  serviceDate: string;
  startsAt: Date;
  endsAt: Date;
  status: SessionStatus;
  openedAt: Date | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  delayMinutes: number | null;
  delayUpdatedAt: Date | null;
}

interface SessionRow {
  id: string;
  clinic_id: string;
  doctor_id: string;
  doctor_name: string;
  template_id: string | null;
  service_date: string;
  starts_at: Date;
  ends_at: Date;
  status: SessionStatus;
  opened_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  delay_minutes: string | null;
  delay_updated_at: Date | null;
}

export interface SessionOperation {
  command: SessionCommand;
  idempotencyKey: string;
  correlationId: string;
  reason?: string;
  delayMinutes?: number;
}

const targetByCommand: Partial<Record<SessionCommand, SessionStatus>> = {
  open: 'open',
  pause: 'paused',
  resume: 'open',
  close: 'closed',
  cancel: 'cancelled',
};
const allowed: Readonly<Record<SessionStatus, readonly SessionCommand[]>> = {
  planned: ['open', 'cancel', 'delay_declare', 'delay_update', 'delay_clear'],
  open: [
    'pause',
    'close',
    'cancel',
    'delay_declare',
    'delay_update',
    'delay_clear',
  ],
  paused: [
    'resume',
    'close',
    'cancel',
    'delay_declare',
    'delay_update',
    'delay_clear',
  ],
  closed: [],
  cancelled: [],
};

export function canApplySessionCommand(
  from: SessionStatus,
  command: SessionCommand,
): boolean {
  return allowed[from].includes(command);
}

export function canTransitionSession(
  from: SessionStatus,
  to: SessionStatus,
): boolean {
  return Object.entries(targetByCommand).some(
    ([command, target]) =>
      target === to && canApplySessionCommand(from, command as SessionCommand),
  );
}

export class SessionConflictError extends Error {
  constructor(message = 'Session operation conflicts with current state') {
    super(message);
    this.name = 'SessionConflictError';
  }
}
export class SessionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionValidationError';
  }
}

const selectColumns = `session.id, session.clinic_id, session.doctor_id,
  doctor.display_name AS doctor_name, session.template_id, session.service_date::text,
  session.starts_at, session.ends_at, session.status, session.opened_at,
  session.closed_at, session.cancelled_at, session.cancellation_reason,
  session.delay_minutes::text, session.delay_updated_at`;

function fromRow(row: SessionRow): ConsultationSession {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    doctorId: row.doctor_id,
    doctorName: row.doctor_name,
    templateId: row.template_id,
    serviceDate: row.service_date,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    delayMinutes: row.delay_minutes === null ? null : Number(row.delay_minutes),
    delayUpdatedAt: row.delay_updated_at,
  };
}

async function authorize(
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

function validate(operation: SessionOperation): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(operation.idempotencyKey))
    throw new SessionValidationError('A valid idempotency key is required');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(operation.correlationId))
    throw new SessionValidationError(
      'A valid correlation identity is required',
    );
  if (operation.command === 'cancel' && !operation.reason?.trim())
    throw new SessionValidationError(
      'Cancellation requires a non-empty operational reason',
    );
  if (
    operation.command === 'delay_declare' ||
    operation.command === 'delay_update'
  ) {
    if (
      typeof operation.delayMinutes !== 'number' ||
      !Number.isFinite(operation.delayMinutes) ||
      operation.delayMinutes <= 0
    )
      throw new SessionValidationError(
        'Delay minutes must be a positive finite number',
      );
  }
}

function fingerprint(sessionId: string, operation: SessionOperation): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sessionId,
        command: operation.command,
        reason: operation.reason?.trim() ?? null,
        delayMinutes: operation.delayMinutes ?? null,
      }),
    )
    .digest('hex');
}

export class SessionService {
  constructor(private readonly pool: Pool) {}

  async listSessions(
    scope: ClinicScope,
    serviceDate: string,
  ): Promise<ConsultationSession[]> {
    await requireClinicRole(this.pool, scope, [
      'doctor',
      'receptionist',
      'clinic_admin',
    ]);
    const result = await this.pool.query<SessionRow>(
      `SELECT ${selectColumns} FROM consultation_sessions session
       JOIN doctor_profiles doctor ON doctor.id = session.doctor_id
       WHERE session.clinic_id = $1 AND session.service_date = $2
       ORDER BY session.starts_at, session.id`,
      [scope.clinicId, serviceDate],
    );
    return result.rows.map(fromRow);
  }

  async operate(
    scope: ClinicScope,
    sessionId: string,
    operation: SessionOperation,
  ): Promise<ConsultationSession> {
    validate(operation);
    return inTransaction(this.pool, async (client) => {
      // Resolve and authorize the tenant-scoped target without taking its row lock.
      // Commands that can make a session open must acquire the doctor-global lock
      // before the clinic/session lock, matching every future service-stream writer.
      const resolved = await client.query<SessionRow>(
        `SELECT ${selectColumns} FROM consultation_sessions session
         JOIN doctor_profiles doctor ON doctor.id = session.doctor_id
         WHERE session.id = $1 AND session.clinic_id = $2`,
        [sessionId, scope.clinicId],
      );
      const candidate = resolved.rows[0];
      if (!candidate)
        throw new SessionConflictError('Session not found in clinic');
      await authorize(client, scope, candidate.doctor_id);
      if (operation.command === 'open' || operation.command === 'resume')
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          candidate.doctor_id,
        ]);

      const selected = await client.query<SessionRow>(
        `SELECT ${selectColumns} FROM consultation_sessions session
         JOIN doctor_profiles doctor ON doctor.id = session.doctor_id
         WHERE session.id = $1 AND session.clinic_id = $2 FOR UPDATE OF session`,
        [sessionId, scope.clinicId],
      );
      const current = selected.rows[0];
      if (!current)
        throw new SessionConflictError('Session not found in clinic');
      await authorize(client, scope, current.doctor_id);
      if (current.doctor_id !== candidate.doctor_id)
        throw new SessionConflictError(
          'Session doctor changed during operation',
        );

      const requestFingerprint = fingerprint(sessionId, operation);
      const receipt = await client.query<{
        request_fingerprint: string;
        result: ConsultationSession;
      }>(
        `SELECT request_fingerprint, result FROM session_operation_receipts
         WHERE clinic_id = $1 AND idempotency_key = $2`,
        [scope.clinicId, operation.idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].request_fingerprint !== requestFingerprint)
          throw new SessionConflictError(
            'Idempotency key was already used for another operation',
          );
        return hydrateReceipt(receipt.rows[0].result);
      }
      if (!canApplySessionCommand(current.status, operation.command))
        throw new SessionConflictError(
          `Cannot ${operation.command} session from ${current.status}`,
        );

      const target = targetByCommand[operation.command];
      const reason = operation.reason?.trim() ?? null;
      try {
        await client.query(
          `UPDATE consultation_sessions SET
             status = COALESCE($3::session_status, status),
             opened_at = CASE WHEN $4 = 'open' THEN COALESCE(opened_at, now()) ELSE opened_at END,
             closed_at = CASE WHEN $4 = 'close' THEN now() ELSE closed_at END,
             cancelled_at = CASE WHEN $4 = 'cancel' THEN now() ELSE cancelled_at END,
             cancellation_reason = CASE WHEN $4 = 'cancel' THEN $5 ELSE cancellation_reason END,
             delay_minutes = CASE WHEN $4 IN ('delay_declare','delay_update') THEN $6::numeric WHEN $4 = 'delay_clear' THEN NULL ELSE delay_minutes END,
             delay_updated_at = CASE WHEN $4 LIKE 'delay_%' THEN now() ELSE delay_updated_at END,
             updated_at = now() WHERE id = $1 AND clinic_id = $2`,
          [
            sessionId,
            scope.clinicId,
            target ?? null,
            operation.command,
            reason,
            operation.delayMinutes ?? null,
          ],
        );
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505'
        )
          throw new SessionConflictError(
            'Doctor already has an open session in a clinic',
          );
        throw error;
      }
      const refreshed = await client.query<SessionRow>(
        `SELECT ${selectColumns} FROM consultation_sessions session
         JOIN doctor_profiles doctor ON doctor.id = session.doctor_id WHERE session.id = $1`,
        [sessionId],
      );
      const result = fromRow(refreshed.rows[0]!);
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'consultation_session',
        entityId: sessionId,
        action: `consultation_session.${operation.command}`,
        metadata: {
          command: operation.command,
          outcome: 'applied',
          correlationId: operation.correlationId,
          idempotencyKey: operation.idempotencyKey,
          from: current.status,
          to: result.status,
          ...(reason ? { reason } : {}),
          ...(operation.delayMinutes
            ? { delayMinutes: operation.delayMinutes }
            : {}),
        },
      });
      await client.query(
        `INSERT INTO session_operation_receipts
          (clinic_id, idempotency_key, actor_user_id, session_id, command, request_fingerprint, result)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          scope.clinicId,
          operation.idempotencyKey,
          scope.actorUserId,
          sessionId,
          operation.command,
          requestFingerprint,
          JSON.stringify(result),
        ],
      );
      return result;
    });
  }

  /** Compatibility wrapper; new callers should use operate with an idempotency identity. */
  async transition(
    scope: ClinicScope,
    sessionId: string,
    target: SessionStatus,
  ): Promise<ConsultationSession> {
    const command =
      target === 'paused'
        ? 'pause'
        : target === 'closed'
          ? 'close'
          : target === 'cancelled'
            ? 'cancel'
            : 'open';
    try {
      return await this.operate(scope, sessionId, {
        command,
        reason: command === 'cancel' ? 'legacy transition' : undefined,
        idempotencyKey: `legacy-${crypto.randomUUID()}`,
        correlationId: crypto.randomUUID(),
      });
    } catch (error) {
      if (
        error instanceof SessionConflictError &&
        error.message.startsWith(`Cannot ${command} session from `)
      ) {
        const from = error.message.slice(error.message.lastIndexOf(' ') + 1);
        throw new SessionConflictError(
          `Cannot transition session from ${from} to ${target}`,
        );
      }
      throw error;
    }
  }
}

function hydrateReceipt(value: ConsultationSession): ConsultationSession {
  return {
    ...value,
    startsAt: new Date(value.startsAt),
    endsAt: new Date(value.endsAt),
    openedAt: value.openedAt ? new Date(value.openedAt) : null,
    closedAt: value.closedAt ? new Date(value.closedAt) : null,
    cancelledAt: value.cancelledAt ? new Date(value.cancelledAt) : null,
    delayUpdatedAt: value.delayUpdatedAt
      ? new Date(value.delayUpdatedAt)
      : null,
  };
}
