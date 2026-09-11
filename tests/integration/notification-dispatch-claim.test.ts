import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const clinicA = randomUUID();
const clinicB = randomUUID();

beforeAll(migrate);

beforeEach(async () => {
  await pool.query('TRUNCATE notification_outbox, clinics CASCADE');
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
      ($1, 'claim-clinic-a', 'Claim Clinic A'),
      ($2, 'claim-clinic-b', 'Claim Clinic B')`,
    [clinicA, clinicB],
  );
});

afterAll(async () => pool.end());

function input(
  clinicId: string,
  intentVersion: number,
  idempotencyKey: string,
) {
  return {
    clinicId,
    logicalTargetKey: 'queue-entry:claim-example',
    eventKey: 'estimate_changed_materially',
    intentVersion,
    idempotencyKey,
    payload: { locale: 'en', minutes: 15 },
  };
}

describe('notification dispatch claim lifecycle', () => {
  it('allows at most one concurrent claimant to win for one pending intent', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const intent = await repository.enqueue(input(clinicA, 1, 'claim-once'));

    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.claimPendingIntent({
          clinicId: clinicA,
          intentId: intent.id,
          leaseMs: 60_000,
        }),
      ),
    );

    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.intent.id).toBe(intent.id);
    expect(winners[0]?.claimToken).toEqual(expect.any(String));
  });

  it('recovers an expired stale claim through unknown backoff before issuing a new token', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const intent = await repository.enqueue(input(clinicA, 1, 'stale-claim'));
    const first = await repository.claimPendingIntent({
      clinicId: clinicA,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(first).not.toBeNull();

    await pool.query(
      `UPDATE notification_outbox
          SET dispatch_claimed_at=now() - interval '2 minutes',
              dispatch_claim_expires_at=now() - interval '1 minute'
        WHERE id=$1 AND clinic_id=$2`,
      [intent.id, clinicA],
    );

    await expect(
      repository.claimPendingIntent({
        clinicId: clinicA,
        intentId: intent.id,
        leaseMs: 60_000,
      }),
    ).resolves.toBeNull();

    const recoveredState = await pool.query<{
      state: string;
      dispatch_attempt_count: number;
      dispatch_claim_token: string | null;
      next_attempt_at: Date | null;
    }>(
      `SELECT state, dispatch_attempt_count, dispatch_claim_token, next_attempt_at
         FROM notification_outbox
        WHERE id=$1 AND clinic_id=$2`,
      [intent.id, clinicA],
    );
    expect(recoveredState.rows[0]).toMatchObject({
      state: 'unknown',
      dispatch_attempt_count: 1,
      dispatch_claim_token: null,
    });
    expect(recoveredState.rows[0]?.next_attempt_at).not.toBeNull();

    await pool.query(
      `UPDATE notification_outbox
          SET next_attempt_at=now() - interval '1 millisecond'
        WHERE id=$1 AND clinic_id=$2`,
      [intent.id, clinicA],
    );
    const recovered = await repository.claimPendingIntent({
      clinicId: clinicA,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(recovered).not.toBeNull();
    expect(recovered?.claimToken).not.toBe(first?.claimToken);
    expect(recovered?.intent.dispatchAttemptCount).toBe(2);
    expect(new Date(recovered!.expiresAt).getTime()).toBeGreaterThan(
      new Date(recovered!.claimedAt).getTime(),
    );
  });

  it('keeps claim and release operations clinic-scoped and token-qualified', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const intent = await repository.enqueue(input(clinicA, 1, 'clinic-scope'));

    await expect(
      repository.claimPendingIntent({
        clinicId: clinicB,
        intentId: intent.id,
        leaseMs: 60_000,
      }),
    ).resolves.toBeNull();

    const claim = await repository.claimPendingIntent({
      clinicId: clinicA,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(claim).not.toBeNull();

    await expect(
      repository.releaseDispatchClaim(clinicB, intent.id, claim!.claimToken),
    ).resolves.toBe(false);
    await expect(
      repository.releaseDispatchClaim(clinicA, intent.id, randomUUID()),
    ).resolves.toBe(false);
    await expect(
      repository.releaseDispatchClaim(clinicA, intent.id, claim!.claimToken),
    ).resolves.toBe(true);

    const reclaimed = await repository.claimPendingIntent({
      clinicId: clinicA,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.claimToken).not.toBe(claim?.claimToken);
  });

  it('prevents superseded intents from being claimed and clears an active claim on supersession', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const first = await repository.enqueue(input(clinicA, 1, 'supersede-v1'));
    const firstClaim = await repository.claimPendingIntent({
      clinicId: clinicA,
      intentId: first.id,
      leaseMs: 60_000,
    });
    expect(firstClaim).not.toBeNull();

    const second = await repository.enqueue(input(clinicA, 2, 'supersede-v2'));

    await expect(
      repository.claimPendingIntent({
        clinicId: clinicA,
        intentId: first.id,
        leaseMs: 60_000,
      }),
    ).resolves.toBeNull();

    const persistedFirst = await pool.query<{
      state: string;
      dispatch_claim_token: string | null;
      dispatch_claimed_at: Date | null;
      dispatch_claim_expires_at: Date | null;
    }>(
      `SELECT state, dispatch_claim_token, dispatch_claimed_at, dispatch_claim_expires_at
         FROM notification_outbox
        WHERE id=$1 AND clinic_id=$2`,
      [first.id, clinicA],
    );
    expect(persistedFirst.rows[0]).toEqual({
      state: 'superseded',
      dispatch_claim_token: null,
      dispatch_claimed_at: null,
      dispatch_claim_expires_at: null,
    });

    await expect(
      repository.claimPendingIntent({
        clinicId: clinicA,
        intentId: second.id,
        leaseMs: 60_000,
      }),
    ).resolves.toMatchObject({ intent: { id: second.id, state: 'pending' } });
  });
});
