import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InAppNotificationInboxRepository } from '@/modules/notification-inbox';
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
       ($1,'inbox-read-a','Inbox Read A'),($2,'inbox-read-b','Inbox Read B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO patient_operational_records(id,clinic_id,private_display_name) VALUES
       ($1,$4,'Private A'),($2,$4,'Private A2'),($3,$5,'Private B')`,
    [ids.patientA, ids.patientA2, ids.patientB, ids.clinicA, ids.clinicB],
  );
});
afterAll(() => pool.end());

function envelope(): RenderedNotificationDispatchEnvelope {
  return {
    channel: 'in_app',
    locale: 'fr',
    direction: 'ltr',
    templateId: 'turn_approaching.v1',
    title: 'Votre tour approche',
    body: 'Il reste 2 passage(s) avant votre tour.',
    providerIdempotencyKey: 'notification:intent-inbox-read-1',
  };
}

const ownScope = {
  clinicId: ids.clinicA,
  subjectKind: 'visit_patient' as const,
  subjectId: ids.patientA,
};

describe('in-app notification inbox read state', () => {
  it(
    'marks one exact-subject item read and preserves the first timestamp on retry',
    async () => {
      const repository = new InAppNotificationInboxRepository(pool);
      const created = await repository.persist({
        ...ownScope,
        envelope: envelope(),
      });
      expect(created.readAt).toBeNull();

      const first = await repository.markRead({
        ...ownScope,
        itemId: created.id,
      });
      expect(first?.readAt).toEqual(expect.any(String));

      const second = await repository.markRead({
        ...ownScope,
        itemId: created.id,
      });
      expect(second?.readAt).toBe(first?.readAt);

      const listed = await repository.listForSubject({
        ...ownScope,
        limit: 10,
      });
      expect(listed).toEqual([second]);

      const stored = await pool.query<{ read_at: Date | null }>(
        'SELECT read_at FROM notification_inbox_items WHERE id=$1',
        [created.id],
      );
      expect(stored.rows[0]?.read_at?.toISOString()).toBe(first?.readAt);
    },
  );

  it(
    'fails closed for wrong clinic, subject, kind, and unknown item without mutation',
    async () => {
      const repository = new InAppNotificationInboxRepository(pool);
      const created = await repository.persist({
        ...ownScope,
        envelope: envelope(),
      });

      await expect(
        repository.markRead({
          ...ownScope,
          clinicId: ids.clinicB,
          itemId: created.id,
        }),
      ).resolves.toBeNull();
      await expect(
        repository.markRead({
          ...ownScope,
          subjectId: ids.patientA2,
          itemId: created.id,
        }),
      ).resolves.toBeNull();
      await expect(
        repository.markRead({
          clinicId: ids.clinicA,
          subjectKind: 'account',
          subjectId: ids.patientA,
          itemId: created.id,
        }),
      ).resolves.toBeNull();
      await expect(
        repository.markRead({
          ...ownScope,
          itemId: randomUUID(),
        }),
      ).resolves.toBeNull();

      const stored = await pool.query<{ read_at: Date | null }>(
        'SELECT read_at FROM notification_inbox_items WHERE id=$1',
        [created.id],
      );
      expect(stored.rows[0]?.read_at).toBeNull();
    },
  );
});
