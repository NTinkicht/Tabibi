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
export type LifecycleCommand = 'open' | 'pause' | 'resume' | 'close' | 'cancel';
export type DelayCommand = 'delay.declare' | 'delay.update' | 'delay.clear';
export type SessionCommand = LifecycleCommand | DelayCommand;

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
  delayMinutes: number | null;
  delayDeclaredAt: Date | null;
  delayDeclaredBy: string | null;
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
  delay_minutes: number | null;
  delay_declared_at: Date | null;
  delay_declared_by: string | null;
}

const selection = `session.id, session.clinic_id, session.doctor_id,
  doctor.display_name AS doctor_name, session.template_id, session.service_date::text,
  session.starts_at, session.ends_at, session.status, session.opened_at,
  session.closed_at, session.delay_minutes, session.delay_declared_at, session.delay_declared_by`;
const joins = `consultation_sessions session JOIN doctor_profiles doctor ON doctor.id = session.doctor_id`;

const targets: Readonly<Record<LifecycleCommand, SessionStatus>> = {
  open: 'open',
  pause: 'paused',
  resume: 'open',
  close: 'closed',
  cancel: 'cancelled',
};
const allowed: Readonly<Record<LifecycleCommand, readonly SessionStatus[]>> = {
  open: ['planned'],
  pause: ['open'],
  resume: ['paused'],
  close: ['open', 'paused'],
  cancel: ['planned', 'open', 'paused'],
};

export function canApplySessionCommand(
  from: SessionStatus,
  command: LifecycleCommand,
): boolean {
  return allowed[command].includes(from);
}

/** Retained as a small compatibility helper for foundation callers. */
export function canTransitionSession(
  from: SessionStatus,
  to: SessionStatus,
): boolean {
  return (Object.keys(targets) as LifecycleCommand[]).some(
    (command) =>
      targets[command] === to && canApplySessionCommand(from, command),
  );
}

