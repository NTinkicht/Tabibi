import type { Pool } from 'pg';
import { GuestAccessRejectedError, GuestAccessService } from '@/modules/guest-access';

export type GuestQueueState =
  | 'waiting'
  | 'checked_in'
  | 'called'
  | 'in_consultation';

export interface GuestStatusSnapshot {
  clinicId: string;
  sessionId: string;
  queueEntryId: string;
  publicDisplayLabel: string;
  state: GuestQueueState;
  sessionStatus: 'planned' | 'open' | 'paused';
  queueOrderVersion: number;
  declaredDelayMinutes: number | null;
  delayVersion: number;
}

/** Read-only guest status projection. Authorization remains owned by GuestAccessService. */
export class GuestStatusService {
  constructor(private readonly pool: Pool) {}

  async read(
    bearer: string,
    now = new Date(),
  ): Promise<GuestStatusSnapshot> {
    const target = await new GuestAccessService(this.pool).authorize(
      bearer,
      undefined,
      now,
    );

    const result = await this.pool.query<{
      public_display_label: string;
      state: GuestQueueState;
      session_status: 'planned' | 'open' | 'paused';
      queue_order_version: string;
      declared_delay_minutes: number | null;
      delay_version: string;
    }>(
      `SELECT entry.public_display_label,
              entry.state,
              session.status AS session_status,
              session.queue_order_version,
              session.declared_delay_minutes,
              session.delay_version
         FROM queue_entries entry
         JOIN consultation_sessions session
           ON session.id=entry.session_id
          AND session.clinic_id=entry.clinic_id
        WHERE entry.id=$1
          AND entry.session_id=$2
          AND entry.clinic_id=$3`,
      [target.queueEntryId, target.sessionId, target.clinicId],
    );

    const row = result.rows[0];
    if (!row) throw new GuestAccessRejectedError();

    return {
      clinicId: target.clinicId,
      sessionId: target.sessionId,
      queueEntryId: target.queueEntryId,
      publicDisplayLabel: row.public_display_label,
      state: row.state,
      sessionStatus: row.session_status,
      queueOrderVersion: Number(row.queue_order_version),
      declaredDelayMinutes: row.declared_delay_minutes,
      delayVersion: Number(row.delay_version),
    };
  }
}
