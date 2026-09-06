import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import {
  AuthorizationError,
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
export type SessionCommand = 'open' | 'pause' | 'resume' | 'close' | 'cancel';
export type DelayCommand = 'declare_delay' | 'update_delay' | 'clear_delay';
export const MAX_DELAY_MINUTES = 720;

export interface ConsultationSession {
  id: string;
  clinicId: string;
  doctorId: string;
  doctorDisplayName: string;
  templateId: string | null;
  serviceDate: string;
  startsAt: Date;
  endsAt: Date;
  status: SessionStatus;
  openedAt: Date | null;
  closedAt: Date | null;
  declaredDelayMinutes: number | null;
  delayVersion: number;
  delayUpdatedAt: Date | null;
}

interface SessionRow {
  id: string;
  clinic_id: string;
  doctor_id: string;
  doctor_display_name: string;
  template_id: string | null;
  service_date: string;
  starts_at: Date;
  ends_at: Date;
  status: SessionStatus;
  opened_at: Date | null;
  closed_at: Date | null;
  declared_delay_minutes: number | null;
  delay_version: number;
  delay_updated_at: Date | null;
}

const selection = `session.id, session.clinic_id, session.doctor_id,
  doctor.display_name AS doctor_display_name, session.template_id,
  session.service_date::text, session.starts_at, session.ends_at, session.status,
  session.opened_at, session.closed_at, session.declared_delay_minutes,
  session.delay_version, session.delay_updated_at`;

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
  return {
    id: row.id,
    clinicId: row.clinic_id,
    doctorId: row.doctor_id,
    doctorDisplayName: row.doctor_display_name,
    templateId: row.template_id,
    serviceDate: row.service_date,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    declaredDelayMinutes: row.declared_delay_minutes,
    delayVersion: row.delay_version,
    delayUpdatedAt: row.delay_updated_at,
  };
}

