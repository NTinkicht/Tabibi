import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  NotificationOutboxConflictError,
  NotificationOutboxRepository,
} from '@/modules/notification-outbox';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const clinicA = randomUUID();
const clinicB = randomUUID();

beforeAll(migrate);

beforeEach(async () => {
  await pool.query('TRUNCATE notification_outbox, clinics CASCADE');
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
      ($1, 'outbox-clinic-a', 'Outbox Clinic A'),
      ($2, 'outbox-clinic-b', 'Outbox Clinic B')`,
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
    logicalTargetKey: 'queue-entry:example',
    eventKey: 'estimate_changed_materially',
    intentVersion,
    idempotencyKey,
    payload: { locale: 'fr', minutes: 20 },
  };
}

describe('notification outbox repository', () => {
  it('enqueues increasing versions and supersedes only the previous pending intent', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const first = await repository.enqueue(input(clinicA, 1, 'estimate-v1'));
    const second = await repository.enqueue(input(clinicA, 2, 'estimate-v2'));

    expect(first).toMatchObject({ state: 'pending', intentVersion: 1 });
    expect(second).toMatchObject({ state: 'pending', intentVersion: 2 });
    const rows = await pool.query<{
      id: string;
      state: string;
      superseded_by_id: string | null;
      superseded_at: Date | null;
    }>(
      `SELECT id, state, superseded_by_id, superseded_at
         FROM notification_outbox
        WHERE clinic_id=$1
        ORDER BY intent_version`,
      [clinicA],
    );
    expect(rows.rows).toEqual([
      {
        id: first.id,
        state: 'superseded',
        superseded_by_id: second.id,
        superseded_at: expect.any(Date),
      },
      {
        id: second.id,
        state: 'pending',
        superseded_by_id: null,
        superseded_at: null,
      },
    ]);
  });

  it('rejects stale and duplicate versions without changing the pending intent', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const latest = await repository.enqueue(input(clinicA, 3, 'estimate-v3'));

    await expect(
      repository.enqueue(input(clinicA, 2, 'stale-estimate-v2')),
    ).rejects.toBeInstanceOf(NotificationOutboxConflictError);
    await expect(
      repository.enqueue(input(clinicA, 3, 'duplicate-estimate-v3')),
    ).rejects.toBeInstanceOf(NotificationOutboxConflictError);

    const pending = await pool.query<{ id: string }>(
      `SELECT id FROM notification_outbox WHERE clinic_id=$1 AND state='pending'`,
      [clinicA],
    );
    expect(pending.rows).toEqual([{ id: latest.id }]);
  });

  it('isolates clinic streams and rejects a cross-clinic supersession link', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const intentA = await repository.enqueue(input(clinicA, 1, 'shared-key'));
    const intentB = await repository.enqueue(input(clinicB, 1, 'shared-key'));

    expect(intentA.clinicId).toBe(clinicA);
    expect(intentB.clinicId).toBe(clinicB);
    await expect(
      pool.query(
        `UPDATE notification_outbox
            SET state='superseded', superseded_by_id=$1, superseded_at=now()
          WHERE id=$2`,
        [intentB.id, intentA.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('returns an idempotent retry for structurally equal JSON regardless of object key order', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const firstPayload = {
      longProperty: 1,
      a: { second: true, first: ['one', { z: 3, b: 2 }] },
    };
    const retryPayload = {
      a: { first: ['one', { b: 2, z: 3 }], second: true },
      longProperty: 1,
    };
    const first = await repository.enqueue({
      ...input(clinicA, 1, 'ordered-json'),
      payload: firstPayload,
    });
    const retry = await repository.enqueue({
      ...input(clinicA, 1, 'ordered-json'),
      payload: retryPayload,
    });

    expect(retry).toEqual(first);
    const count = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM notification_outbox',
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('serializes concurrent retries and competing enqueues deterministically', async () => {
    const repository = new NotificationOutboxRepository(pool);
    const retries = await Promise.all(
      Array.from({ length: 6 }, () =>
        repository.enqueue(input(clinicA, 1, 'concurrent-retry')),
      ),
    );
    expect(new Set(retries.map((intent) => intent.id)).size).toBe(1);

    const competing = await Promise.allSettled([
      repository.enqueue(input(clinicA, 2, 'concurrent-v2-a')),
      repository.enqueue(input(clinicA, 2, 'concurrent-v2-b')),
    ]);
    expect(
      competing.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejection = competing.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: expect.any(NotificationOutboxConflictError),
    });

    const states = await pool.query<{ state: string; count: string }>(
      `SELECT state, count(*)::text AS count
         FROM notification_outbox
        WHERE clinic_id=$1
        GROUP BY state
        ORDER BY state`,
      [clinicA],
    );
    expect(states.rows).toEqual([
      { state: 'pending', count: '1' },
      { state: 'superseded', count: '1' },
    ]);
  });
});
