import type { Pool } from 'pg';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface NotificationDeadLetterOperationalRecord {
  intentId: string;
  eventKey: string;
  queueEntryId: string | null;
  outcomeCode: string | null;
  attemptCount: number;
  maxAttempts: number;
  outcomeAt: string;
}

interface DeadLetterRow {
  id: string;
  event_key: string;
  queue_entry_id: string | null;
  dispatch_outcome_code: string | null;
  dispatch_attempt_count: number;
  dispatch_max_attempts: number;
  dispatch_outcome_at: Date;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT)
    throw new RangeError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  return limit;
}

/**
 * Privacy-minimal operational view over exhausted notification delivery.
 *
 * The query is tenant-scoped in PostgreSQL itself and deliberately excludes
 * payload, subject/contact identity, rendered content, credentials and claim
 * tokens. It is a backend observability primitive, not a patient-facing API.
 */
export class NotificationDeadLetterObservabilityRepository {
  constructor(private readonly pool: Pool) {}

  async listRecentForClinic(input: {
    clinicId: string;
    limit?: number;
  }): Promise<NotificationDeadLetterOperationalRecord[]> {
    const clinicId = input.clinicId.trim();
    if (!clinicId) throw new TypeError('clinicId is required');
    const limit = normalizeLimit(input.limit);

    const result = await this.pool.query<DeadLetterRow>(
      `SELECT id,
              event_key,
              queue_entry_id,
              dispatch_outcome_code,
              dispatch_attempt_count,
              dispatch_max_attempts,
              dispatch_outcome_at
         FROM notification_outbox
        WHERE clinic_id=$1
          AND state='dead_letter'
        ORDER BY dispatch_outcome_at DESC, id DESC
        LIMIT $2`,
      [clinicId, limit],
    );

    return result.rows.map((row) => ({
      intentId: row.id,
      eventKey: row.event_key,
      queueEntryId: row.queue_entry_id,
      outcomeCode: row.dispatch_outcome_code,
      attemptCount: row.dispatch_attempt_count,
      maxAttempts: row.dispatch_max_attempts,
      outcomeAt: row.dispatch_outcome_at.toISOString(),
    }));
  }
}
