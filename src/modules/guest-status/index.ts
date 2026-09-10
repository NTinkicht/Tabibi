import type { Pool } from 'pg';
import {
  GuestAccessRejectedError,
  GuestAccessService,
  type GuestTarget,
} from '@/modules/guest-access';

export interface GuestQueueStatusSnapshot {
  generatedAt: string;
  target: GuestTarget;
  publicDisplayLabel: string;
  queueState: string;
  patientsAhead: number;
  session: {
    status: string;
    declaredDelayMinutes: number | null;
    delayVersion: number;
    queueOrderVersion: number;
  };
}

/** Read-only, credential-free guest projection for one authorized queue target. */
export class GuestStatusService {
  constructor(
    private readonly pool: Pool,
    private readonly guestAccess = new GuestAccessService(pool),
  ) {}

  async getSnapshot(
    bearer: string,
    now = new Date(),
  ): Promise<GuestQueueStatusSnapshot> {
    const target = await this.guestAccess.authorize(bearer, undefined, now);
    const result = await this.pool.query<{
      public_display_label: string;
      queue_state: string;
      service_position: string;
      session_status: string;
      declared_delay_minutes: number | null;
      delay_version: number;
      queue_order_version: string;
    }>(
      `WITH ordered AS (
         SELECT entry.id,
                entry.public_display_label,
                entry.state::text AS queue_state,
                row_number() OVER (
                  ORDER BY
                    CASE entry.state
                      WHEN 'in_consultation' THEN 0
                      WHEN 'called' THEN 0
                      WHEN 'checked_in' THEN 1
                      WHEN 'waiting' THEN 2
                      ELSE 3
                    END,
                    CASE WHEN entry.priority_order IS NULL THEN 1 ELSE 0 END,
                    entry.priority_order NULLS LAST,
                    entry.eligibility_order NULLS LAST,
                    entry.registration_order,
                    entry.id
                ) AS service_position
           FROM queue_entries entry
          WHERE entry.clinic_id=$1
            AND entry.session_id=$2
            AND entry.state IN ('waiting','checked_in','called','in_consultation')
       )
       SELECT ordered.public_display_label,
              ordered.queue_state,
              ordered.service_position,
              session.status::text AS session_status,
              session.declared_delay_minutes,
              session.delay_version,
              session.queue_order_version
         FROM ordered
         JOIN consultation_sessions session
           ON session.id=$2 AND session.clinic_id=$1
         JOIN guest_credentials credential
           ON credential.queue_entry_id=$3
          AND credential.session_id=$2
          AND credential.clinic_id=$1
          AND credential.revoked_at IS NULL
          AND credential.expires_at>$4
        WHERE ordered.id=$3
          AND session.status IN ('planned','open','paused')`,
      [target.clinicId, target.sessionId, target.queueEntryId, now],
    );
    const row = result.rows[0];
    if (!row) throw new GuestAccessRejectedError();

    return {
      generatedAt: now.toISOString(),
      target,
      publicDisplayLabel: row.public_display_label,
      queueState: row.queue_state,
      patientsAhead: Math.max(0, Number(row.service_position) - 1),
      session: {
        status: row.session_status,
        declaredDelayMinutes: row.declared_delay_minutes,
        delayVersion: row.delay_version,
        queueOrderVersion: Number(row.queue_order_version),
      },
    };
  }
}
