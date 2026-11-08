import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import {
  QueueConflictError,
  QueueValidationError,
  type StaffQueueEntry,
} from '@/modules/queue';
import type { QueueEntryState } from '@/modules/queue/lifecycle-contract';
import { inTransaction } from '@/platform/database/transaction';

/**
 * Staff restore of a mistaken walk-in/guest terminal outcome (TAB-P0-07,
 * #810 slice 1). A cancelled or no-show entry returns to `waiting`, or to
 * `checked_in` at a fresh eligibility tail (`restore_and_check_in`). The row
 * keeps its identity, registration order, public label and audit history;
 * live priority is never carried back (it was cleared on exit). Appointment-
 * backed entries are refused here: they restore through the appointment
 * recovery service so appointment and queue state stay synchronized.
 */
export interface QueueRestoreInput {
  checkIn: boolean;
  reason: string;
  idempotencyKey: string;
  correlationId: string;
}

const RESTORABLE: readonly QueueEntryState[] = ['cancelled', 'no_show'];

export class QueueRestoreService {
  constructor(private readonly pool: Pool) {}

  async restore(
    scope: ClinicScope,
    sessionId: string,
    entryId: string,
    rawInput: QueueRestoreInput,
  ): Promise<StaffQueueEntry> {
    const reason = rawInput.reason.trim();
    if (!rawInput.idempotencyKey || rawInput.idempotencyKey.length > 128)
      throw new QueueValidationError('A valid idempotency key is required');
    if (!reason) throw new QueueValidationError('Restore reason is required');
    if (reason.length > 500)
      throw new QueueValidationError(
        'Restore reason must be at most 500 characters',
      );
    const command = rawInput.checkIn ? 'restore_and_check_in' : 'restore';
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ sessionId, entryId, command, reason }))
      .digest('hex');

    return inTransaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `queue-command:${scope.clinicId}:${scope.actorUserId}:${rawInput.idempotencyKey}`,
        ],
      );
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);
      const receipt = await client.query<{
        request_fingerprint: string;
        response: StaffQueueEntry;
      }>(
        `SELECT request_fingerprint, response FROM queue_command_receipts
          WHERE clinic_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`,
        [scope.clinicId, scope.actorUserId, rawInput.idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].request_fingerprint !== requestFingerprint)
          throw new QueueConflictError(
            'Idempotency key was already used for a different queue command',
          );
        return receipt.rows[0].response;
      }

      const session = await client.query<{ status: string }>(
        `SELECT status FROM consultation_sessions
          WHERE id=$1 AND clinic_id=$2 FOR UPDATE`,
        [sessionId, scope.clinicId],
      );
      if (!session.rows[0])
        throw new QueueConflictError(
          'Consultation session was not found in this clinic',
        );
      if (!['open', 'paused'].includes(session.rows[0].status))
        throw new QueueConflictError(
          'Queue restore requires an open or paused session',
        );

      const current = await client.query<{
        state: QueueEntryState;
        source: string;
      }>(
        `SELECT state, source FROM queue_entries
          WHERE id=$1 AND session_id=$2 AND clinic_id=$3 FOR UPDATE`,
        [entryId, sessionId, scope.clinicId],
      );
      const entry = current.rows[0];
      if (!entry)
        throw new QueueConflictError(
          'Queue entry was not found in this clinic and session',
        );
      if (entry.source !== 'walk_in')
        throw new QueueConflictError(
          'Appointment-backed entries are restored through the appointment recovery route',
        );
      if (!RESTORABLE.includes(entry.state))
        throw new QueueConflictError(
          `Cannot restore queue entry in ${entry.state}`,
        );

      const target: QueueEntryState = rawInput.checkIn
        ? 'checked_in'
        : 'waiting';
      let eligibilityOrder: number | null = null;
      if (rawInput.checkIn) {
        const next = await client.query<{ value: string }>(
          `SELECT COALESCE(MAX(eligibility_order), 0) + 1 AS value
             FROM queue_entries WHERE session_id=$1`,
          [sessionId],
        );
        eligibilityOrder = Number(next.rows[0]!.value);
      }
      const updated = await client.query<{
        id: string;
        session_id: string;
        state: QueueEntryState;
        registration_order: string;
        eligibility_order: string | null;
        priority_order: string | null;
        public_display_label: string;
        private_display_name: string;
        preferred_locale: 'ar' | 'fr';
        contact_phone: string | null;
        contact_email: string | null;
      }>(
        `UPDATE queue_entries entry
            SET state=$4::queue_entry_status, eligibility_order=$5,
                priority_order=NULL, in_consultation_started_at=NULL,
                completed_at=NULL, updated_at=now()
           FROM patient_operational_records patient
          WHERE entry.id=$1 AND entry.session_id=$2 AND entry.clinic_id=$3
            AND patient.id=entry.patient_id AND patient.clinic_id=entry.clinic_id
        RETURNING entry.id, entry.session_id, entry.state,
          entry.registration_order, entry.eligibility_order, entry.priority_order,
          entry.public_display_label, patient.private_display_name,
          patient.preferred_locale, patient.contact_phone, patient.contact_email`,
        [entryId, sessionId, scope.clinicId, target, eligibilityOrder],
      );
      await client.query(
        `UPDATE consultation_sessions
            SET queue_order_version=queue_order_version+1, updated_at=now()
          WHERE id=$1 AND clinic_id=$2`,
        [sessionId, scope.clinicId],
      );
      const row = updated.rows[0]!;
      const response: StaffQueueEntry = {
        id: row.id,
        sessionId: row.session_id,
        state: row.state,
        registrationOrder: Number(row.registration_order),
        eligibilityOrder:
          row.eligibility_order === null ? null : Number(row.eligibility_order),
        priorityOrder:
          row.priority_order === null ? null : Number(row.priority_order),
        publicDisplayLabel: row.public_display_label,
        privateDisplayName: row.private_display_name,
        preferredLocale: row.preferred_locale,
        hasContact: row.contact_phone !== null || row.contact_email !== null,
      };
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'queue_entry',
        entityId: entryId,
        action: `queue_entry.${command}`,
        metadata: {
          command,
          outcome: 'applied',
          sessionId,
          from: entry.state,
          to: response.state,
          reason,
          correlationId: rawInput.correlationId,
          idempotencyKey: rawInput.idempotencyKey,
        },
      });
      await client.query(
        `INSERT INTO queue_command_receipts
          (clinic_id,actor_user_id,idempotency_key,request_fingerprint,queue_entry_id,response)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          scope.clinicId,
          scope.actorUserId,
          rawInput.idempotencyKey,
          requestFingerprint,
          entryId,
          JSON.stringify(response),
        ],
      );
      return response;
    });
  }
}
