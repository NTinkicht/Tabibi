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
     VALUES ($1, 'retry-recovery-clinic', 'Retry Recovery Clinic')`,
    [clinicId],
  );
});
afterAll(async () => pool.end());

function input(version: number, key: string) {
  return {
    clinicId,
    logicalTargetKey: 'queue-entry:retry-recovery',
    eventKey: 'turn_approaching',
    intentVersion: version,
    idempotencyKey: key,
    payload: { locale: 'en', places: 2 },
  };
}

describe('notification retry recovery', () => {
  it('clears a scheduled retry deadline when a newer intent supersedes it', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const first = await repository.enqueue(input(1, 'scheduled-v1'));
    const claim = await repository.claimPendingIntent({
      clinicId,
      intentId: first.id,
      leaseMs: 60_000,
    });
    expect(claim).not.toBeNull();

    const failed = await repository.completeDispatchAttempt({
      clinicId,
      intentId: first.id,
      claimToken: claim!.claimToken,
      outcome: 'failed',
    });
    expect(failed?.nextAttemptAt).not.toBeNull();

    const second = await repository.enqueue(input(2, 'scheduled-v2'));
    expect(second.intentVersion).toBe(2);

    const persisted = await pool.query<{
      state: string;
      next_attempt_at: Date | null;
      superseded_by_id: string | null;
    }>(
      `SELECT state, next_attempt_at, superseded_by_id
         FROM notification_outbox
        WHERE id=$1`,
      [first.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      state: 'superseded',
      next_attempt_at: null,
      superseded_by_id: second.id,
    });
  });

  it('restores retry eligibility when a failed claim is explicitly released', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const intent = await repository.enqueue(input(1, 'released-retry'));
    const firstClaim = await repository.claimPendingIntent({
      clinicId,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(firstClaim).not.toBeNull();

    await repository.completeDispatchAttempt({
      clinicId,
      intentId: intent.id,
      claimToken: firstClaim!.claimToken,
      outcome: 'failed',
    });
    await pool.query(
      'UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1',
      [intent.id],
    );

    const retryClaim = await repository.claimPendingIntent({
      clinicId,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(retryClaim?.intent.dispatchAttemptCount).toBe(2);
    await expect(
      repository.releaseDispatchClaim(
        clinicId,
        intent.id,
        retryClaim!.claimToken,
      ),
    ).resolves.toBe(true);

    const released = await pool.query<{
      dispatch_attempt_count: number;
      next_attempt_at: Date | null;
      dispatch_claim_token: string | null;
    }>(
      `SELECT dispatch_attempt_count, next_attempt_at, dispatch_claim_token
         FROM notification_outbox
        WHERE id=$1`,
      [intent.id],
    );
    expect(released.rows[0]?.dispatch_attempt_count).toBe(1);
    expect(released.rows[0]?.next_attempt_at).not.toBeNull();
    expect(released.rows[0]?.dispatch_claim_token).toBeNull();

    const replacement = await repository.claimPendingIntent({
      clinicId,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(replacement?.intent.dispatchAttemptCount).toBe(2);
    expect(replacement?.claimToken).not.toBe(retryClaim?.claimToken);
  });

  it('recovers an expired non-final retry claim behind deterministic backoff', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const intent = await repository.enqueue(input(1, 'expired-retry'));
    const firstClaim = await repository.claimPendingIntent({
      clinicId,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(firstClaim).not.toBeNull();

    await repository.completeDispatchAttempt({
      clinicId,
      intentId: intent.id,
      claimToken: firstClaim!.claimToken,
      outcome: 'failed',
    });
    await pool.query(
      'UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1',
      [intent.id],
    );

    const abandoned = await repository.claimPendingIntent({
      clinicId,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(abandoned?.intent.dispatchAttemptCount).toBe(2);
    await pool.query(
      `UPDATE notification_outbox
          SET dispatch_claim_expires_at=now() - interval '1 millisecond'
        WHERE id=$1`,
      [intent.id],
    );

    await expect(
      repository.claimPendingIntent({
        clinicId,
        intentId: intent.id,
        leaseMs: 60_000,
      }),
    ).resolves.toBeNull();

    const recovered = await pool.query<{
      state: string;
      dispatch_attempt_count: number;
      next_attempt_at: Date | null;
      dispatch_claim_token: string | null;
    }>(
      `SELECT state, dispatch_attempt_count, next_attempt_at, dispatch_claim_token
         FROM notification_outbox
        WHERE id=$1`,
      [intent.id],
    );
    expect(recovered.rows[0]?.state).toBe('unknown');
    expect(recovered.rows[0]?.dispatch_attempt_count).toBe(2);
    expect(recovered.rows[0]?.next_attempt_at).not.toBeNull();
    expect(recovered.rows[0]?.dispatch_claim_token).toBeNull();

    await pool.query(
      'UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1',
      [intent.id],
    );
    const replacement = await repository.claimPendingIntent({
      clinicId,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(replacement?.intent.dispatchAttemptCount).toBe(3);
    expect(replacement?.claimToken).not.toBe(abandoned?.claimToken);
  });

  it('does not exhaust pending work on explicit release and terminalizes expired final attempts', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const intent = await repository.enqueue(input(1, 'abandoned-pending'));
    await pool.query(
      'UPDATE notification_outbox SET dispatch_max_attempts=2 WHERE id=$1',
      [intent.id],
    );

    for (let index = 0; index < 3; index += 1) {
      const releasedClaim = await repository.claimPendingIntent({
        clinicId,
        intentId: intent.id,
        leaseMs: 60_000,
      });
      expect(releasedClaim?.intent.dispatchAttemptCount).toBe(1);
      await expect(
        repository.releaseDispatchClaim(
          clinicId,
          intent.id,
          releasedClaim!.claimToken,
        ),
      ).resolves.toBe(true);
    }

    const afterReleases = await pool.query<{ dispatch_attempt_count: number }>(
      'SELECT dispatch_attempt_count FROM notification_outbox WHERE id=$1',
      [intent.id],
    );
    expect(afterReleases.rows[0]?.dispatch_attempt_count).toBe(0);

    const abandoned = await repository.claimPendingIntent({
      clinicId,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(abandoned).not.toBeNull();
    await pool.query(
      `UPDATE notification_outbox
          SET dispatch_claim_expires_at=now() - interval '1 millisecond'
        WHERE id=$1`,
      [intent.id],
    );

    await expect(
      repository.claimPendingIntent({
        clinicId,
        intentId: intent.id,
        leaseMs: 60_000,
      }),
    ).resolves.toBeNull();
    const recovered = await pool.query<{
      state: string;
      dispatch_attempt_count: number;
      next_attempt_at: Date | null;
    }>(
      `SELECT state, dispatch_attempt_count, next_attempt_at
         FROM notification_outbox
        WHERE id=$1`,
      [intent.id],
    );
    expect(recovered.rows[0]?.state).toBe('unknown');
    expect(recovered.rows[0]?.dispatch_attempt_count).toBe(1);
    expect(recovered.rows[0]?.next_attempt_at).not.toBeNull();

    await pool.query(
      'UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1',
      [intent.id],
    );
    const finalClaim = await repository.claimPendingIntent({
      clinicId,
      intentId: intent.id,
      leaseMs: 60_000,
    });
    expect(finalClaim?.intent.dispatchAttemptCount).toBe(2);
    await pool.query(
      `UPDATE notification_outbox
          SET dispatch_claim_expires_at=now() - interval '1 millisecond'
        WHERE id=$1`,
      [intent.id],
    );

    await expect(
      repository.claimPendingIntent({
        clinicId,
        intentId: intent.id,
        leaseMs: 60_000,
      }),
    ).resolves.toBeNull();
    const exhausted = await pool.query<{
      state: string;
      next_attempt_at: Date | null;
    }>(
      'SELECT state, next_attempt_at FROM notification_outbox WHERE id=$1',
      [intent.id],
    );
    expect(exhausted.rows[0]).toMatchObject({
      state: 'dead_letter',
      next_attempt_at: null,
    });
  });
});
