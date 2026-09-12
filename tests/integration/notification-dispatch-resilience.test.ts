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
import {
  NotificationDispatchService,
  type NotificationProviderAdapter,
} from '@/modules/notification-domain';
import { NotificationDispatchBatchRunner } from '@/modules/notification-domain/dispatch-batch';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import { NotificationDispatchEligibilityRepository } from '@/modules/notification-outbox/dispatch-eligibility';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const clinicId = randomUUID();

beforeAll(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE notification_outbox, clinics CASCADE');
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name)
     VALUES ($1, 'dispatch-resilience', 'Dispatch Resilience')`,
    [clinicId],
  );
});
afterAll(async () => pool.end());

function enqueueInput(key: string) {
  return {
    clinicId,
    logicalTargetKey: `queue-entry:${key}`,
    eventKey: 'turn_approaching',
    intentVersion: 3,
    idempotencyKey: `dispatch-resilience:${key}`,
    payload: { locale: 'en', position: 2 },
  };
}

function eligibleContext(intentClinicId: string) {
  return {
    target: {
      subjectKind: 'visit_patient' as const,
      subjectId: '00000000-0000-0000-0000-000000000001',
      channel: 'sms' as const,
    },
    preference: {
      id: '00000000-0000-0000-0000-000000000002',
      clinicId: intentClinicId,
      subjectKind: 'visit_patient' as const,
      subjectId: '00000000-0000-0000-0000-000000000001',
      channel: 'sms' as const,
      preferenceState: 'enabled' as const,
      consentState: 'granted' as const,
      revision: 1,
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    },
  };
}

describe('WU31 PostgreSQL dispatch resilience', () => {
  it('dead-letters an exhausted resolver failure without aborting the later batch item', async () => {
    const outbox = new NotificationOutboxRepository(pool);
    const scanner = new NotificationDispatchEligibilityRepository(pool);
    const failing = await outbox.enqueue(enqueueInput('resolver-failure'));
    const succeeding = await outbox.enqueue(enqueueInput('later-success'));

    await pool.query(
      `UPDATE notification_outbox
          SET dispatch_max_attempts = 1,
              created_at = now() - interval '2 minutes'
        WHERE id=$1`,
      [failing.id],
    );
    await pool.query(
      `UPDATE notification_outbox
          SET created_at = now() - interval '1 minute'
        WHERE id=$1`,
      [succeeding.id],
    );

    const dispatch = vi.fn<NotificationProviderAdapter['dispatch']>(async () => ({
      kind: 'delivered',
      code: 'accepted',
    }));
    const service = new NotificationDispatchService(
      outbox,
      { dispatch },
      {
        resolve: vi.fn(async (intent) => {
          if (intent.id === failing.id) {
            throw new Error('Sensitive resolver detail');
          }
          return eligibleContext(intent.clinicId);
        }),
      },
    );
    const runner = new NotificationDispatchBatchRunner(scanner, service);

    const summary = await runner.run({ clinicId, limit: 2 });

    expect(summary.selected).toBe(2);
    expect(summary.errors).toBe(0);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const persisted = await pool.query<{
      id: string;
      state: string;
      dispatch_outcome_code: string | null;
    }>(
      `SELECT id, state, dispatch_outcome_code
         FROM notification_outbox
        WHERE id IN ($1, $2)
        ORDER BY id`,
      [failing.id, succeeding.id],
    );
    const byId = new Map(persisted.rows.map((row) => [row.id, row]));
    expect(byId.get(failing.id)).toMatchObject({
      state: 'dead_letter',
      dispatch_outcome_code: 'delivery_context_failure',
    });
    expect(byId.get(succeeding.id)).toMatchObject({ state: 'delivered' });
    expect(JSON.stringify(summary)).not.toContain('Sensitive resolver detail');
  });
});
