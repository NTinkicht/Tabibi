import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import { GuestAccessService } from '@/modules/guest-access';
import type { GuestLinkEnvelope } from '@/modules/guest-access/link-envelope';
import { GuestLinkIntentStore } from '@/modules/guest-access/link-intents';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import {
  QueueConflictError,
  QueueValidationError,
  type StaffQueueEntry,
} from '@/modules/queue';
import type { QueueEntryState } from '@/modules/queue/lifecycle-contract';
import { inTransaction } from '@/platform/database/transaction';

/**
 * Staff transfer of a walk-in/guest entry to another session of the same
 * doctor (TAB-P0-07, #810 slice 2). The source entry is cancelled with a
 * `transfer` cause in the audit trail and a new walk-in entry is created at
 * the target: `waiting` stays `waiting`; `checked_in` and `called` become
 * `checked_in` at the target eligibility tail. A called status and live
 * priority never carry over. Consulting, terminal and appointment-backed
 * entries are refused (appointments transfer through appointment recovery).
 *
 * Guest access (TAB-P0-07 slice 3, #841): all source authority is revoked, and
 * when the source had live guest access and the patient has a contact, the
 * same transaction mints one fresh single-use target exchange ID plus its
 * AAD-bound `transfer` link intent (no target bearer until it is consumed).
 * A missing envelope configuration fails the whole transfer closed.
 */
export interface QueueTransferInput {
  targetSessionId: string;
  reason: string;
  idempotencyKey: string;
  correlationId: string;
}
export interface QueueTransferResult {
  source: StaffQueueEntry;
  target: StaffQueueEntry;
}

const TRANSFERABLE: readonly QueueEntryState[] = [
  'waiting',
  'checked_in',
  'called',
];

type EntryRow = {
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
};

