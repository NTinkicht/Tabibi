import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '@/platform/database/transaction';

// TAB-P1-04 slice 4: a signed-in patient cancels an upcoming visit. Like guest
// cancellation this is an advance cancellation only: valid solely from the
// pre-arrival pair (appointment booked|confirmed, queue entry waiting). Once
// check-in commits, staff own the later exits (first-commit-wins).
const CANCELLABLE_APPOINTMENT_STATES = ['booked', 'confirmed'];

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PatientVisitNotFoundError extends Error {
  constructor() {
    super('Visit not found');
    this.name = 'PatientVisitNotFoundError';
  }
}

export class PatientVisitCancellationConflictError extends Error {
  constructor() {
    super('Visit can no longer be cancelled by the patient');
    this.name = 'PatientVisitCancellationConflictError';
  }
}

export interface PatientVisitCancellationResult {
  appointmentId: string;
  status: 'cancelled';
}

interface OwnedRow {
  appointment_id: string;
  clinic_id: string;
  session_id: string;
  queue_entry_id: string;
  appointment_status: string;
  queue_state: string;
  priority_order: string | null;
}

const OWNED_APPOINTMENT_SQL = `
  SELECT appt.id AS appointment_id, appt.clinic_id, appt.session_id,
         appt.queue_entry_id, appt.status::text AS appointment_status,
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

/**
 * Cancels one visit owned by the authenticated patient account. The owner
 * always comes from the verified session; unknown, foreign and archived-
 * dependent visits are indistinguishable (not found).
 */
export class PatientVisitCancellationService {
  constructor(
    private readonly pool: Pool,
    private readonly afterOperationalMutationForTest?: (
      client: PoolClient,
    ) => Promise<void>,
  ) {}

  async cancel(
    ownerUserId: string,
    appointmentId: string,
  ): Promise<PatientVisitCancellationResult> {
    if (!uuidPattern.test(ownerUserId) || !uuidPattern.test(appointmentId))
      throw new PatientVisitNotFoundError();
    const owner = ownerUserId.toLowerCase();
    const id = appointmentId.toLowerCase();

    return inTransaction(this.pool, async (client) => {
      const probe = await client.query<OwnedRow>(OWNED_APPOINTMENT_SQL, [
        id,
        owner,
      ]);
      const target = probe.rows[0];
      if (!target) throw new PatientVisitNotFoundError();

      await client.query(
        `SELECT id FROM consultation_sessions
          WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
        [target.session_id, target.clinic_id],
      );
      const locked = await client.query<OwnedRow>(
        `${OWNED_APPOINTMENT_SQL} FOR UPDATE OF appt, entry`,
        [id, owner],
      );
      const row = locked.rows[0];
      if (!row) throw new PatientVisitNotFoundError();

      if (
        row.appointment_status === 'cancelled' &&
        row.queue_state === 'cancelled'
      )
        return { appointmentId: id, status: 'cancelled' as const };

      if (
        !CANCELLABLE_APPOINTMENT_STATES.includes(row.appointment_status) ||
        row.queue_state !== 'waiting'
      )
        throw new PatientVisitCancellationConflictError();

      await client.query(
        `UPDATE appointments
            SET status = 'cancelled'::appointment_status, updated_at = now()
          WHERE id = $1 AND clinic_id = $2`,
        [row.appointment_id, row.clinic_id],
      );
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
        `UPDATE consultation_sessions
            SET queue_order_version = queue_order_version + 1,
                updated_at = now()
          WHERE id = $1 AND clinic_id = $2`,
        [row.session_id, row.clinic_id],
      );

      await client.query(
        `INSERT INTO audit_events
           (clinic_id, actor_user_id, entity_type, entity_id, action, metadata)
         VALUES ($1, $2, 'appointment', $3,
                 'patient_appointment_cancelled', $4::jsonb)`,
        [
          row.clinic_id,
          owner,
          row.appointment_id,
          JSON.stringify({
            appointmentFrom: row.appointment_status,
            appointmentTo: 'cancelled',
            queueFrom: row.queue_state,
            queueTo: 'cancelled',
            authority: 'patient_account',
          }),
        ],
      );

      if (this.afterOperationalMutationForTest)
        await this.afterOperationalMutationForTest(client);

      return { appointmentId: id, status: 'cancelled' as const };
    });
  }
}
