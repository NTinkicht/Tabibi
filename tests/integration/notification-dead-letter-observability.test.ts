import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import { NotificationDeadLetterObservabilityRepository } from '@/modules/notification-outbox/observability';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const clinicA = randomUUID();
const clinicB = randomUUID();

beforeAll(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE notification_outbox, clinics CASCADE');
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name)
     VALUES ($1, 'wu39-a', 'WU39 A'), ($2, 'wu39-b', 'WU39 B')`,
    [clinicA, clinicB],
  );
});
afterAll(async () => pool.end());

async function enqueue(
  clinicId: string,
  key: string,
  eventKey = 'turn_approaching',
) {
  return new NotificationOutboxRepository(pool).enqueue({
    clinicId,
    logicalTargetKey: `queue-entry:${key}`,
    eventKey,
    intentVersion: 1,
    idempotencyKey: key,
    payload: { locale: 'fr', places: 2 },
  });
}

async function deadLetter(
  clinicId: string,
  key: string,
  outcomeCode: string,
  outcomeAt: string,
) {
  const repository = new NotificationOutboxRepository(pool);
  const intent = await enqueue(clinicId, key);
  await pool.query(
    'UPDATE notification_outbox SET dispatch_max_attempts=1 WHERE id=$1',
    [intent.id],
  );
  const claim = await repository.claimPendingIntent({
    clinicId,
    intentId: intent.id,
    leaseMs: 60_000,
  });
  expect(claim).not.toBeNull();
  await repository.completeDispatchAttempt({
    clinicId,
    intentId: intent.id,
    claimToken: claim!.claimToken,
    outcome: 'failed',
    outcomeCode,
  });
  await pool.query(
    'UPDATE notification_outbox SET dispatch_outcome_at=$2 WHERE id=$1',
    [intent.id, outcomeAt],
  );
  return intent;
}

describe('notification dead-letter observability', () => {
  it('returns only bounded privacy-minimal dead letters for the requested clinic', async () => {
    const older = await deadLetter(
      clinicA,
      'wu39-a-old',
      'provider_timeout',
      '2026-09-13T10:00:00Z',
    );
    const newer = await deadLetter(
      clinicA,
      'wu39-a-new',
      'provider_unknown',
      '2026-09-13T11:00:00Z',
    );
    await deadLetter(
      clinicB,
      'wu39-b-private',
      'other_clinic_failure',
      '2026-09-13T12:00:00Z',
    );
    await enqueue(clinicA, 'wu39-pending');

    const repository = new NotificationDeadLetterObservabilityRepository(pool);
    const records = await repository.listRecentForClinic({
      clinicId: clinicA,
      limit: 1,
    });

    expect(records).toEqual([
      {
        intentId: newer.id,
        eventKey: 'turn_approaching',
        queueEntryId: null,
        outcomeCode: 'provider_unknown',
        attemptCount: 1,
        maxAttempts: 1,
        outcomeAt: '2026-09-13T11:00:00.000Z',
      },
    ]);
    expect(records[0]).not.toHaveProperty('payload');
    expect(records[0]).not.toHaveProperty('logicalTargetKey');
    expect(records[0]).not.toHaveProperty('idempotencyKey');
    expect(records[0]).not.toHaveProperty('claimToken');

    const allClinicA = await repository.listRecentForClinic({
      clinicId: clinicA,
    });
    expect(allClinicA.map((record) => record.intentId)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it('rejects invalid scope and unbounded limits before querying', async () => {
    const repository = new NotificationDeadLetterObservabilityRepository(pool);

    await expect(
      repository.listRecentForClinic({ clinicId: '   ' }),
    ).rejects.toThrow('clinicId is required');
    await expect(
      repository.listRecentForClinic({ clinicId: clinicA, limit: 101 }),
    ).rejects.toThrow('limit must be an integer between 1 and 100');
  });
});
