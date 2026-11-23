import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  AccountDependentNotFoundError,
  lockActiveAccountDependentForOperation,
} from '@/modules/account-dependent';
import { inTransaction } from '@/platform/database/transaction';
import { PatientVisitNotFoundError } from './cancellation';

// TAB-P1-04 slice 6: a signed-in patient moves an upcoming visit to another
// planned future session of the same clinic and doctor. Advance change only:
// valid from the pre-arrival pair (appointment booked|confirmed, queue entry
// waiting), mirroring cancellation. The old queue entry is cancelled and a new
// waiting entry takes the target tail, so registration order is never reused.
const MOVABLE_APPOINTMENT_STATES = ['booked', 'confirmed'];

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PatientVisitRescheduleConflictError extends Error {
  constructor() {
    super('Visit can no longer be rescheduled by the patient');
    this.name = 'PatientVisitRescheduleConflictError';
  }
}

export class PatientVisitRescheduleTargetError extends Error {
  constructor() {
    super('Target session is not available for rescheduling');
    this.name = 'PatientVisitRescheduleTargetError';
  }
}

export interface PatientVisitRescheduleResult {
  appointmentId: string;
  status: 'booked' | 'confirmed';
  scheduledStartAt: string;
  scheduledEndAt: string;
}

interface OwnedRow {
  appointment_id: string;
  clinic_id: string;
  doctor_id: string;
  patient_id: string;
  dependent_id: string | null;
  session_id: string;
  queue_entry_id: string;
  appointment_status: string;
  queue_state: string;
  priority_order: string | null;
}

const OWNED_APPOINTMENT_SQL = `
  SELECT appt.id AS appointment_id, appt.clinic_id, appt.doctor_id,
         appt.patient_id, appt.dependent_id, appt.session_id, appt.queue_entry_id,
         appt.status::text AS appointment_status,
         entry.state::text AS queue_state,
         entry.priority_order::text AS priority_order
    FROM appointments appt
    JOIN patient_operational_records patient
      ON patient.id = appt.patient_id AND patient.clinic_id = appt.clinic_id
    JOIN queue_entries entry
      ON entry.id = appt.queue_entry_id AND entry.clinic_id = appt.clinic_id
     AND entry.session_id = appt.session_id
    LEFT JOIN patient_dependents dependent
      ON dependent.id = appt.dependent_id
   WHERE appt.id = $1
     AND (
       (appt.dependent_id IS NULL AND patient.account_user_id = $2)
       OR (dependent.owner_user_id = $2 AND dependent.status = 'active')
     )`;

