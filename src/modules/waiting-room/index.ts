import type { Pool } from 'pg';

export type PublicWaitingRoomState = 'waiting' | 'checked_in' | 'called';

export interface PublicWaitingRoomEntry {
  publicDisplayLabel: string;
  state: PublicWaitingRoomState;
  called: boolean;
}

export interface PublicWaitingRoomSnapshot {
  entries: PublicWaitingRoomEntry[];
}

export class WaitingRoomService {
  constructor(private readonly pool: Pool) {}

  async getPublicSnapshot(
    clinicId: string,
    sessionId: string,
  ): Promise<PublicWaitingRoomSnapshot> {
    const session = await this.pool.query(
      `SELECT 1
         FROM consultation_sessions
        WHERE id = $1 AND clinic_id = $2`,
      [sessionId, clinicId],
    );

    if (session.rowCount !== 1) {
      return { entries: [] };
    }

    const result = await this.pool.query<{
      public_display_label: string;
      state: PublicWaitingRoomState;
      priority_order: string | null;
      eligibility_order: string | null;
      registration_order: string;
    }>(
      `SELECT public_display_label,
              state,
              priority_order,
              eligibility_order,
              registration_order
         FROM queue_entries
        WHERE clinic_id = $1
          AND session_id = $2
          AND state IN ('waiting', 'checked_in', 'called')
        ORDER BY CASE state WHEN 'called' THEN 0 WHEN 'checked_in' THEN 1 ELSE 2 END,
                 CASE WHEN priority_order IS NULL THEN 1 ELSE 0 END,
                 priority_order NULLS LAST,
                 eligibility_order NULLS LAST,
                 registration_order`,
      [clinicId, sessionId],
    );

    return {
      entries: result.rows.map((row) => ({
        publicDisplayLabel: row.public_display_label,
        state: row.state,
        called: row.state === 'called',
      })),
    };
  }
}
