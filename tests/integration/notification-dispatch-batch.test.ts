import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { NotificationDispatchBatchRunner } from '@/modules/notification-domain/dispatch-batch';
import {
  NotificationDispatchService,
  type NotificationProviderAdapter,
} from '@/modules/notification-domain';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import {
  MAX_NOTIFICATION_DISPATCH_BATCH_SIZE,
  NotificationDispatchEligibilityRepository,
} from '@/modules/notification-outbox/dispatch-eligibility';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const clinicA = randomUUID();
const clinicB = randomUUID();

beforeAll(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE notification_outbox, clinics CASCADE');
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name)
     VALUES ($1, 'dispatch-batch-a', 'Dispatch Batch A'),
            ($2, 'dispatch-batch-b', 'Dispatch Batch B')`,
    [clinicA, clinicB],
  );
});
afterAll(async () => pool.end());

function input(clinicId: string, key: string, version = 1) {
  return {
    clinicId,
    logicalTargetKey: `queue-entry:${key}`,
    eventKey: 'turn_approaching',
    intentVersion: version,
    idempotencyKey: `dispatch-batch:${key}:${version}`,
    payload: { locale: 'en', places: 2 },
  };
}

describe('notification dispatch eligibility and bounded batch', () => {
  it('selects only clinic-scoped due unclaimed intents and enforces bounds', async () => {
    const outbox = new NotificationOutboxRepository(pool);
    const scanner = new NotificationDispatchEligibilityRepository(pool);
    const duePending = await outbox.enqueue(input(clinicA, 'due-pending'));
    const notDue = await outbox.enqueue(input(clinicA, 'not-due'));
    const notDueClaim = await outbox.claimPendingIntent({
      clinicId: clinicA,
      intentId: notDue.id,
      leaseMs: 60_000,
    });
    await outbox.completeDispatchAttempt({
      clinicId: clinicA,
      intentId: notDue.id,
      claimToken: notDueClaim!.claimToken,
      outcome: 'failed',
    });

    const active = await outbox.enqueue(input(clinicA, 'active-claim'));
    await outbox.claimPendingIntent({
      clinicId: clinicA,
      intentId: active.id,
      leaseMs: 60_000,
    });

    const delivered = await outbox.enqueue(input(clinicA, 'delivered'));
    const deliveredClaim = await outbox.claimPendingIntent({
      clinicId: clinicA,
      intentId: delivered.id,
      leaseMs: 60_000,
    });
    await outbox.completeDispatchAttempt({
      clinicId: clinicA,
      intentId: delivered.id,
      claimToken: deliveredClaim!.claimToken,
      outcome: 'delivered',
    });

    const exhausted = await outbox.enqueue(input(clinicA, 'exhausted'));
    await pool.query(
      `UPDATE notification_outbox
          SET dispatch_max_attempts = 1
        WHERE id=$1`,
      [exhausted.id],
    );
    await outbox.claimPendingIntent({
      clinicId: clinicA,
      intentId: exhausted.id,
      leaseMs: 60_000,
    });
    await pool.query(
      `UPDATE notification_outbox
          SET dispatch_claim_token = NULL,
              dispatch_claimed_at = NULL,
              dispatch_claim_expires_at = NULL
        WHERE id=$1`,
      [exhausted.id],
    );

    const superseded = await outbox.enqueue(input(clinicA, 'superseded'));
    const superseding = await outbox.enqueue(input(clinicA, 'superseded', 2));
    await outbox.claimPendingIntent({
      clinicId: clinicA,
      intentId: superseding.id,
      leaseMs: 60_000,
    });

    await outbox.enqueue(input(clinicB, 'other-clinic'));

    const eligible = await scanner.listEligible({
      clinicId: clinicA,
      limit: 10,
    });
    expect(eligible).toEqual([
      expect.objectContaining({ intentId: duePending.id }),
    ]);
    expect(eligible.map((candidate) => candidate.intentId)).not.toContain(
      delivered.id,
    );
    expect(eligible.map((candidate) => candidate.intentId)).not.toContain(
      exhausted.id,
    );
    expect(eligible.map((candidate) => candidate.intentId)).not.toContain(
      superseded.id,
    );

    await expect(
      scanner.listEligible({ clinicId: clinicA, limit: 0 }),
    ).rejects.toThrow('Dispatch batch size must be between 1 and');
    await expect(
      scanner.listEligible({
        clinicId: clinicA,
        limit: MAX_NOTIFICATION_DISPATCH_BATCH_SIZE + 1,
      }),
    ).rejects.toThrow('Dispatch batch size must be between 1 and');
  });

  it('recovers an expired claimed retry even though claiming cleared its retry deadline', async () => {
    const outbox = new NotificationOutboxRepository(pool);
    const scanner = new NotificationDispatchEligibilityRepository(pool);
    const retry = await outbox.enqueue(input(clinicA, 'expired-retry-claim'));
    const initialClaim = await outbox.claimPendingIntent({
      clinicId: clinicA,
      intentId: retry.id,
      leaseMs: 60_000,
    });
    await outbox.completeDispatchAttempt({
      clinicId: clinicA,
      intentId: retry.id,
      claimToken: initialClaim!.claimToken,
      outcome: 'failed',
    });
    await pool.query(
      `UPDATE notification_outbox
          SET next_attempt_at = now() - interval '1 second'
        WHERE id=$1`,
      [retry.id],
    );

    const retryClaim = await outbox.claimPendingIntent({
      clinicId: clinicA,
      intentId: retry.id,
      leaseMs: 60_000,
    });
    expect(retryClaim).not.toBeNull();
    await expect(
      scanner.listEligible({ clinicId: clinicA, limit: 10 }),
    ).resolves.toEqual([]);

    await pool.query(
      `UPDATE notification_outbox
          SET dispatch_claimed_at = now() - interval '2 minutes',
              dispatch_claim_expires_at = now() - interval '1 minute'
        WHERE id=$1`,
      [retry.id],
    );

    await expect(
      scanner.listEligible({ clinicId: clinicA, limit: 10 }),
    ).resolves.toEqual([expect.objectContaining({ intentId: retry.id })]);
  });

  it('orders by due time with stable tie breakers and applies the requested limit', async () => {
    const outbox = new NotificationOutboxRepository(pool);
    const scanner = new NotificationDispatchEligibilityRepository(pool);
    const first = await outbox.enqueue(input(clinicA, 'first'));
    const second = await outbox.enqueue(input(clinicA, 'second'));
    const third = await outbox.enqueue(input(clinicA, 'third'));

    await pool.query(
      `UPDATE notification_outbox
          SET created_at = CASE id
            WHEN $1::uuid THEN TIMESTAMPTZ '2026-09-11 00:00:03+00'
            WHEN $2::uuid THEN TIMESTAMPTZ '2026-09-11 00:00:01+00'
            WHEN $3::uuid THEN TIMESTAMPTZ '2026-09-11 00:00:02+00'
            ELSE created_at
          END
        WHERE id IN ($1::uuid, $2::uuid, $3::uuid)`,
      [first.id, second.id, third.id],
    );

    const selected = await scanner.listEligible({
      clinicId: clinicA,
      limit: 2,
    });
    expect(selected.map((candidate) => candidate.intentId)).toEqual([
      second.id,
      third.id,
    ]);
  });

  it('lets concurrent runners race through the existing atomic claim fence without duplicate provider ownership', async () => {
    const outbox = new NotificationOutboxRepository(pool);
    const scanner = new NotificationDispatchEligibilityRepository(pool);
    const intent = await outbox.enqueue(input(clinicA, 'concurrent'));
    const dispatch = vi.fn<NotificationProviderAdapter['dispatch']>(
      async () => ({
        kind: 'delivered',
        code: 'accepted',
      }),
    );
    const service = new NotificationDispatchService(outbox, { dispatch });
    const runnerA = new NotificationDispatchBatchRunner(scanner, service);
    const runnerB = new NotificationDispatchBatchRunner(scanner, service);

    const summaries = await Promise.all([
      runnerA.run({ clinicId: clinicA, limit: 1 }),
      runnerB.run({ clinicId: clinicA, limit: 1 }),
    ]);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(summaries.reduce((sum, item) => sum + item.completed, 0)).toBe(1);
    expect(
      summaries.reduce((sum, item) => sum + item.notClaimed, 0),
    ).toBeLessThanOrEqual(1);
    const persisted = await pool.query<{ state: string }>(
      'SELECT state FROM notification_outbox WHERE id=$1',
      [intent.id],
    );
    expect(persisted.rows[0]?.state).toBe('delivered');
  });
});
