import type { Pool } from 'pg';
import { NotificationOutboxValidationError } from '@/modules/notification-outbox';

export const MAX_NOTIFICATION_DISPATCH_BATCH_SIZE = 100;

export interface NotificationDispatchEligibleIntent {
  intentId: string;
  eligibleAt: string;
}

export interface ListNotificationDispatchEligibleInput {
  clinicId: string;
  limit: number;
}

interface EligibleIntentRow {
  id: string;
  eligible_at: Date;
}

function normalizeEligibilityInput(
  input: ListNotificationDispatchEligibleInput,
) {
  const clinicId = input.clinicId.trim();
  if (!clinicId)
    throw new NotificationOutboxValidationError('Clinic id is required');
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > MAX_NOTIFICATION_DISPATCH_BATCH_SIZE
  )
    throw new NotificationOutboxValidationError(
      `Dispatch batch size must be between 1 and ${MAX_NOTIFICATION_DISPATCH_BATCH_SIZE}`,
    );
  return { clinicId, limit: input.limit };
}

/** Read-only, clinic-scoped discovery of intents that may be offered to the claim fence. */
export class NotificationDispatchEligibilityRepository {
  constructor(private readonly pool: Pool) {}

  async listEligible(
    rawInput: ListNotificationDispatchEligibleInput,
  ): Promise<NotificationDispatchEligibleIntent[]> {
    const input = normalizeEligibilityInput(rawInput);
    const result = await this.pool.query<EligibleIntentRow>(
      `SELECT id,
              CASE
                WHEN dispatch_claim_token IS NOT NULL
                 AND dispatch_claim_expires_at <= now()
                  THEN dispatch_claim_expires_at
                ELSE COALESCE(next_attempt_at, created_at)
              END AS eligible_at
         FROM notification_outbox
        WHERE clinic_id=$1
          AND state IN ('pending', 'failed', 'unknown')
          AND superseded_by_id IS NULL
          AND dispatch_attempt_count < dispatch_max_attempts
          AND (
            state = 'pending'
            OR next_attempt_at <= now()
            OR (
              dispatch_claim_token IS NOT NULL
              AND dispatch_claim_expires_at <= now()
            )
          )
          AND (
            dispatch_claim_token IS NULL
            OR dispatch_claim_expires_at <= now()
          )
        ORDER BY eligible_at ASC,
                 created_at ASC,
                 id ASC
        LIMIT $2`,
      [input.clinicId, input.limit],
    );

    return result.rows.map((row) => ({
      intentId: row.id,
      eligibleAt: row.eligible_at.toISOString(),
    }));
  }
}