function toStaffEntry(row: EntryRow): StaffQueueEntry {
  return {
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
}

const ENTRY_COLUMNS = `entry.id, entry.session_id, entry.state,
  entry.registration_order, entry.eligibility_order, entry.priority_order,
  entry.public_display_label, patient.private_display_name,
  patient.preferred_locale, patient.contact_phone, patient.contact_email`;

async function loadEntry(
  client: PoolClient,
  clinicId: string,
  entryId: string,
): Promise<StaffQueueEntry> {
  const result = await client.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS}
       FROM queue_entries entry
       JOIN patient_operational_records patient
         ON patient.id=entry.patient_id AND patient.clinic_id=entry.clinic_id
      WHERE entry.id=$1 AND entry.clinic_id=$2`,
    [entryId, clinicId],
  );
  return toStaffEntry(result.rows[0]!);
}

export class QueueTransferService {
  constructor(
    private readonly pool: Pool,
    private readonly linkEnvelope?: GuestLinkEnvelope,
  ) {}

  async transfer(
    scope: ClinicScope,
    sessionId: string,
    entryId: string,
    rawInput: QueueTransferInput,
  ): Promise<QueueTransferResult> {
    const reason = rawInput.reason.trim();
    if (!rawInput.idempotencyKey || rawInput.idempotencyKey.length > 128)
      throw new QueueValidationError('A valid idempotency key is required');
    if (!reason) throw new QueueValidationError('Transfer reason is required');
    if (reason.length > 500)
      throw new QueueValidationError(
        'Transfer reason must be at most 500 characters',
      );
    const targetSessionId = rawInput.targetSessionId;
    if (targetSessionId === sessionId)
      throw new QueueValidationError(
        'Target session must differ from the source session',
      );
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          sessionId,
          entryId,
          command: 'transfer',
          targetSessionId,
          reason,
        }),
      )
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
        response: QueueTransferResult;
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

      // Lock both sessions in id order so concurrent transfers cannot deadlock.
      const sessions = new Map<string, { doctor_id: string; status: string }>();
      for (const id of [sessionId, targetSessionId].sort()) {
        const result = await client.query<{
          doctor_id: string;
          status: string;
        }>(
          `SELECT doctor_id, status FROM consultation_sessions
            WHERE id=$1 AND clinic_id=$2 FOR UPDATE`,
          [id, scope.clinicId],
        );
        if (!result.rows[0])
          throw new QueueConflictError(
            'Consultation session was not found in this clinic',
          );
        sessions.set(id, result.rows[0]);
      }
      const source = sessions.get(sessionId)!;
      const target = sessions.get(targetSessionId)!;
      if (!['open', 'paused'].includes(source.status))
        throw new QueueConflictError(
          'Queue transfer requires an open or paused source session',
        );
      if (!['planned', 'open', 'paused'].includes(target.status))
        throw new QueueConflictError(
          'Target session is not accepting transferred entries',
        );
      if (target.doctor_id !== source.doctor_id)
        throw new QueueConflictError(
          'Target session doctor does not match the source session',
        );

      const current = await client.query<{
        state: QueueEntryState;
        source: string;
        patient_id: string;
        priority_order: string | null;
      }>(
        `SELECT state, source, patient_id, priority_order FROM queue_entries
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
          'Appointment-backed entries are transferred through the appointment recovery route',
        );
      if (!TRANSFERABLE.includes(entry.state))
        throw new QueueConflictError(
          `Cannot transfer queue entry in ${entry.state}`,
        );
      const duplicate = await client.query(
        `SELECT 1 FROM queue_entries
          WHERE clinic_id=$1 AND session_id=$2 AND patient_id=$3
            AND state IN ('waiting','checked_in','called','in_consultation')
          FOR UPDATE`,
        [scope.clinicId, targetSessionId, entry.patient_id],
      );
      if (duplicate.rows[0])
        throw new QueueConflictError(
          'Patient already has an active queue entry in the target session',
        );

      const targetState: QueueEntryState =
        entry.state === 'waiting' ? 'waiting' : 'checked_in';
      const orders = await client.query<{
        registration: string;
        eligibility: string;
      }>(
        `SELECT COALESCE(MAX(registration_order),0)+1 AS registration,
                COALESCE(MAX(eligibility_order),0)+1 AS eligibility
           FROM queue_entries WHERE session_id=$1 AND clinic_id=$2`,
        [targetSessionId, scope.clinicId],
      );
      const targetEntryId = randomUUID();

      await client.query(
        `UPDATE queue_entries
            SET state='cancelled', priority_order=NULL, updated_at=now()
          WHERE id=$1 AND clinic_id=$2`,
        [entryId, scope.clinicId],
      );
      if (entry.priority_order !== null)
        await this.compactPriority(client, scope.clinicId, sessionId);
      const hadGuestAccess = await client.query(
        `SELECT 1 WHERE EXISTS (
                SELECT 1 FROM guest_credentials
                 WHERE queue_entry_id=$1 AND clinic_id=$2
                   AND revoked_at IS NULL AND expires_at > now())
             OR EXISTS (
                SELECT 1 FROM guest_exchange_ids
                 WHERE queue_entry_id=$1 AND clinic_id=$2
                   AND consumed_at IS NULL AND expires_at > now())
             OR EXISTS (
                SELECT 1 FROM guest_link_intents
                 WHERE queue_entry_id=$1 AND clinic_id=$2 AND state='pending'
                   AND expires_at > now())`,
        [entryId, scope.clinicId],
      );
      // Fail closed on guest access: every source verifier, outstanding
      // exchange ID and pending link intent dies with the source entry, so a
      // later restore of the cancelled source cannot revive old authority.
      await client.query(
        `UPDATE guest_credentials SET revoked_at=now()
          WHERE queue_entry_id=$1 AND clinic_id=$2 AND revoked_at IS NULL`,
        [entryId, scope.clinicId],
      );
      await client.query(
        `UPDATE guest_exchange_ids SET consumed_at=now()
          WHERE queue_entry_id=$1 AND clinic_id=$2 AND consumed_at IS NULL`,
        [entryId, scope.clinicId],
      );
      await client.query(
        `UPDATE guest_link_intents
            SET state='expired', envelope_ciphertext=NULL, scrubbed_at=now()
          WHERE queue_entry_id=$1 AND clinic_id=$2 AND state='pending'`,
        [entryId, scope.clinicId],
      );
      await client.query(
        `INSERT INTO queue_entries
           (id, clinic_id, session_id, patient_id, state, source,
            registration_order, eligibility_order, priority_order)
         VALUES ($1,$2,$3,$4,$5::queue_entry_status,'walk_in',$6,$7,NULL)`,
        [
          targetEntryId,
          scope.clinicId,
          targetSessionId,
          entry.patient_id,
          targetState,
          Number(orders.rows[0]!.registration),
          targetState === 'checked_in'
            ? Number(orders.rows[0]!.eligibility)
            : null,
        ],
      );
      await client.query(
        `UPDATE consultation_sessions
            SET queue_order_version=queue_order_version+1, updated_at=now()
          WHERE clinic_id=$1 AND id=ANY($2::uuid[])`,
        [scope.clinicId, [sessionId, targetSessionId]],
      );
      if (hadGuestAccess.rows[0]) {
        const contact = await client.query(
          `SELECT 1 FROM patient_operational_records
            WHERE id=$1 AND clinic_id=$2
              AND (contact_phone IS NOT NULL OR contact_email IS NOT NULL)`,
          [entry.patient_id, scope.clinicId],
        );
        // Without a contact there is no delivery channel (staff cannot issue
        // one either), so the target simply carries no guest authority.
        if (contact.rows[0]) {
          if (!this.linkEnvelope)
            throw new Error('Guest link envelope is not configured');
          const issued = await new GuestAccessService(
            this.pool,
          ).issueInTransaction(
            client,
            {
              clinicId: scope.clinicId,
              sessionId: targetSessionId,
              queueEntryId: targetEntryId,
            },
            scope.actorUserId,
          );
          await new GuestLinkIntentStore(this.pool, this.linkEnvelope).create(
            {
              clinicId: scope.clinicId,
              queueEntryId: targetEntryId,
              intent: 'transfer',
              material: issued.exchangeId,
              exchangeExpiresAt: issued.expiresAt,
            },
            client,
          );
        }
      }

      const response: QueueTransferResult = {
        source: await loadEntry(client, scope.clinicId, entryId),
        target: await loadEntry(client, scope.clinicId, targetEntryId),
      };
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'queue_entry',
        entityId: entryId,
        action: 'queue_entry.transfer',
        metadata: {
          command: 'transfer',
          outcome: 'applied',
          sourceTerminalCause: 'transfer',
          sourceSessionId: sessionId,
          sourceQueueEntryId: entryId,
          targetSessionId,
          targetQueueEntryId: targetEntryId,
          from: entry.state,
          to: targetState,
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

  private async compactPriority(
    client: PoolClient,
    clinicId: string,
    sessionId: string,
  ) {
    const cohort = await client.query<{ id: string }>(
      `SELECT id FROM queue_entries
        WHERE session_id=$1 AND clinic_id=$2
          AND state IN ('waiting','checked_in')
          AND priority_order IS NOT NULL
        ORDER BY priority_order, registration_order
        FOR UPDATE`,
      [sessionId, clinicId],
    );
    const ids = cohort.rows.map((row) => row.id);
    if (!ids.length) return;
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
