import type { Pool } from 'pg';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface NotificationDeadLetterOperationalRecord {
  intentId: string;
  eventKey: string;
  queueLabel: string | null;
  outcomeCode: string | null;
  attemptCount: number;
  maxAttempts: number;
  outcomeAt: string;
}

interface DeadLetterRow {
  id: string;
  event_key: string;
  queue_label: string | null;
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
 * tokens. `queue_label` is the same privacy-safe, receptionist-facing code
 * (e.g. "G-042") already shown on the live queue board -- never a raw
 * `queue_entry_id` -- so a receptionist can correlate a failure to a real
 * booking at the desk without exposing an internal identifier. It is a
 * backend observability primitive, not a patient-facing API.
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
      `SELECT outbox.id,
              outbox.event_key,
              entry.public_display_label AS queue_label,
              outbox.dispatch_outcome_code,
              outbox.dispatch_attempt_count,
              outbox.dispatch_max_attempts,
              outbox.dispatch_outcome_at
         FROM notification_outbox outbox
         LEFT JOIN queue_entries entry
           ON entry.id = outbox.queue_entry_id
          AND entry.clinic_id = outbox.clinic_id
        WHERE outbox.clinic_id=$1
          AND outbox.state='dead_letter'
          AND NOT EXISTS (
            SELECT 1 FROM notification_dead_letter_handlings handled
             WHERE handled.intent_id = outbox.id
               AND handled.clinic_id = outbox.clinic_id)
        ORDER BY outbox.dispatch_outcome_at DESC, outbox.id DESC
        LIMIT $2`,
      [clinicId, limit],
    );

    return result.rows.map((row) => ({
      intentId: row.id,
      eventKey: row.event_key,
      queueLabel: row.queue_label,
      outcomeCode: row.dispatch_outcome_code,
      attemptCount: row.dispatch_attempt_count,
      maxAttempts: row.dispatch_max_attempts,
      outcomeAt: row.dispatch_outcome_at.toISOString(),
    }));
  }

  /**
   * Records that staff handled a dead-lettered notification. Idempotent: a
   * repeat returns the original handler time and never overwrites it. An intent
   * that is not a dead letter of this clinic (unknown, other tenant, still
   * pending or delivered) is not found.
   */
  async markHandled(input: {
    clinicId: string;
    intentId: string;
    actorUserId: string;
  }): Promise<{ intentId: string; handledAt: string }> {
    const result = await this.pool.query<{ handled_at: Date }>(
      `WITH target AS (
         SELECT id, clinic_id FROM notification_outbox
          WHERE id=$2 AND clinic_id=$1 AND state='dead_letter'
       ), inserted AS (
         INSERT INTO notification_dead_letter_handlings
           (intent_id, clinic_id, handled_by)
         SELECT id, clinic_id, $3 FROM target
         ON CONFLICT (intent_id) DO NOTHING
         RETURNING handled_at
       )
       SELECT handled_at FROM inserted
       UNION ALL
       SELECT handled.handled_at
         FROM notification_dead_letter_handlings handled
         JOIN target ON target.id = handled.intent_id
                    AND target.clinic_id = handled.clinic_id
       LIMIT 1`,
      [input.clinicId, input.intentId, input.actorUserId],
    );
    const row = result.rows[0];
    if (!row) throw new NotificationDeadLetterNotFoundError();
    return {
      intentId: input.intentId,
      handledAt: row.handled_at.toISOString(),
    };
  }
}

export class NotificationDeadLetterNotFoundError extends Error {
  constructor() {
    super('Dead-lettered notification not found');
    this.name = 'NotificationDeadLetterNotFoundError';
  }
}
