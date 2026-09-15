import type { Pool, PoolClient } from 'pg';
import {
  authenticatedGuestCredentialId,
  verifierMatches,
} from '@/modules/guest-access';
import { inTransaction } from '@/platform/database/transaction';

export interface PublicGuestBookingCheckInResult {
  status: 'checked_in';
}

export class PublicGuestBookingCheckInRejectedError extends Error {
  constructor() {
    super('Guest booking check-in request rejected');
    this.name = 'PublicGuestBookingCheckInRejectedError';
  }
}

type CheckInIdentityRow = {
  clinic_id: string;
  session_id: string;
};

type CheckInRow = {
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
};

function bearerSecret(bearer: string): string | null {
  const parts = bearer.split('.');
  return parts.length === 3 && parts[1] ? parts[1] : null;
}

/**
 * Transactional public check-in authorized exclusively by the existing guest
 * capability. No caller-supplied internal identifier participates in scope.
 */
export class PublicGuestBookingCheckInService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
    private readonly afterOperationalMutationForTest?: (
      client: PoolClient,
    ) => Promise<void>,
  ) {}

  async checkIn(bearer: string): Promise<PublicGuestBookingCheckInResult> {
    const credentialId = authenticatedGuestCredentialId(bearer);
    const secret = bearerSecret(bearer);
    if (!credentialId || !secret)
      throw new PublicGuestBookingCheckInRejectedError();

    return inTransaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`public-guest-check-in:${credentialId}`],
      );

      const identity = await client.query<CheckInIdentityRow>(
        `SELECT clinic_id, session_id
           FROM guest_credentials
          WHERE id = $1`,
        [credentialId],
      );
      const target = identity.rows[0];
      if (!target) throw new PublicGuestBookingCheckInRejectedError();

      const session = await client.query<{ status: string }>(
        `SELECT status::text AS status
           FROM consultation_sessions
          WHERE id = $1 AND clinic_id = $2
          FOR UPDATE`,
        [target.session_id, target.clinic_id],
      );
      if (!session.rows[0]) throw new PublicGuestBookingCheckInRejectedError();

      const result = await client.query<CheckInRow>(
        `SELECT credential.id AS credential_id,
                credential.bearer_verifier,
                credential.clinic_id,
                credential.session_id,
                credential.queue_entry_id,
                credential.expires_at,
                credential.revoked_at,
                appointment.id AS appointment_id,
                appointment.status::text AS appointment_status,
                entry.state::text AS queue_state
           FROM guest_credentials credential
           JOIN public_guest_booking_receipts receipt
             ON receipt.credential_id = credential.id
            AND receipt.clinic_id = credential.clinic_id
            AND receipt.queue_entry_id = credential.queue_entry_id
            AND receipt.completed_at IS NOT NULL
           JOIN queue_entries entry
             ON entry.id = credential.queue_entry_id
            AND entry.clinic_id = credential.clinic_id
            AND entry.session_id = credential.session_id
           JOIN appointments appointment
             ON appointment.id = receipt.appointment_id
            AND appointment.queue_entry_id = receipt.queue_entry_id
            AND appointment.queue_entry_id = entry.id
            AND appointment.clinic_id = entry.clinic_id
            AND appointment.session_id = entry.session_id
            AND appointment.patient_id = entry.patient_id
            AND appointment.patient_id = receipt.patient_id
          WHERE credential.id = $1
            AND credential.clinic_id = $2
            AND credential.session_id = $3
          FOR UPDATE OF credential, appointment, entry`,
        [credentialId, target.clinic_id, target.session_id],
      );

      const row = result.rows[0];
      if (
        !row ||
        !verifierMatches(row.bearer_verifier, secret) ||
        row.revoked_at ||
        row.expires_at <= this.clock()
      )
        throw new PublicGuestBookingCheckInRejectedError();

      if (
        row.appointment_status === 'checked_in' &&
        row.queue_state === 'checked_in'
      ) {
        return { status: 'checked_in' };
      }

      if (!['open', 'paused'].includes(session.rows[0].status)) {
        throw new PublicGuestBookingCheckInRejectedError();
      }

      if (
        !['booked', 'confirmed'].includes(row.appointment_status) ||
        row.queue_state !== 'waiting'
      ) {
        throw new PublicGuestBookingCheckInRejectedError();
      }

      const nextEligibility = await client.query<{ value: string }>(
        `SELECT COALESCE(MAX(eligibility_order), 0) + 1 AS value
           FROM queue_entries
          WHERE session_id = $1 AND clinic_id = $2`,
        [row.session_id, row.clinic_id],
      );
      const eligibilityOrder = Number(nextEligibility.rows[0]!.value);

      await client.query(
        `UPDATE appointments
            SET status = 'checked_in'::appointment_status,
                updated_at = now()
          WHERE id = $1 AND clinic_id = $2`,
        [row.appointment_id, row.clinic_id],
      );
      await client.query(
        `UPDATE queue_entries
            SET state = 'checked_in'::queue_entry_status,
                eligibility_order = $4,
                updated_at = now()
          WHERE id = $1 AND session_id = $2 AND clinic_id = $3`,
        [row.queue_entry_id, row.session_id, row.clinic_id, eligibilityOrder],
      );
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
         VALUES ($1, NULL, 'appointment', $2,
                 'public_guest_appointment_checked_in', $3::jsonb)`,
        [
          row.clinic_id,
          row.appointment_id,
          JSON.stringify({
            appointmentFrom: row.appointment_status,
            appointmentTo: 'checked_in',
            queueFrom: row.queue_state,
            queueTo: 'checked_in',
            authority: 'guest_capability',
          }),
        ],
      );

      if (this.afterOperationalMutationForTest) {
        await this.afterOperationalMutationForTest(client);
      }

      return { status: 'checked_in' };
    });
  }
}