export class PatientVisitRescheduleService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
    private readonly afterProbeForTest?: () => Promise<void>,
  ) {}

  async reschedule(
    ownerUserId: string,
    appointmentId: string,
    targetSessionId: string,
  ): Promise<PatientVisitRescheduleResult> {
    if (!uuidPattern.test(ownerUserId) || !uuidPattern.test(appointmentId))
      throw new PatientVisitNotFoundError();
    if (!uuidPattern.test(targetSessionId))
      throw new PatientVisitRescheduleTargetError();
    const owner = ownerUserId.toLowerCase();
    const id = appointmentId.toLowerCase();
    const targetId = targetSessionId.toLowerCase();

    return inTransaction(this.pool, async (client) => {
      const probe = await client.query<OwnedRow>(OWNED_APPOINTMENT_SQL, [
        id,
        owner,
      ]);
      const target = probe.rows[0];
      if (!target) throw new PatientVisitNotFoundError();
      if (this.afterProbeForTest) await this.afterProbeForTest();

      // Lock both sessions in id order so concurrent moves cannot deadlock.
      for (const lockId of [target.session_id, targetId].sort()) {
        await client.query(
          `SELECT id FROM consultation_sessions
            WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
          [lockId, target.clinic_id],
        );
      }
      const locked = await client.query<OwnedRow>(
        `${OWNED_APPOINTMENT_SQL} FOR UPDATE OF appt, entry`,
        [id, owner],
      );
      const row = locked.rows[0];
      if (!row) throw new PatientVisitNotFoundError();
      // Hold the active owner-bound dependent row until commit so a concurrent
      // archive cannot slip between authorization and the new queue entry.
      if (row.dependent_id !== null) {
        try {
          await lockActiveAccountDependentForOperation(
            client,
            { ownerUserId: owner },
            row.dependent_id,
          );
        } catch (error) {
          if (error instanceof AccountDependentNotFoundError)
            throw new PatientVisitNotFoundError();
          throw error;
        }
      }
      if (row.session_id === targetId) {
        // Idempotent retry: already moved to the requested session.
        if (
          MOVABLE_APPOINTMENT_STATES.includes(row.appointment_status) &&
          row.queue_state === 'waiting'
        )
          return this.result(client, row);
        throw new PatientVisitRescheduleConflictError();
      }
      if (row.session_id !== target.session_id)
        throw new PatientVisitRescheduleConflictError();
      if (
        !MOVABLE_APPOINTMENT_STATES.includes(row.appointment_status) ||
        row.queue_state !== 'waiting'
      )
        throw new PatientVisitRescheduleConflictError();

      const session = await client.query<{
        starts_at: Date;
        ends_at: Date;
      }>(
        `SELECT session.starts_at, session.ends_at
           FROM consultation_sessions session
           JOIN clinics clinic
             ON clinic.id = session.clinic_id AND clinic.status = 'active'
           JOIN doctor_clinics association
             ON association.clinic_id = session.clinic_id
            AND association.doctor_id = session.doctor_id
          WHERE session.id = $1 AND session.clinic_id = $2
            AND session.doctor_id = $3 AND session.status = 'planned'
            AND session.starts_at > $4`,
        [targetId, row.clinic_id, row.doctor_id, this.clock()],
      );
      const targetSession = session.rows[0];
      if (!targetSession) throw new PatientVisitRescheduleTargetError();

      const duplicate = await client.query(
        `SELECT 1 FROM appointments
          WHERE clinic_id = $1 AND session_id = $2 AND patient_id = $3
            AND id <> $4 FOR UPDATE`,
        [row.clinic_id, targetId, row.patient_id, row.appointment_id],
      );
      if (duplicate.rows[0]) throw new PatientVisitRescheduleTargetError();

      const order = await client.query<{ next_order: string }>(
        `SELECT COALESCE(MAX(registration_order), 0) + 1 AS next_order
           FROM queue_entries WHERE session_id = $1 AND clinic_id = $2`,
        [targetId, row.clinic_id],
      );
      const newEntryId = randomUUID();

      await client.query(
        `UPDATE queue_entries
            SET state = 'cancelled'::queue_entry_status,
                priority_order = NULL, updated_at = now()
          WHERE id = $1 AND session_id = $2 AND clinic_id = $3`,
        [row.queue_entry_id, row.session_id, row.clinic_id],
      );
      if (row.priority_order !== null) {
        const cohort = await client.query<{ id: string }>(
          `SELECT id FROM queue_entries
            WHERE session_id = $1 AND clinic_id = $2
              AND state IN ('waiting','checked_in')
              AND priority_order IS NOT NULL
            ORDER BY priority_order, registration_order
            FOR UPDATE`,
          [row.session_id, row.clinic_id],
        );
        const ids = cohort.rows.map((entry) => entry.id);
        if (ids.length) {
          await client.query(
            'UPDATE queue_entries SET priority_order = NULL WHERE id = ANY($1::uuid[])',
            [ids],
          );
          for (let index = 0; index < ids.length; index += 1) {
            await client.query(
              'UPDATE queue_entries SET priority_order = $2, updated_at = now() WHERE id = $1',
              [ids[index], index + 1],
            );
          }
        }
      }
      await client.query(
        `INSERT INTO queue_entries
           (id, clinic_id, session_id, patient_id, state, source,
            registration_order, eligibility_order, priority_order)
         VALUES ($1, $2, $3, $4, 'waiting', 'appointment', $5, NULL, NULL)`,
        [
          newEntryId,
          row.clinic_id,
          targetId,
          row.patient_id,
          Number(order.rows[0]!.next_order),
        ],
      );
      // Cancelling the source entry cascades to the appointment, so the
      // original pre-arrival status is restored explicitly with the new link.
      await client.query(
        `UPDATE appointments
            SET session_id = $3, queue_entry_id = $4,
                scheduled_start_at = $5, scheduled_end_at = $6,
                status = $7::appointment_status, updated_at = now()
          WHERE id = $1 AND clinic_id = $2`,
        [
          row.appointment_id,
          row.clinic_id,
          targetId,
          newEntryId,
          targetSession.starts_at,
          targetSession.ends_at,
          row.appointment_status,
        ],
      );
      await client.query(
        `UPDATE consultation_sessions
            SET queue_order_version = queue_order_version + 1,
                updated_at = now()
          WHERE clinic_id = $1 AND id = ANY($2::uuid[])`,
        [row.clinic_id, [row.session_id, targetId]],
      );
      await client.query(
        `INSERT INTO audit_events
           (clinic_id, actor_user_id, entity_type, entity_id, action, metadata)
         VALUES ($1, $2, 'appointment', $3,
                 'patient_appointment_rescheduled', $4::jsonb)`,
        [
          row.clinic_id,
          owner,
          row.appointment_id,
          JSON.stringify({
            sourceSessionId: row.session_id,
            sourceQueueEntryId: row.queue_entry_id,
            targetSessionId: targetId,
            targetQueueEntryId: newEntryId,
            appointmentStatus: row.appointment_status,
            authority: 'patient_account',
          }),
        ],
      );

      return this.result(client, { ...row, session_id: targetId });
    });
  }

  private async result(
    client: PoolClient,
    row: OwnedRow,
  ): Promise<PatientVisitRescheduleResult> {
    const loaded = await client.query<{
      status: 'booked' | 'confirmed';
      scheduled_start_at: Date;
      scheduled_end_at: Date;
    }>(
      `SELECT status::text AS status, scheduled_start_at, scheduled_end_at
         FROM appointments WHERE id = $1 AND clinic_id = $2`,
      [row.appointment_id, row.clinic_id],
    );
    const appointment = loaded.rows[0]!;
    return {
      appointmentId: row.appointment_id,
      status: appointment.status,
      scheduledStartAt: appointment.scheduled_start_at.toISOString(),
      scheduledEndAt: appointment.scheduled_end_at.toISOString(),
    };
  }
}
