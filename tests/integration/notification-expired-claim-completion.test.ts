import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const clinicId = randomUUID();

beforeAll(migrate);

beforeEach(async () => {
  await pool.query('TRUNCATE notification_outbox, clinics CASCADE');
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name)
     VALUES ($1, 'expired-claim-completion', 'Expired Claim Completion')`,
    [clinicId],
  );
});

afterAll(async () => pool.end());

describe('notification dispatch completion lease fencing', () => {
  it('rejects an expired worker result before recovery runs', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const intent = await repository.enqueue({
      clinicId,
      logicalTargetKey: 'queue-entry:expired-worker',
      eventKey: 'turn_approaching',
      intentVersion: 1,
      idempotencyKey: 'expired-worker-result',
      payload: { locale: 'fr', places: 1 },
    });
    const dispatchClaim = await repository.claimPendingIntent({
      clinicId,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(dispatchClaim).not.toBeNull();

    await pool.query(
      `UPDATE notification_outbox
          SET dispatch_claimed_at=now() - interval '2 minutes',
              dispatch_claim_expires_at=now() - interval '1 minute'
        WHERE id=$1 AND clinic_id=$2`,
      [intent.id, clinicId],
    );

    await expect(
      repository.completeDispatchAttempt({
        clinicId,
        intentId: intent.id,
        claimToken: dispatchClaim!.claimToken,
        outcome: 'delivered',
      }),
    ).resolves.toBeNull();

    const afterLateResult = await pool.query<{
      state: string;
      dispatch_claim_token: string | null;
      dispatch_outcome_at: Date | null;
    }>(
      `SELECT state, dispatch_claim_token, dispatch_outcome_at
         FROM notification_outbox
        WHERE id=$1 AND clinic_id=$2`,
      [intent.id, clinicId],
    );
    expect(afterLateResult.rows[0]).toMatchObject({
      state: 'pending',
      dispatch_claim_token: dispatchClaim!.claimToken,
      dispatch_outcome_at: null,
    });

    await expect(
      repository.claimPendingIntent({
        clinicId,
        intentId: intent.id,
        leaseMs: 60_000,
      }),
    ).resolves.toBeNull();

    const recovered = await pool.query<{
      state: string;
      dispatch_claim_token: string | null;
      dispatch_outcome_code: string | null;
      next_attempt_at: Date | null;
    }>(
      `SELECT state, dispatch_claim_token, dispatch_outcome_code, next_attempt_at
         FROM notification_outbox
        WHERE id=$1 AND clinic_id=$2`,
      [intent.id, clinicId],
    );
    expect(recovered.rows[0]).toMatchObject({
      state: 'unknown',
      dispatch_claim_token: null,
      dispatch_outcome_code: 'claim_lease_expired',
    });
    expect(recovered.rows[0]?.next_attempt_at).not.toBeNull();
  });
});
