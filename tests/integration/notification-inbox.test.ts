import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InAppNotificationInboxConflictError,
  InAppNotificationInboxRepository,
} from '@/modules/notification-inbox';
import type { RenderedNotificationDispatchEnvelope } from '@/modules/notification-domain';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  patientA: randomUUID(),
  patientA2: randomUUID(),
  patientB: randomUUID(),
};

beforeAll(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE notification_inbox_items, clinics CASCADE');
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
       ($1,'inbox-a','Inbox A'),($2,'inbox-b','Inbox B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO patient_operational_records(id,clinic_id,private_display_name) VALUES
       ($1,$4,'Private A'),($2,$4,'Private A2'),($3,$5,'Private B')`,
    [ids.patientA, ids.patientA2, ids.patientB, ids.clinicA, ids.clinicB],
  );
});
afterAll(() => pool.end());

function envelope(
  providerIdempotencyKey = 'notification:intent-inbox-1',
): RenderedNotificationDispatchEnvelope {
  return {
    channel: 'in_app',
    locale: 'fr',
    direction: 'ltr',
    templateId: 'turn_approaching.v1',
    title: 'Votre tour approche',
    body: 'Il reste 2 passage(s) avant votre tour.',
    providerIdempotencyKey,
  };
}

function write(overrides: Record<string, unknown> = {}) {
  return {
    clinicId: ids.clinicA,
    subjectKind: 'visit_patient' as const,
    subjectId: ids.patientA,
    envelope: envelope(),
    ...overrides,
  };
}

describe('in-app notification inbox repository', () => {
  it('serializes concurrent exact retries to one durable inbox item', async () => {
    const repository = new InAppNotificationInboxRepository(pool);
    const [first, second] = await Promise.all([
      repository.persist(write()),
      repository.persist(write()),
    ]);

    expect(second).toEqual(first);
    expect(
      (
        await pool.query<{ count: number }>(
          'SELECT count(*)::int count FROM notification_inbox_items',
        )
      ).rows[0]?.count,
    ).toBe(1);

    await expect(
      repository.persist(
        write({
          subjectId: ids.patientA2,
        }),
      ),
    ).rejects.toBeInstanceOf(InAppNotificationInboxConflictError);
  });

  it('lists only the exact clinic-bound subject with deterministic bounds', async () => {
    const repository = new InAppNotificationInboxRepository(pool);
    const own = await repository.persist(write());
    await repository.persist(
      write({
        subjectId: ids.patientA2,
        envelope: envelope('notification:intent-inbox-2'),
      }),
    );
    await repository.persist(
      write({
        clinicId: ids.clinicB,
        subjectId: ids.patientB,
        envelope: envelope('notification:intent-inbox-3'),
      }),
    );

    await expect(
      repository.listForSubject({
        clinicId: ids.clinicA,
        subjectKind: 'visit_patient',
        subjectId: ids.patientA,
        limit: 1,
      }),
    ).resolves.toEqual([own]);
    await expect(
      repository.listForSubject({
        clinicId: ids.clinicB,
        subjectKind: 'visit_patient',
        subjectId: ids.patientA,
        limit: 100,
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.listForSubject({
        clinicId: ids.clinicA,
        subjectKind: 'visit_patient',
        subjectId: ids.patientA2,
        limit: 100,
      }),
    ).resolves.toHaveLength(1);
  });

  it('persists only bounded rendered inbox fields and no sensitive routing material', async () => {
    const repository = new InAppNotificationInboxRepository(pool);
    await repository.persist(write());

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name='notification_inbox_items'`,
    );
    expect(columns.rows.map((row) => row.column_name).join(' ')).not.toMatch(
      /phone|email|contact|token|credential|clinical|exception|secret|bearer|exchange|variables|payload/,
    );

    const stored = await pool.query<{
      title: string;
      body: string;
      template_id: string;
      locale: string;
      direction: string;
    }>(
      `SELECT title, body, template_id, locale, direction
         FROM notification_inbox_items
        WHERE clinic_id=$1`,
      [ids.clinicA],
    );
    expect(stored.rows).toEqual([
      {
        title: 'Votre tour approche',
        body: 'Il reste 2 passage(s) avant votre tour.',
        template_id: 'turn_approaching.v1',
        locale: 'fr',
        direction: 'ltr',
      },
    ]);
  });
});
