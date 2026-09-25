import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import {
  AppointmentConflictError,
  AppointmentValidationError,
} from '@/modules/appointment';
import { hasAppointmentArrivalGraceExpired } from '@/modules/appointment/waiting-no-show-policy';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import { inTransaction } from '@/platform/database/transaction';

export interface BulkWaitingNoShowReceipt {
  sessionId: string;
  scannedAppointmentCount: number;
  resolvedAppointmentCount: number;
  arrivalGraceMinutes: number;
}

export interface BulkWaitingNoShowInput {
  reason: string;
  idempotencyKey: string;
  correlationId: string;
}

const MAX_BULK_CANDIDATES = 500;

export class AppointmentBulkNoShowService {
  constructor(private readonly pool: Pool) {}

  /**
   * Explicit staff action only; normal close never silently marks patients
   * absent. Locks the session before linked appointments then queue entries,
   * the same order as AppointmentLifecycleService and check-in mutations.
   */
  async resolveWaiting(
    scope: ClinicScope,
    sessionId: string,
    input: BulkWaitingNoShowInput,
  ): Promise<BulkWaitingNoShowReceipt> {
    const reason = input.reason?.trim();
    if (!reason || reason.length > 500)
      throw new AppointmentValidationError(
        'A no-show reason of at most 500 characters is required',
      );
    if (!input.idempotencyKey || input.idempotencyKey.length > 128)
      throw new AppointmentValidationError(
        'A valid idempotency key of at most 128 characters is required',
      );
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify([sessionId, reason]))
      .digest('hex');

