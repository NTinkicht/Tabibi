import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  NotificationOutboxRepository,
  type NotificationDispatchOutcome,
} from '@/modules/notification-outbox';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const clinicA = randomUUID();
const clinicB = randomUUID();

beforeAll(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE notification_outbox, clinics CASCADE');
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
      ($1, 'outcome-clinic-a', 'Outcome Clinic A'),
      ($2, 'outcome-clinic-b', 'Outcome Clinic B')`,
    [clinicA, clinicB],
  );
});
afterAll(async () => pool.end());

function input(version: number, key: string) {
  return {
    clinicId: clinicA,
    logicalTargetKey: 'queue-entry:outcome-example',
    eventKey: 'turn_approaching',
    intentVersion: version,
    idempotencyKey: key,
    payload: { locale: 'fr', places: 2 },
  };
}

async function claim(repository: NotificationOutboxRepository, id: string) {
  const result = await repository.claimPendingIntent({
    clinicId: clinicA,
    intentId: id,
    leaseMs: 60_000,
  });
  expect(result).not.toBeNull();
  return result!;
}

describe('notification dispatch outcomes', () => {
  it.each<{
    outcome: NotificationDispatchOutcome;
    eligible: boolean;
  }>([
    { outcome: 'delivered', eligible: false },
    { outcome: 'failed', eligible: true },
    { outcome: 'unknown', eligible: true },
    { outcome: 'dead_letter', eligible: false },
  ])(
    'persists $outcome with deterministic retry eligibility',
    async ({ outcome, eligible }) => {
      const repository = new NotificationOutboxRepository(pool);
      const intent = await repository.enqueue(input(1, `outcome-${outcome}`));
      const dispatchClaim = await claim(repository, intent.id);

      const completed = await repository.completeDispatchAttempt({
        clinicId: clinicA,
        intentId: intent.id,
        claimToken: dispatchClaim.claimToken,
        outcome,
        outcomeCode: outcome === 'delivered' ? null : `provider_${outcome}`,
      });

      expect(completed).toMatchObject({
        id: intent.id,
        state: outcome,
        dispatchAttemptCount: 1,
      });
      expect(completed?.dispatchLastAttemptAt).not.toBeNull();
      expect(completed?.dispatchOutcomeAt).not.toBeNull();
      if (eligible) expect(completed?.nextAttemptAt).not.toBeNull();
      else expect(completed?.nextAttemptAt).toBeNull();
      const retry = await repository.claimPendingIntent({
        clinicId: clinicA,
        intentId: intent.id,
        leaseMs: 60_000,
      });
      expect(retry).toBeNull();
      if (eligible) {
        await pool.query(
          `UPDATE notification_outbox
              SET next_attempt_at=now() - interval '1 millisecond'
            WHERE id=$1`,
          [intent.id],
        );
        await expect(
          repository.claimPendingIntent({
            clinicId: clinicA,
            intentId: intent.id,
            leaseMs: 60_000,
          }),
        ).resolves.toMatchObject({ intent: { id: intent.id } });
      }
    },
  );

  it.each(['failed', 'unknown'] as const)(
    'rejects %s before its deterministic retry deadline',
    async (outcome) => {
      const repository = new NotificationOutboxRepository(pool);
      const intent = await repository.enqueue(
        input(1, `pre-deadline-${outcome}`),
      );
      const dispatchClaim = await claim(repository, intent.id);
      const completed = await repository.completeDispatchAttempt({
        clinicId: clinicA,
        intentId: intent.id,
        claimToken: dispatchClaim.claimToken,
        outcome,
      });

      expect(completed).toMatchObject({
        state: outcome,
        dispatchAttemptCount: 1,
        dispatchMaxAttempts: outcome === 'failed' ? 5 : 4,
      });
      expect(
        new Date(completed!.nextAttemptAt!).getTime() -
          new Date(completed!.dispatchOutcomeAt!).getTime(),
      ).toBe(60_000);
      await expect(
        repository.claimPendingIntent({
          clinicId: clinicA,
          intentId: intent.id,
          leaseMs: 60_000,
        }),
      ).resolves.toBeNull();
    },
  );

  it.each(['failed', 'unknown'] as const)(
    'atomically dead-letters %s at the exact maximum-attempt boundary',
    async (outcome) => {
      const repository = new NotificationOutboxRepository(pool);
      const intent = await repository.enqueue(input(1, `exhaust-${outcome}`));
      await pool.query(
        `UPDATE notification_outbox
            SET dispatch_max_attempts=2
          WHERE id=$1`,
        [intent.id],
      );

      const firstClaim = await claim(repository, intent.id);
      const first = await repository.completeDispatchAttempt({
        clinicId: clinicA,
        intentId: intent.id,
        claimToken: firstClaim.claimToken,
        outcome,
      });
      expect(first).toMatchObject({ state: outcome, dispatchAttemptCount: 1 });
      await pool.query(
        `UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1`,
        [intent.id],
      );

      const finalClaim = await claim(repository, intent.id);
      const exhausted = await repository.completeDispatchAttempt({
        clinicId: clinicA,
        intentId: intent.id,
        claimToken: finalClaim.claimToken,
        outcome,
        outcomeCode: 'provider_transient',
      });
      expect(exhausted).toMatchObject({
        state: 'dead_letter',
        dispatchAttemptCount: 2,
        dispatchMaxAttempts: 2,
        dispatchOutcomeCode: 'provider_transient',
        nextAttemptAt: null,
      });
      await expect(
        repository.claimPendingIntent({
          clinicId: clinicA,
          intentId: intent.id,
          leaseMs: 60_000,
        }),
      ).resolves.toBeNull();
      await expect(
        repository.completeDispatchAttempt({
          clinicId: clinicA,
          intentId: intent.id,
          claimToken: finalClaim.claimToken,
          outcome,
        }),
      ).resolves.toBeNull();
    },
  );

  it('preserves an active final-attempt claim until its owner completes it', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const intent = await repository.enqueue(input(1, 'active-final-claim'));
    await pool.query(
      `UPDATE notification_outbox
          SET state='failed',
              dispatch_attempt_count=1,
              dispatch_max_attempts=2,
              dispatch_last_attempt_at=now(),
              dispatch_outcome_at=now(),
              next_attempt_at=now()
        WHERE id=$1`,
      [intent.id],
    );

    const finalClaim = await claim(repository, intent.id);
    expect(finalClaim.intent.dispatchAttemptCount).toBe(2);

    await expect(
      repository.claimPendingIntent({
        clinicId: clinicA,
        intentId: intent.id,
        leaseMs: 60_000,
      }),
    ).resolves.toBeNull();

    await expect(
      repository.completeDispatchAttempt({
        clinicId: clinicA,
        intentId: intent.id,
        claimToken: finalClaim.claimToken,
        outcome: 'delivered',
      }),
    ).resolves.toMatchObject({
      state: 'delivered',
      dispatchAttemptCount: 2,
    });
  });

  it('fences wrong, cross-clinic, and replaced attempt tokens', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const intent = await repository.enqueue(input(1, 'fenced-outcome'));
    const first = await claim(repository, intent.id);

    await expect(
      repository.completeDispatchAttempt({
        clinicId: clinicB,
        intentId: intent.id,
        claimToken: first.claimToken,
        outcome: 'delivered',
      }),
    ).resolves.toBeNull();
    await expect(
      repository.completeDispatchAttempt({
        clinicId: clinicA,
        intentId: intent.id,
        claimToken: randomUUID(),
        outcome: 'delivered',
      }),
    ).resolves.toBeNull();

    await pool.query(
      `UPDATE notification_outbox
          SET dispatch_claimed_at=now() - interval '2 minutes',
              dispatch_claim_expires_at=now() - interval '1 minute'
        WHERE id=$1`,
      [intent.id],
    );
    const replacement = await claim(repository, intent.id);
    await expect(
      repository.completeDispatchAttempt({
        clinicId: clinicA,
        intentId: intent.id,
        claimToken: first.claimToken,
        outcome: 'delivered',
      }),
    ).resolves.toBeNull();
    await expect(
      repository.completeDispatchAttempt({
        clinicId: clinicA,
        intentId: intent.id,
        claimToken: replacement.claimToken,
        outcome: 'delivered',
      }),
    ).resolves.toMatchObject({ state: 'delivered', dispatchAttemptCount: 2 });
  });

  it('prevents a late result from reviving a superseded retryable intent', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const first = await repository.enqueue(input(1, 'outcome-v1'));
    const firstClaim = await claim(repository, first.id);
    await repository.enqueue(input(2, 'outcome-v2'));

    await expect(
      repository.completeDispatchAttempt({
        clinicId: clinicA,
        intentId: first.id,
        claimToken: firstClaim.claimToken,
        outcome: 'failed',
      }),
    ).resolves.toBeNull();
    const persisted = await pool.query<{ state: string }>(
      'SELECT state FROM notification_outbox WHERE id=$1',
      [first.id],
    );
    expect(persisted.rows[0]?.state).toBe('superseded');
  });
});
