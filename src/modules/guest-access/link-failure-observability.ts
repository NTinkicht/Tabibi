import type { Pool } from 'pg';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface GuestLinkFailureOperationalRecord {
  intentId: string;
  intent: string;
  state: 'dead_letter' | 'expired';
  queueLabel: string | null;
  attempts: number;
  outcomeAt: string;
}

interface FailureRow {
  id: string;
  intent: string;
  state: 'dead_letter' | 'expired';
  queue_label: string | null;
  attempts: number;
  scrubbed_at: Date;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT)
    throw new RangeError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  return limit;
}

/**
 * TAB-P0-13 staff escalation (#753): privacy-minimal, read-only view of
 * guest-link deliveries that ended in `dead_letter` or `expired`, so the desk
 * can re-issue a status link for a guest who never received one.
 *
 * Tenant-scoped in PostgreSQL itself. It returns identifiers and counters
 * only: never the (already scrubbed) envelope ciphertext, claim token,
 * exchange identifier, contact destination or any payload. `queue_label` is
 * the receptionist-facing public display label, never the raw queue entry id.
 */
export class GuestLinkFailureObservabilityRepository {
  constructor(private readonly pool: Pool) {}

  async listRecentForClinic(input: {
    clinicId: string;
    limit?: number;
  }): Promise<GuestLinkFailureOperationalRecord[]> {
    const clinicId = input.clinicId.trim();
    if (!clinicId) throw new TypeError('clinicId is required');
    const limit = normalizeLimit(input.limit);

    const result = await this.pool.query<FailureRow>(
      `SELECT intent.id,
              intent.intent,
              intent.state,
              entry.public_display_label AS queue_label,
              intent.attempts,
              intent.scrubbed_at
         FROM guest_link_intents intent
         LEFT JOIN queue_entries entry
           ON entry.id = intent.queue_entry_id
          AND entry.clinic_id = intent.clinic_id
        WHERE intent.clinic_id=$1
          AND intent.state IN ('dead_letter', 'expired')
        ORDER BY intent.scrubbed_at DESC, intent.id DESC
        LIMIT $2`,
      [clinicId, limit],
    );

    return result.rows.map((row) => ({
      intentId: row.id,
      intent: row.intent,
      state: row.state,
      queueLabel: row.queue_label,
      attempts: row.attempts,
      outcomeAt: row.scrubbed_at.toISOString(),
    }));
  }
}