export class SessionConflictError extends Error {
  constructor(message = 'Session command conflicts with committed state') {
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

function fromRow(row: SessionRow): ConsultationSession {
  const date = (value: Date | string | null): Date | null =>
    value === null ? null : value instanceof Date ? value : new Date(value);
  return {
    id: row.id,
    clinicId: row.clinic_id,
    doctorId: row.doctor_id,
    doctorName: row.doctor_name,
    templateId: row.template_id,
    serviceDate: row.service_date,
    startsAt: date(row.starts_at)!,
    endsAt: date(row.ends_at)!,
    status: row.status,
    openedAt: date(row.opened_at),
    closedAt: date(row.closed_at),
    delayMinutes: row.delay_minutes,
    delayDeclaredAt: date(row.delay_declared_at),
    delayDeclaredBy: row.delay_declared_by,
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

function validateIdentity(value: string, name: string): void {
  if (!value || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value))
    throw new SessionValidationError(`${name} must be 1-128 safe characters`);
}

function fingerprint(
  command: SessionCommand,
  sessionId: string,
  reason?: string,
  minutes?: number,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ command, sessionId, reason, minutes }))
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
      `SELECT ${selection} FROM ${joins}
       WHERE session.clinic_id = $1 AND session.service_date = $2 ORDER BY session.starts_at, session.id`,
      [scope.clinicId, serviceDate],
    );
    return result.rows.map(fromRow);
  }

  /** @deprecated Use command() so command intent and idempotency are explicit. */
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
    return this.command(scope, sessionId, {
      command,
      idempotencyKey: `legacy:${sessionId}:${target}`,
      correlationId: `legacy:${sessionId}:${target}`,
      reason: command === 'cancel' ? 'legacy cancellation' : undefined,
    });
  }

  async command(
    scope: ClinicScope,
    sessionId: string,
    input: {
      command: LifecycleCommand;
      idempotencyKey: string;
      correlationId: string;
      reason?: string;
    },
  ): Promise<ConsultationSession> {
    validateIdentity(input.idempotencyKey, 'Idempotency key');
    validateIdentity(input.correlationId, 'Correlation ID');
    const reason = input.reason?.trim();
    if (input.command === 'cancel' && !reason)
      throw new SessionValidationError('Cancellation reason is required');
    return this.mutate(
      scope,
      sessionId,
      input.command,
      input.idempotencyKey,
      input.correlationId,
      reason,
      undefined,
    );
  }

  async delay(
    scope: ClinicScope,
    sessionId: string,
    input: {
      command: DelayCommand;
      idempotencyKey: string;
      correlationId: string;
      minutes?: number;
    },
  ): Promise<ConsultationSession> {
    validateIdentity(input.idempotencyKey, 'Idempotency key');
    validateIdentity(input.correlationId, 'Correlation ID');
    if (
      input.command !== 'delay.clear' &&
      (typeof input.minutes !== 'number' ||
        !Number.isFinite(input.minutes) ||
        input.minutes <= 0)
    )
      throw new SessionValidationError(
        'Delay minutes must be a positive finite number',
      );
    return this.mutate(
      scope,
      sessionId,
      input.command,
      input.idempotencyKey,
      input.correlationId,
      undefined,
      input.minutes,
    );
  }

  private async mutate(
    scope: ClinicScope,
    sessionId: string,
    command: SessionCommand,
    key: string,
    correlation: string,
    reason?: string,
    minutes?: number,
  ): Promise<ConsultationSession> {
    return inTransaction(this.pool, async (client) => {
      // Serializes exact retries before reading receipts, including concurrent retries.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [`${scope.clinicId}:${scope.actorUserId}`, key],
      );
      const fp = fingerprint(command, sessionId, reason, minutes);
      const receipt = await client.query<{
        fingerprint: string;
        result: SessionRow;
      }>(
        `SELECT fingerprint, result FROM session_command_receipts
         WHERE clinic_id = $1 AND actor_user_id = $2 AND idempotency_key = $3`,
        [scope.clinicId, scope.actorUserId, key],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].fingerprint !== fp)
          throw new SessionConflictError(
            'Idempotency key was used for a different command',
          );
        return fromRow(receipt.rows[0].result);
      }

      const selected = await client.query<SessionRow>(
        `SELECT ${selection} FROM ${joins} WHERE session.id = $1 AND session.clinic_id = $2 FOR UPDATE OF session`,
        [sessionId, scope.clinicId],
      );
      const current = selected.rows[0];
      if (!current)
        throw new SessionConflictError('Session not found in clinic');
      await authorize(client, scope, current.doctor_id);

      const isDelay = command.startsWith('delay.');
      if (isDelay) {
        if (!['planned', 'open', 'paused'].includes(current.status))
          throw new SessionConflictError(
            `Cannot ${command} for ${current.status} session`,
          );
        if (command === 'delay.declare' && current.delay_minutes !== null)
          throw new SessionConflictError(
            'Delay is already declared; use update',
          );
        if (command === 'delay.update' && current.delay_minutes === null)
          throw new SessionConflictError(
            'No declared delay exists; use declare',
          );
      } else if (
        !canApplySessionCommand(current.status, command as LifecycleCommand)
      ) {
        throw new SessionConflictError(
          `Cannot transition session from ${current.status} to ${targets[command as LifecycleCommand]}`,
        );
      }

      if (command === 'open' || command === 'resume')
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          current.doctor_id,
        ]);

      const target = isDelay
        ? current.status
        : targets[command as LifecycleCommand];
      const clear = command === 'delay.clear';
      try {
        const updated = await client.query<SessionRow>(
          `UPDATE consultation_sessions session SET status = $3,
             opened_at = CASE WHEN $4::text = 'open' AND opened_at IS NULL THEN now() ELSE opened_at END,
             closed_at = CASE WHEN $4::text IN ('close','cancel') THEN now() ELSE closed_at END,
             delay_minutes = CASE WHEN $4::text = 'delay.clear' THEN NULL WHEN $4::text LIKE 'delay.%' THEN $5 ELSE delay_minutes END,
             delay_declared_at = CASE WHEN $4::text = 'delay.clear' THEN NULL WHEN $4::text LIKE 'delay.%' THEN now() ELSE delay_declared_at END,
             delay_declared_by = CASE WHEN $4::text = 'delay.clear' THEN NULL WHEN $4::text LIKE 'delay.%' THEN $6 ELSE delay_declared_by END,
             updated_at = now()
           FROM doctor_profiles doctor WHERE session.doctor_id = doctor.id AND session.id = $1 AND session.clinic_id = $2
           RETURNING ${selection}`,
          [
            sessionId,
            scope.clinicId,
            target,
            command,
            clear ? null : (minutes ?? null),
            scope.actorUserId,
          ],
        );
        const result = updated.rows[0]!;
        await appendAuditEvent(client, {
          ...scope,
          entityType: 'consultation_session',
          entityId: sessionId,
          action: `consultation_session.${command}`,
          metadata: {
            command,
            outcome: 'applied',
            correlationId: correlation,
            idempotencyKey: key,
            ...(reason ? { reason } : {}),
            ...(minutes ? { minutes } : {}),
          },
        });
        await client.query(
          `INSERT INTO session_command_receipts (clinic_id, actor_user_id, idempotency_key, session_id, command, fingerprint, result)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [
            scope.clinicId,
            scope.actorUserId,
            key,
            sessionId,
            command,
            fp,
            JSON.stringify(result),
          ],
        );
        return fromRow(result);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505'
        )
          throw new SessionConflictError('Doctor already has an open session');
        throw error;
      }
    });
  }
}
