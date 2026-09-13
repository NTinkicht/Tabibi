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
       ($1,'inbox-unread-a','Inbox Unread A'),($2,'inbox-unread-b','Inbox Unread B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO patient_operational_records(id,clinic_id,private_display_name) VALUES
       ($1,$4,'Private A'),($2,$4,'Private A2'),($3,$5,'Private B')`,
    [ids.patientA, ids.patientA2, ids.patientB, ids.clinicA, ids.clinicB],
  );
});
afterAll(() => pool.end());

function envelope(key: string): RenderedNotificationDispatchEnvelope {
  return {
    channel: 'in_app',
    locale: 'fr',
    direction: 'ltr',
    templateId: 'turn_approaching.v1',
    title: 'Votre tour approche',
    body: 'Il reste 2 passage(s) avant votre tour.',
    providerIdempotencyKey: key,
  };
}

const ownScope = {
  clinicId: ids.clinicA,
  subjectKind: 'visit_patient' as const,
  subjectId: ids.patientA,
};

describe('in-app notification inbox unread count', () => {
  it('counts only unread rows for the exact subject and changes once after markRead', async () => {
    const repository = new InAppNotificationInboxRepository(pool);
    const first = await repository.persist({
      ...ownScope,
      envelope: envelope('notification:unread-own-1'),
    });
    await repository.persist({
      ...ownScope,
      envelope: envelope('notification:unread-own-2'),
    });
    await repository.persist({
      ...ownScope,
      subjectId: ids.patientA2,
      envelope: envelope('notification:unread-other-subject'),
    });
    await repository.persist({
      clinicId: ids.clinicB,
      subjectKind: 'visit_patient',
      subjectId: ids.patientB,
      envelope: envelope('notification:unread-other-clinic'),
    });

    await expect(repository.unreadCount(ownScope)).resolves.toBe(2);

    await repository.markRead({ ...ownScope, itemId: first.id });
    await expect(repository.unreadCount(ownScope)).resolves.toBe(1);

    await repository.markRead({ ...ownScope, itemId: first.id });
    await expect(repository.unreadCount(ownScope)).resolves.toBe(1);
  });

  it('returns zero for wrong clinic, subject, or kind without exposing other rows', async () => {
    const repository = new InAppNotificationInboxRepository(pool);
    await repository.persist({
      ...ownScope,
      envelope: envelope('notification:unread-isolation'),
    });

    await expect(
      repository.unreadCount({ ...ownScope, clinicId: ids.clinicB }),
    ).resolves.toBe(0);
    await expect(
      repository.unreadCount({ ...ownScope, subjectId: ids.patientA2 }),
    ).resolves.toBe(0);
    await expect(
      repository.unreadCount({
        clinicId: ids.clinicA,
        subjectKind: 'account',
        subjectId: ids.patientA,
      }),
    ).resolves.toBe(0);
  });
});