    return inTransaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `appointment-bulk-no-show:${scope.clinicId}:${scope.actorUserId}:${input.idempotencyKey}`,
        ],
      );
      // Reauthorize even on an otherwise identical, already completed retry.
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);
      const previous = await client.query<{
        request_fingerprint: string;
        response: BulkWaitingNoShowReceipt;
      }>(
        `SELECT request_fingerprint, response
           FROM appointment_bulk_no_show_receipts
          WHERE clinic_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`,
        [scope.clinicId, scope.actorUserId, input.idempotencyKey],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_fingerprint !== requestFingerprint)
          throw new AppointmentConflictError(
            'Idempotency key was already used for a different bulk no-show command',
          );
        return previous.rows[0].response;
      }

      const sessionResult = await client.query<{ status: string }>(
        `SELECT status FROM consultation_sessions
          WHERE id=$1 AND clinic_id=$2 FOR UPDATE`,
        [sessionId, scope.clinicId],
      );
      if (!sessionResult.rows[0])
        throw new AppointmentConflictError(
          'Consultation session was not found in this clinic',
        );
      if (!['planned', 'open', 'paused'].includes(sessionResult.rows[0].status))
        throw new AppointmentConflictError(
          'Bulk no-show requires a non-terminal consultation session',
        );

      const policy = await client.query<{
        appointment_arrival_grace_minutes: number;
        observed_at: Date;
      }>(
        `SELECT appointment_arrival_grace_minutes, transaction_timestamp() observed_at
           FROM clinics WHERE id=$1`,
        [scope.clinicId],
      );
      const graceMinutes = policy.rows[0]?.appointment_arrival_grace_minutes;
      const observedAt = policy.rows[0]?.observed_at;
      if (graceMinutes === undefined || !observedAt)
        throw new AppointmentConflictError('Clinic no-show policy unavailable');

      // One bounded, stable candidate set. Unlike queue-based no_show, bulk
      // absence is only for booked/confirmed appointments still waiting.
      const candidates = await client.query<{
        id: string;
        queue_entry_id: string;
        scheduled_start_at: Date;
        priority_order: string | null;
      }>(
        `SELECT appointment.id, appointment.queue_entry_id,
                appointment.scheduled_start_at, entry.priority_order
           FROM appointments appointment
           JOIN queue_entries entry
             ON entry.id=appointment.queue_entry_id
            AND entry.clinic_id=appointment.clinic_id
            AND entry.session_id=appointment.session_id
            AND entry.patient_id=appointment.patient_id
          WHERE appointment.clinic_id=$1 AND appointment.session_id=$2
            AND appointment.status IN ('booked','confirmed')
            AND entry.source='appointment' AND entry.state='waiting'
          ORDER BY appointment.id
          LIMIT $3
          FOR UPDATE OF appointment`,
        [scope.clinicId, sessionId, MAX_BULK_CANDIDATES + 1],
      );
      if (candidates.rows.length > MAX_BULK_CANDIDATES)
        throw new AppointmentConflictError(
          'Bulk no-show candidate count exceeds bounded operation limit',
        );

      let resolved = 0;
      let compactPriority = false;
      for (const appointment of candidates.rows) {
        if (
          !hasAppointmentArrivalGraceExpired({
            scheduledStartAt: appointment.scheduled_start_at,
            observedAt,
            graceMinutes,
          })
        )
          continue;
        const linked = await client.query<{ state: string; source: string }>(
          `SELECT state,source FROM queue_entries
            WHERE id=$1 AND session_id=$2 AND clinic_id=$3 FOR UPDATE`,
          [appointment.queue_entry_id, sessionId, scope.clinicId],
        );
        if (
          linked.rows[0]?.state !== 'waiting' ||
          linked.rows[0]?.source !== 'appointment'
        )
          throw new AppointmentConflictError(
            'Bulk no-show encountered a changed appointment queue linkage',
          );
        // The queue trigger synchronizes linked appointment status within
        // this very transaction. No committed split no_show/waiting pair.
        await client.query(
          `UPDATE queue_entries SET state='no_show',
                 priority_order=NULL, updated_at=now()
            WHERE id=$1 AND session_id=$2 AND clinic_id=$3`,
          [appointment.queue_entry_id, sessionId, scope.clinicId],
        );
        compactPriority ||= appointment.priority_order !== null;
        resolved++;
        await appendAuditEvent(client, {
          clinicId: scope.clinicId,
          actorUserId: scope.actorUserId,
          entityType: 'appointment',
          entityId: appointment.id,
          action: 'appointment.no_show_bulk',
          metadata: {
            command: 'no_show_bulk',
            outcome: 'applied',
            reason,
            sessionId,
            queueEntryId: appointment.queue_entry_id,
            graceMinutes,
            correlationId: input.correlationId,
            idempotencyKey: input.idempotencyKey,
          },
        });
      }

      if (compactPriority) {
        const priority = await client.query<{ id: string }>(
          `SELECT id FROM queue_entries
            WHERE clinic_id=$1 AND session_id=$2
              AND state IN ('waiting','checked_in')
              AND priority_order IS NOT NULL
            ORDER BY priority_order,registration_order FOR UPDATE`,
          [scope.clinicId, sessionId],
        );
        const ids = priority.rows.map((entry) => entry.id);
        if (ids.length) {
          await client.query(
            'UPDATE queue_entries SET priority_order=NULL WHERE id=ANY($1::uuid[])',
            [ids],
          );
          for (let index = 0; index < ids.length; index++)
            await client.query(
              'UPDATE queue_entries SET priority_order=$2,updated_at=now() WHERE id=$1',
              [ids[index], index + 1],
            );
        }
      }

      if (resolved)
        await client.query(
          `UPDATE consultation_sessions
              SET queue_order_version=queue_order_version+1,updated_at=now()
            WHERE id=$1 AND clinic_id=$2`,
          [sessionId, scope.clinicId],
        );
      const response: BulkWaitingNoShowReceipt = {
        sessionId,
        scannedAppointmentCount: candidates.rows.length,
        resolvedAppointmentCount: resolved,
        arrivalGraceMinutes: graceMinutes,
      };
      await appendAuditEvent(client, {
        clinicId: scope.clinicId,
        actorUserId: scope.actorUserId,
        entityType: 'consultation_session',
        entityId: sessionId,
        action: 'consultation_session.bulk_no_show',
        metadata: {
          outcome: 'applied',
          resolvedCount: resolved,
          scannedAppointmentCount: candidates.rows.length,
          graceMinutes,
          reason,
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await client.query(
        `INSERT INTO appointment_bulk_no_show_receipts
           (clinic_id, actor_user_id, idempotency_key,
            request_fingerprint, session_id, response)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          scope.clinicId,
          scope.actorUserId,
          input.idempotencyKey,
          requestFingerprint,
          sessionId,
          JSON.stringify(response),
        ],
      );
      return response;
    });
  }
}
