import type { Pool } from 'pg';
import {
  authenticatedGuestCredentialId,
  verifierMatches,
} from '@/modules/guest-access';
import { abortableQuery } from '@/platform/database/abortable-query';

export interface PublicGuestLiveQueueStatusResult {
  bookingState: string;
  queueState: string;
}

export class PublicGuestLiveQueueStatusRejectedError extends Error {
  constructor() {
    super('Guest live queue status request rejected');
    this.name = 'PublicGuestLiveQueueStatusRejectedError';
  }
}

type StatusRow = {
  bearer_verifier: string;
  expires_at: Date;
  revoked_at: Date | null;
  appointment_status: string;
  queue_state: string;
};

function bearerSecret(bearer: string): string | null {
  const parts = bearer.split('.');
  return parts.length === 3 && parts[1] ? parts[1] : null;
}

/**
 * Read-only public live queue status authorized exclusively by the existing
 * guest capability and bound to the immutable completed booking receipt.
 * No caller-supplied internal identifier participates in authorization or
 * scope. This performs a single plain SELECT (no lock, no transaction, no
 * mutation, no audit event), so repeated and concurrent reads are inherently
 * side-effect free.
 */
export class PublicGuestLiveQueueStatusService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async get(
    bearer: string,
    signal?: AbortSignal,
  ): Promise<PublicGuestLiveQueueStatusResult> {
    const credentialId = authenticatedGuestCredentialId(bearer);
    const secret = bearerSecret(bearer);
    if (!credentialId || !secret)
      throw new PublicGuestLiveQueueStatusRejectedError();

    const result = await abortableQuery<StatusRow>(
      this.pool,
      `SELECT credential.bearer_verifier,
              credential.expires_at,
              credential.revoked_at,
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
        WHERE credential.id = $1`,
      [credentialId],
      signal,
    );

    const row = result.rows[0];
    if (
      !row ||
      !verifierMatches(row.bearer_verifier, secret) ||
      row.revoked_at ||
      row.expires_at <= this.clock()
    )
      throw new PublicGuestLiveQueueStatusRejectedError();

    return {
      bookingState: row.appointment_status,
      queueState: row.queue_state,
    };
  }
}
