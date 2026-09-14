import type { Pool, PoolClient } from 'pg';
import {
  authenticatedGuestCredentialId,
  verifierMatches,
} from '@/modules/guest-access';
import { inTransaction } from '@/platform/database/transaction';

const CANCELLABLE_APPOINTMENT_STATES = ['booked', 'confirmed', 'checked_in'];
const CANCELLABLE_QUEUE_STATES = ['waiting', 'checked_in', 'called'];

export interface PublicGuestBookingCancellationResult {
  status: 'cancelled';
}

export class PublicGuestBookingCancellationRejectedError extends Error {
  constructor() {
    super('Guest booking cancellation request rejected');
    this.name = 'PublicGuestBookingCancellationRejectedError';
  }
}

type CancellationRow = {
  credential_id: string;
  bearer_verifier: string;
  clinic_id: string;
  session_id: string;
  queue_entry_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  appointment_id: string;
  appointment_status: string;
  queue_state: string;
  priority_order: string | null;
};

function bearerSecret(bearer: string): string | null {
  const parts = bearer.split('.');
  return parts.length === 3 && parts[1] ? parts[1] : null;
}

/**
 * Transactional public cancellation authorized exclusively by the existing
 * guest capability. No caller-supplied internal identifier participates in
 * authorization or mutation scope.
 */
export class PublicGuestBookingCancellationService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
    private readonly afterOperationalMutationForTest?: (
      client: PoolClient,
    ) => Promise<void>,
  ) {}

  async cancel(bearer: string): Promise<PublicGuestBookingCancellationResult> {
    const credentialId = authenticatedGuestCredentialId(bearer);
    const secret = bearerSecret(bearer);
    if (!credentialId || !secret)
      throw new PublicGuestBookingCancellationRejectedError();

    return inTransaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`public-guest-cancellation:${credentialId}`],
      );

      const result = await client.query<CancellationRow>(
        `SELECT credential.id AS credential_id,
                credential.bearer_verifier,
                credential.clinic_id,
                credential.session_id,
                credential.queue_entry_id,
                credential.expires_at,
                credential.revoked_at,
                appointment.id AS appointment_id,
                appointment.status::text AS appointment_status,
                entry.state::text AS queue_state,
                entry.priority_order::text AS priority_order
           FROM guest_credentials credential
           JOIN queue_entries entry
             ON entry.id = credential.queue_entry_id
            AND entry.clinic_id = credential.clinic_id
            AND entry.session_id = credential.session_id
           JOIN appointments appointment
             ON appointment.queue_entry_id = entry.id
            AND appointment.clinic_id = entry.clinic_id
            AND appointment.session_id = entry.session_id
            AND appointment.patient_id = entry.patient_id
          WHERE credential.id = $1
          FOR UPDATE OF credential, appointment, entry`,
        [credentialId],
      );

      const row = result.rows[0];
      if (
        !row ||
        !verifierMatches(row.bearer_verifier, secret) ||
        row.revoked_at ||
        row.expires_at <= this.clock()
      )
        throw new PublicGuestBookingCancellationRejectedError();

      if (
        row.appointment_status === 'cancelled' &&
        row.queue_state === 'cancelled'
      ) {
        return { status: 'cancelled' };
      }

      if (
        !CANCELLABLE_APPOINTMENT_STATES.includes(row.appointment_status) ||
        !CANCELLABLE_QUEUE_STATES.includes(row.queue_state)
      ) {
        throw new PublicGuestBookingCancellationRejectedError();
      }

      await client.query(
        `UPDATE appointments
            SET status = 'cancelled'::appointment_status,
                updated_at = now()
          WHERE id = $1 AND clinic_id = $2`,
        [row.appointment_id, row.clinic_id],
      );
      await client.query(
        `UPDATE queue_entries
            SET state = 'cancelled'::queue_entry_status,
                priority_order = NULL,
                updated_at = now()
          WHERE id = $1 AND session_id = $2 AND clinic_id = $3`,
        [row.queue_entry_id, row.session_id, row.clinic_id],
      );

      if (
        row.priority_order !== null &&
        ['waiting', 'checked_in'].includes(row.queue_state)
      ) {
        const cohort = await client.query<{ id: string }>(
          `SELECT id
             FROM queue_entries
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

      if (this.afterOperationalMutationForTest) {
        await this.afterOperationalMutationForTest(client);
      }

      await client.query(
        `INSERT INTO audit_events
           (clinic_id, actor_user_id, entity_type, entity_id, action, metadata)
         VALUES ($1, NULL, 'appointment', $2,
                 'public_guest_appointment_cancelled', $3::jsonb)`,
        [
          row.clinic_id,
          row.appointment_id,
          JSON.stringify({
            appointmentFrom: row.appointment_status,
            appointmentTo: 'cancelled',
            queueFrom: row.queue_state,
            queueTo: 'cancelled',
            authority: 'guest_capability',
          }),
        ],
      );

      return { status: 'cancelled' };
    });
  }
}
