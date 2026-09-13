import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  QueueNotificationProducer,
  QueueNotificationProducerValidationError,
  type QueueNotificationSourceEvent,
} from '@/modules/notification-domain';
import {
  NotificationOutboxConflictError,
  NotificationOutboxRepository,
} from '@/modules/notification-outbox';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const clinicA = randomUUID();
const clinicB = randomUUID();
const queueEntryId = randomUUID();

beforeAll(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE notification_outbox, clinics CASCADE');
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name)
     VALUES ($1, 'queue-producer-a', 'Queue Producer A'),
            ($2, 'queue-producer-b', 'Queue Producer B')`,
    [clinicA, clinicB],
  );
});
afterAll(async () => pool.end());

function turnApproaching(
  clinicId: string,
  sourceEventId: string,
  sourceVersion: number,
): QueueNotificationSourceEvent {
  return {
    clinicId,
    queueEntryId,
    sourceEventId,
    sourceVersion,
    notification: {
      eventKey: 'turn_approaching',
      locale: 'en',
      position: 2,
    },
  };
}

describe('queue notification producer with PostgreSQL outbox', () => {
  it('replays one source event idempotently and supersedes only with a newer version', async () => {
    const outbox = new NotificationOutboxRepository(pool);
    const producer = new QueueNotificationProducer(outbox);

    const first = await producer.produce(
      turnApproaching(clinicA, 'queue-event-1', 1),
    );
    const replay = await producer.produce(
      turnApproaching(clinicA, 'queue-event-1', 1),
    );

    expect(replay.id).toBe(first.id);
    await expect(
      pool.query(
        `SELECT count(*)::int AS count
           FROM notification_outbox
          WHERE clinic_id=$1 AND idempotency_key=$2`,
        [clinicA, 'queue-event:queue-event-1'],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const newer = await producer.produce(
      turnApproaching(clinicA, 'queue-event-2', 2),
    );
    expect(newer.id).not.toBe(first.id);

    const states = await pool.query<{
      id: string;
      state: string;
      superseded_by_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, state, superseded_by_id, payload
         FROM notification_outbox
        WHERE clinic_id=$1
        ORDER BY intent_version`,
      [clinicA],
    );
    expect(states.rows).toEqual([
      expect.objectContaining({
        id: first.id,
        state: 'superseded',
        superseded_by_id: newer.id,
        payload: { locale: 'en', position: 2 },
      }),
      expect.objectContaining({
        id: newer.id,
        state: 'pending',
        superseded_by_id: null,
        payload: { locale: 'en', position: 2 },
      }),
    ]);
    expect(JSON.stringify(states.rows)).not.toContain('places');

    await expect(
      producer.produce(turnApproaching(clinicA, 'queue-event-stale', 1)),
    ).rejects.toBeInstanceOf(NotificationOutboxConflictError);
  });

  it('keeps idempotency and persistence clinic-scoped', async () => {
    const producer = new QueueNotificationProducer(
      new NotificationOutboxRepository(pool),
    );

    const sourceEventId = 'shared-upstream-event';
    const first = await producer.produce(
      turnApproaching(clinicA, sourceEventId, 1),
    );
    const second = await producer.produce(
      turnApproaching(clinicB, sourceEventId, 1),
    );

    expect(first.clinicId).toBe(clinicA);
    expect(second.clinicId).toBe(clinicB);
    expect(first.id).not.toBe(second.id);

    const rows = await pool.query<{ clinic_id: string; count: number }>(
      `SELECT clinic_id, count(*)::int AS count
         FROM notification_outbox
        WHERE idempotency_key=$1
        GROUP BY clinic_id
        ORDER BY clinic_id`,
      [`queue-event:${sourceEventId}`],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        { clinic_id: clinicA, count: 1 },
        { clinic_id: clinicB, count: 1 },
      ]),
    );
  });

  it('fails closed for guest transfer before any outbox row is persisted', async () => {
    const producer = new QueueNotificationProducer(
      new NotificationOutboxRepository(pool),
    );
    const unsupported = {
      clinicId: clinicA,
      queueEntryId,
      sourceEventId: 'guest-transfer-event',
      sourceVersion: 1,
      notification: {
        eventKey: 'queue_entry_transferred',
        exchangeLink: 'https://sensitive.invalid/exchange-secret',
      },
    } as unknown as QueueNotificationSourceEvent;

    await expect(producer.produce(unsupported)).rejects.toBeInstanceOf(
      QueueNotificationProducerValidationError,
    );
    await expect(
      pool.query(
        `SELECT count(*)::int AS count
           FROM notification_outbox
          WHERE clinic_id=$1`,
        [clinicA],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
