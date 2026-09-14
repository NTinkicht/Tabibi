import type { Pool } from 'pg';
import {
  GuestAccessRejectedError,
  GuestAccessService,
} from '@/modules/guest-access';
import { abortableQuery } from '@/platform/database/abortable-query';

export type PublicGuestBookingLifecycleState =
  | 'booked'
  | 'confirmed'
  | 'checked_in'
  | 'cancelled'
  | 'no_show'
  | 'completed';

export type PublicGuestQueueState =
  | 'waiting'
  | 'checked_in'
  | 'called'
  | 'in_consultation'
  | 'cancelled'
  | 'no_show'
  | 'completed';

export interface PublicGuestBookingStatusResult {
  bookingState: PublicGuestBookingLifecycleState;
  serviceDate: string;
  startsAt: string;
  endsAt: string;
  queueState: PublicGuestQueueState;
  queueLabel: string;
  called: boolean;
  preferredLocale: 'ar' | 'fr';
}

export class PublicGuestBookingStatusRejectedError extends Error {
  constructor() {
    super('Guest booking status request rejected');
    this.name = 'PublicGuestBookingStatusRejectedError';
  }
}

/**
 * Read-only public projection for a booking authorized exclusively by the
 * existing guest capability. No caller-supplied clinic, appointment, session,
 * queue, patient, or doctor identifier participates in authorization.
 */
export class PublicGuestBookingStatusService {
  private readonly guestAccess: GuestAccessService;

  constructor(
    private readonly pool: Pool,
    guestAccess?: GuestAccessService,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.guestAccess = guestAccess ?? new GuestAccessService(pool);
  }

  async get(
    bearer: string,
    signal?: AbortSignal,
  ): Promise<PublicGuestBookingStatusResult> {
    let target;
    try {
      target = await this.guestAccess.authorizeForStatusRead(
        bearer,
        this.clock(),
        signal,
      );
    } catch (error) {
      if (error instanceof GuestAccessRejectedError) {
        throw new PublicGuestBookingStatusRejectedError();
      }
      throw error;
    }

    const result = await abortableQuery<{
      appointment_status: PublicGuestBookingLifecycleState;
      service_date: string;
      scheduled_start_at: Date;
      scheduled_end_at: Date;
      queue_state: PublicGuestQueueState;
      public_display_label: string;
      preferred_locale: 'ar' | 'fr';
    }>(
      this.pool,
      `SELECT appointment.status AS appointment_status,
              session.service_date::text AS service_date,
              appointment.scheduled_start_at,
              appointment.scheduled_end_at,
              entry.state AS queue_state,
              entry.public_display_label,
              appointment.preferred_locale
         FROM queue_entries entry
         JOIN consultation_sessions session
           ON session.id = entry.session_id
          AND session.clinic_id = entry.clinic_id
         JOIN appointments appointment
           ON appointment.queue_entry_id = entry.id
          AND appointment.session_id = entry.session_id
          AND appointment.clinic_id = entry.clinic_id
          AND appointment.patient_id = entry.patient_id
        WHERE entry.id = $1
          AND entry.session_id = $2
          AND entry.clinic_id = $3`,
      [target.queueEntryId, target.sessionId, target.clinicId],
      signal,
    );

    const row = result.rows[0];
    if (!row) throw new PublicGuestBookingStatusRejectedError();

    return {
      bookingState: row.appointment_status,
      serviceDate: row.service_date,
      startsAt: row.scheduled_start_at.toISOString(),
      endsAt: row.scheduled_end_at.toISOString(),
      queueState: row.queue_state,
      queueLabel: row.public_display_label,
      called: ['called', 'in_consultation'].includes(row.queue_state),
      preferredLocale: row.preferred_locale,
    };
  }
}
