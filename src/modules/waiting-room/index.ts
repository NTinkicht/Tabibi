import type { Pool } from 'pg';

export type PublicWaitingRoomState = 'waiting' | 'checked_in' | 'called';

export interface PublicWaitingRoomEntry {
  publicDisplayLabel: string;
  state: PublicWaitingRoomState;
  called: boolean;
}

export interface PublicWaitingRoomSession {
  pauseStatus: 'active' | 'paused';
  declaredDelayMinutes: number;
}

export interface PublicWaitingRoomSnapshot {
  session: PublicWaitingRoomSession;
  generatedAt: string;
  entries: PublicWaitingRoomEntry[];
}

export class WaitingRoomService {
  constructor(private readonly pool: Pool) {}

  async getPublicSnapshot(
    clinicId: string,
    sessionId: string,
  ): Promise<PublicWaitingRoomSnapshot> {
    const generatedAt = new Date();
    // Unknown or cross-clinic sessions fall back to the neutral values so the
    // public endpoint never reveals whether a session exists.
    const sessionResult = await this.pool.query<{
      status: string;
      declared_delay_minutes: number | null;
    }>(
      `SELECT status::text AS status,
              declared_delay_minutes
         FROM consultation_sessions
        WHERE id = $2
          AND clinic_id = $1`,
      [clinicId, sessionId],
    );
    const sessionRow = sessionResult.rows[0];
    const result = await this.pool.query<{
      public_display_label: string;
      state: PublicWaitingRoomState;
    }>(
      `SELECT public_display_label,
             state
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
      session: {
        pauseStatus: sessionRow?.status === 'paused' ? 'paused' : 'active',
        declaredDelayMinutes: Math.max(
          0,
          sessionRow?.declared_delay_minutes ?? 0,
        ),
      },
      generatedAt: generatedAt.toISOString(),
      entries: result.rows.map((row) => ({
        publicDisplayLabel: row.public_display_label,
        state: row.state,
        called: row.state === 'called',
      })),
    };
  }
}