async function requireSessionAccess(
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

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function idempotent(
  client: PoolClient,
  scope: ClinicScope,
  key: string,
  request: object,
  authorize: () => Promise<void>,
  operation: () => Promise<ConsultationSession>,
): Promise<ConsultationSession> {
  if (!key || key.length > 128)
    throw new SessionValidationError('A valid idempotency key is required');
  const digest = fingerprint(request);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${scope.clinicId}:${scope.actorUserId}:${key}`,
  ]);
  await authorize();
  const existing = await client.query<{
    request_fingerprint: string;
    response: ConsultationSession;
  }>(
    `SELECT request_fingerprint, response FROM session_command_receipts
      WHERE clinic_id = $1 AND actor_user_id = $2 AND idempotency_key = $3`,
    [scope.clinicId, scope.actorUserId, key],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].request_fingerprint !== digest)
      throw new SessionConflictError(
        'Idempotency key was already used for a different command',
      );
    const response = existing.rows[0].response;
    return {
      ...response,
      startsAt: new Date(response.startsAt),
      endsAt: new Date(response.endsAt),
      openedAt: response.openedAt ? new Date(response.openedAt) : null,
      closedAt: response.closedAt ? new Date(response.closedAt) : null,
      delayUpdatedAt: response.delayUpdatedAt
        ? new Date(response.delayUpdatedAt)
        : null,
    };
  }
  const result = await operation();
  await client.query(
    `INSERT INTO session_command_receipts
       (clinic_id, actor_user_id, idempotency_key, request_fingerprint, response)
     VALUES ($1, $2, $3, $4, $5)`,
    [scope.clinicId, scope.actorUserId, key, digest, JSON.stringify(result)],
  );
  return result;
}

function validateDate(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  )
    throw new SessionValidationError(
      'serviceDate must be a valid YYYY-MM-DD date',
    );
}

function clinicLocalDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export class SessionService {
  constructor(private readonly pool: Pool) {}

  async listSessions(
    scope: ClinicScope,
    serviceDate: string,
  ): Promise<ConsultationSession[]> {
    validateDate(serviceDate);
    const role = await requireClinicRole(this.pool, scope, [
      'doctor',
      'receptionist',
      'clinic_admin',
    ]);
    const doctor =
      role === 'doctor'
        ? await this.pool.query<{ id: string }>(
            'SELECT id FROM doctor_profiles WHERE user_id = $1',
            [scope.actorUserId],
          )
        : null;
    const result = await this.pool.query<SessionRow>(
      `SELECT ${selection} FROM consultation_sessions session
       JOIN doctor_profiles doctor ON doctor.id = session.doctor_id
       WHERE session.clinic_id = $1 AND session.service_date = $2
         AND ($3::uuid IS NULL OR session.doctor_id = $3)
       ORDER BY session.starts_at, session.id`,
      [scope.clinicId, serviceDate, doctor?.rows[0]?.id ?? null],
    );
    return result.rows.map(fromRow);
  }

  async createManual(
    scope: ClinicScope,
    input: {
      doctorId: string;
      serviceDate: string;
      startsAt: Date;
      endsAt: Date;
      idempotencyKey: string;
      correlationId: string;
    },
  ): Promise<ConsultationSession> {
    validateDate(input.serviceDate);
    if (
      !Number.isFinite(input.startsAt.getTime()) ||
      !Number.isFinite(input.endsAt.getTime()) ||
      input.endsAt <= input.startsAt ||
      input.endsAt.getTime() - input.startsAt.getTime() > 24 * 60 * 60 * 1000
    )
      throw new SessionValidationError(
        'Session end must be after its valid start and within 24 hours',
      );
    return inTransaction(this.pool, (client) =>
      idempotent(
        client,
        scope,
        input.idempotencyKey,
        {
          command: 'create',
          doctorId: input.doctorId,
          serviceDate: input.serviceDate,
          startsAt: input.startsAt.toISOString(),
          endsAt: input.endsAt.toISOString(),
        },
        async () => {
          await requireClinicRole(client, scope, [
            'receptionist',
            'clinic_admin',
          ]);
        },
        async () => {
          const clinicRow = await client.query<{ timezone: string }>(
            'SELECT timezone FROM clinics WHERE id = $1',
            [scope.clinicId],
          );
          const timezone = clinicRow.rows[0]?.timezone;
          if (
            !timezone ||
            clinicLocalDate(input.startsAt, timezone) !== input.serviceDate
          )
            throw new SessionValidationError(
              'serviceDate must match the clinic-local date of startsAt',
            );
          const association = await client.query(
            `SELECT 1 FROM doctor_clinics WHERE clinic_id = $1 AND doctor_id = $2`,
            [scope.clinicId, input.doctorId],
          );
          if (association.rowCount !== 1) throw new AuthorizationError();
          const id = randomUUID();
          const result = await client.query<SessionRow>(
            `INSERT INTO consultation_sessions (id, clinic_id, doctor_id, service_date, starts_at, ends_at)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${selection.replaceAll('session.', 'consultation_sessions.').replace('doctor.display_name AS doctor_display_name', `(SELECT display_name FROM doctor_profiles WHERE id = $3) AS doctor_display_name`)}`,
            [
              id,
              scope.clinicId,
              input.doctorId,
              input.serviceDate,
              input.startsAt,
              input.endsAt,
            ],
          );
          await appendAuditEvent(client, {
            ...scope,
            entityType: 'consultation_session',
            entityId: id,
            action: 'consultation_session.created',
            metadata: {
              command: 'create',
              outcome: 'applied',
              correlationId: input.correlationId,
              idempotencyKey: input.idempotencyKey,
            },
          });
          return fromRow(result.rows[0]!);
        },
      ),
    );
  }

  async command(
    scope: ClinicScope,
    sessionId: string,
    input: {
      command: SessionCommand;
      reason?: string;
      idempotencyKey: string;
      correlationId: string;
    },
  ): Promise<ConsultationSession> {
    if (input.command === 'cancel' && !input.reason?.trim())
      throw new SessionValidationError('Cancellation reason is required');
    return inTransaction(this.pool, (client) => {
      let doctorId = '';
      return idempotent(
        client,
        scope,
        input.idempotencyKey,
        {
          command: input.command,
          sessionId,
          reason: input.reason?.trim() ?? null,
        },
        async () => {
          const identified = await client.query<{ doctor_id: string }>(
            `SELECT doctor_id FROM consultation_sessions WHERE id=$1 AND clinic_id=$2`,
            [sessionId, scope.clinicId],
          );
          const identity = identified.rows[0];
          if (!identity)
            throw new SessionConflictError('Session not found in clinic');
          doctorId = identity.doctor_id;
          await requireSessionAccess(client, scope, doctorId);
        },
        async () => {
          const target: SessionStatus = {
            open: 'open',
            pause: 'paused',
            resume: 'open',
            close: 'closed',
            cancel: 'cancelled',
          }[input.command] as SessionStatus;
          if (target === 'open')
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
              doctorId,
            ]);
          const selected = await client.query<SessionRow>(
            `SELECT ${selection} FROM consultation_sessions session JOIN doctor_profiles doctor ON doctor.id=session.doctor_id WHERE session.id=$1 AND session.clinic_id=$2 FOR UPDATE OF session`,
            [sessionId, scope.clinicId],
          );
          const current = selected.rows[0]!;
          if (!canTransitionSession(current.status, target))
            throw new SessionConflictError(
              `Cannot transition session from ${current.status} to ${target} (${input.command})`,
            );
          try {
            const entriesCancelledBySession =
              target === 'cancelled'
                ? await client.query<{
                    id: string;
                    prior_state: 'waiting' | 'checked_in' | 'called';
                  }>(
                    `SELECT id, state AS prior_state
                       FROM queue_entries
                      WHERE clinic_id = $1 AND session_id = $2
                        AND state IN ('waiting', 'checked_in', 'called')
                      ORDER BY registration_order
                      FOR UPDATE`,
                    [scope.clinicId, sessionId],
                  )
                : { rows: [] };
            const updated = await client.query<SessionRow>(
              `UPDATE consultation_sessions session SET status=$3::session_status,
              opened_at=CASE WHEN $3::session_status='open' THEN COALESCE(opened_at, now()) ELSE opened_at END,
              closed_at=CASE WHEN $3::session_status IN ('closed','cancelled') THEN now() ELSE closed_at END,
              updated_at=now() FROM doctor_profiles doctor
             WHERE session.id=$1 AND session.clinic_id=$2 AND doctor.id=session.doctor_id RETURNING ${selection}`,
              [sessionId, scope.clinicId, target],
            );
            for (const entry of entriesCancelledBySession.rows) {
              await appendAuditEvent(client, {
                ...scope,
                entityType: 'queue_entry',
                entityId: entry.id,
                action: 'queue_entry.cancelled_by_session',
                metadata: {
                  from: entry.prior_state,
                  to: 'cancelled',
                  reason: input.reason!.trim(),
                  sessionId,
                  correlationId: input.correlationId,
                  idempotencyKey: input.idempotencyKey,
                },
              });
            }
            await appendAuditEvent(client, {
              ...scope,
              entityType: 'consultation_session',
              entityId: sessionId,
              action: `consultation_session.${input.command}`,
              metadata: {
                command: input.command,
                outcome: 'applied',
                from: current.status,
                to: target,
                reason: input.reason?.trim() ?? null,
                correlationId: input.correlationId,
                idempotencyKey: input.idempotencyKey,
              },
            });
            return fromRow(updated.rows[0]!);
          } catch (error) {
            if (
              typeof error === 'object' &&
              error &&
              'code' in error &&
              error.code === '23505'
            )
              throw new SessionConflictError(
                'Doctor already has an open session',
              );
            throw error;
          }
        },
      );
    });
  }

  async delay(
    scope: ClinicScope,
    sessionId: string,
    input: {
      command: DelayCommand;
      minutes?: number;
      expectedVersion: number;
      idempotencyKey: string;
      correlationId: string;
    },
  ): Promise<ConsultationSession> {
    if (
      input.command !== 'clear_delay' &&
      (!Number.isFinite(input.minutes) ||
        !Number.isInteger(input.minutes) ||
        input.minutes! <= 0 ||
        input.minutes! > MAX_DELAY_MINUTES)
    )
      throw new SessionValidationError(
        `Delay minutes must be a positive whole number no greater than ${MAX_DELAY_MINUTES}`,
      );
    return inTransaction(this.pool, (client) =>
      idempotent(
        client,
        scope,
        input.idempotencyKey,
        {
          command: input.command,
          sessionId,
          minutes: input.minutes ?? null,
          expectedVersion: input.expectedVersion,
        },
        async () => {
          const identified = await client.query<{ doctor_id: string }>(
            `SELECT doctor_id FROM consultation_sessions WHERE id=$1 AND clinic_id=$2`,
            [sessionId, scope.clinicId],
          );
          const identity = identified.rows[0];
          if (!identity)
            throw new SessionConflictError('Session not found in clinic');
          await requireSessionAccess(client, scope, identity.doctor_id);
        },
        async () => {
          const selected = await client.query<SessionRow>(
            `SELECT ${selection} FROM consultation_sessions session JOIN doctor_profiles doctor ON doctor.id=session.doctor_id WHERE session.id=$1 AND session.clinic_id=$2 FOR UPDATE OF session`,
            [sessionId, scope.clinicId],
          );
          const current = selected.rows[0];
          if (!current)
            throw new SessionConflictError('Session not found in clinic');
          if (!['planned', 'open', 'paused'].includes(current.status))
            throw new SessionConflictError(
              'Delay cannot change on a terminal session',
            );
          if (current.delay_version !== input.expectedVersion)
            throw new SessionConflictError('Delay version is stale');
          if (
            input.command === 'declare_delay' &&
            current.declared_delay_minutes !== null
          )
            throw new SessionConflictError('Delay is already declared');
          if (
            input.command === 'update_delay' &&
            current.declared_delay_minutes === null
          )
            throw new SessionConflictError('No delay exists to update');
          if (
            input.command === 'clear_delay' &&
            current.declared_delay_minutes === null
          )
            throw new SessionConflictError('No delay exists to clear');
          const minutes =
            input.command === 'clear_delay' ? null : input.minutes!;
          const updated = await client.query<SessionRow>(
            `UPDATE consultation_sessions session SET declared_delay_minutes=$3,
             delay_version=delay_version+1, delay_updated_at=CASE WHEN $3::integer IS NULL THEN NULL ELSE now() END,
             delay_updated_by=$4, updated_at=now() FROM doctor_profiles doctor
           WHERE session.id=$1 AND session.clinic_id=$2 AND doctor.id=session.doctor_id RETURNING ${selection}`,
            [sessionId, scope.clinicId, minutes, scope.actorUserId],
          );
          await appendAuditEvent(client, {
            ...scope,
            entityType: 'consultation_session',
            entityId: sessionId,
            action: `consultation_session.${input.command}`,
            metadata: {
              command: input.command,
              outcome: 'applied',
              minutes,
              from: current.declared_delay_minutes,
              to: minutes,
              version: current.delay_version + 1,
              correlationId: input.correlationId,
              idempotencyKey: input.idempotencyKey,
            },
          });
          return fromRow(updated.rows[0]!);
        },
      ),
    );
  }

  /** Compatibility facade for foundation callers; HTTP commands use explicit identities. */
  async transition(
    scope: ClinicScope,
    sessionId: string,
    target: SessionStatus,
  ): Promise<ConsultationSession> {
    const command: SessionCommand =
      target === 'paused'
        ? 'pause'
        : target === 'closed'
          ? 'close'
          : target === 'cancelled'
            ? 'cancel'
            : 'open';
    return this.command(scope, sessionId, {
      command,
      reason: command === 'cancel' ? 'foundation transition' : undefined,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
  }
}
