import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { createQueueInAppNotificationDispatchService } from '@/modules/notification-domain/in-app-runtime';
import { QueueNotificationProducer } from '@/modules/notification-domain';
import { InAppNotificationInboxRepository } from '@/modules/notification-inbox';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import { NotificationPreferenceRepository } from '@/modules/notification-preferences';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  doctorUserA: randomUUID(),
  doctorUserB: randomUUID(),
  doctorA: randomUUID(),
  doctorB: randomUUID(),
  sessionA: randomUUID(),
  sessionB: randomUUID(),
  patientA: randomUUID(),
  patientB: randomUUID(),
  queueEntryA: randomUUID(),
  queueEntryB: randomUUID(),
};

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(
    'TRUNCATE notification_inbox_items, notification_preference_receipts, notification_preferences, notification_outbox, clinics, users CASCADE',
  );
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name)
     VALUES ($1, 'wu38-doctor-a', 'Doctor A'),
            ($2, 'wu38-doctor-b', 'Doctor B')`,
    [ids.doctorUserA, ids.doctorUserB],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name)
     VALUES ($1, 'wu38-a', 'WU38 A'),
            ($2, 'wu38-b', 'WU38 B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name)
     VALUES ($1, $2, 'Doctor A'), ($3, $4, 'Doctor B')`,
    [ids.doctorA, ids.doctorUserA, ids.doctorB, ids.doctorUserB],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id)
     VALUES ($1, $2), ($3, $4)`,
    [ids.clinicA, ids.doctorA, ids.clinicB, ids.doctorB],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES
       ($1, $2, $3, '2026-09-13', '2026-09-13T08:00Z', '2026-09-13T12:00Z', 'open'),
       ($4, $5, $6, '2026-09-13', '2026-09-13T08:00Z', '2026-09-13T12:00Z', 'open')`,
    [
      ids.sessionA,
      ids.clinicA,
      ids.doctorA,
      ids.sessionB,
      ids.clinicB,
      ids.doctorB,
    ],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
       (id, clinic_id, private_display_name)
     VALUES ($1, $2, 'Patient A'), ($3, $4, 'Patient B')`,
    [ids.patientA, ids.clinicA, ids.patientB, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id, clinic_id, session_id, patient_id, state, source, registration_order,
        public_display_label)
     VALUES
       ($1, $2, $3, $4, 'waiting', 'walk_in', 1, 'A-001'),
       ($5, $6, $7, $8, 'waiting', 'walk_in', 1, 'B-001')`,
    [
      ids.queueEntryA,
      ids.clinicA,
      ids.sessionA,
      ids.patientA,
      ids.queueEntryB,
      ids.clinicB,
      ids.sessionB,
      ids.patientB,
    ],
  );
});
afterAll(async () => pool.end());

async function enableInApp(
  clinicId: string,
  patientId: string,
  idempotencyKey: string,
) {
  return new NotificationPreferenceRepository(pool).change({
    clinicId,
    subjectKind: 'visit_patient',
    subjectId: patientId,
    channel: 'in_app',
    preferenceState: 'enabled',
    consentState: 'not_required',
    idempotencyKey,
  });
}

function queueCreated(
  clinicId: string,
  queueEntryId: string,
  sourceEventId: string,
) {
  return {
    clinicId,
    queueEntryId,
    sourceEventId,
    sourceVersion: 1,
    notification: {
      eventKey: 'queue_entry_created' as const,
      locale: 'fr',
    },
  };
}

describe('queue in-app production composition', () => {
  it('delivers one authorized queue intent to the exact patient inbox and stays idempotent on retry', async () => {
    await enableInApp(ids.clinicA, ids.patientA, 'wu38-pref-a');

    const outbox = new NotificationOutboxRepository(pool);
    const producer = new QueueNotificationProducer(outbox);
    const intent = await producer.produce(
      queueCreated(ids.clinicA, ids.queueEntryA, 'wu38-event-a'),
    );

    const service = createQueueInAppNotificationDispatchService(pool);
    const delivered = await service.dispatchOne({
      clinicId: ids.clinicA,
      intentId: intent.id,
    });

    expect(delivered).toMatchObject({
      status: 'completed',
      providerResult: { kind: 'delivered', code: 'in_app_persisted' },
      intent: { id: intent.id, state: 'delivered' },
    });

    const inbox = new InAppNotificationInboxRepository(pool);
    const items = await inbox.listForSubject({
      clinicId: ids.clinicA,
      subjectKind: 'visit_patient',
      subjectId: ids.patientA,
      limit: 20,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      clinicId: ids.clinicA,
      subjectKind: 'visit_patient',
      subjectId: ids.patientA,
      templateId: 'queue_entry_created.v1',
      locale: 'fr',
      readAt: null,
    });

    await expect(
      service.dispatchOne({ clinicId: ids.clinicA, intentId: intent.id }),
    ).resolves.toEqual({ status: 'not_claimed' });
    await expect(
      inbox.listForSubject({
        clinicId: ids.clinicA,
        subjectKind: 'visit_patient',
        subjectId: ids.patientA,
        limit: 20,
      }),
    ).resolves.toHaveLength(1);

    await expect(
      inbox.listForSubject({
        clinicId: ids.clinicB,
        subjectKind: 'visit_patient',
        subjectId: ids.patientB,
        limit: 20,
      }),
    ).resolves.toHaveLength(0);
  });

  it('suppresses a pending non-terminal notification after its queue entry becomes terminal', async () => {
    await enableInApp(ids.clinicA, ids.patientA, 'wu38-pref-terminal');

    const outbox = new NotificationOutboxRepository(pool);
    const producer = new QueueNotificationProducer(outbox);
    const intent = await producer.produce(
      queueCreated(ids.clinicA, ids.queueEntryA, 'wu38-event-terminal'),
    );

    await pool.query(
      `UPDATE queue_entries SET state='cancelled' WHERE id=$1 AND clinic_id=$2`,
      [ids.queueEntryA, ids.clinicA],
    );

    const service = createQueueInAppNotificationDispatchService(pool);
    const result = await service.dispatchOne({
      clinicId: ids.clinicA,
      intentId: intent.id,
    });

    expect(result).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'delivery_context_missing',
      intent: { id: intent.id, state: 'suppressed' },
    });
    await expect(
      new InAppNotificationInboxRepository(pool).listForSubject({
        clinicId: ids.clinicA,
        subjectKind: 'visit_patient',
        subjectId: ids.patientA,
        limit: 20,
      }),
    ).resolves.toHaveLength(0);
  });

  it('suppresses before inbox persistence when the current in-app preference is missing', async () => {
    const outbox = new NotificationOutboxRepository(pool);
    const producer = new QueueNotificationProducer(outbox);
    const intent = await producer.produce(
      queueCreated(ids.clinicA, ids.queueEntryA, 'wu38-event-no-pref'),
    );

    const service = createQueueInAppNotificationDispatchService(pool);
    const result = await service.dispatchOne({
      clinicId: ids.clinicA,
      intentId: intent.id,
    });

    expect(result).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'preference_missing',
      intent: { state: 'suppressed' },
    });
    await expect(
      new InAppNotificationInboxRepository(pool).listForSubject({
        clinicId: ids.clinicA,
        subjectKind: 'visit_patient',
        subjectId: ids.patientA,
        limit: 20,
      }),
    ).resolves.toHaveLength(0);
  });

  it('rejects a cross-clinic queue target before dispatch or inbox persistence', async () => {
    await enableInApp(ids.clinicA, ids.patientA, 'wu38-pref-cross-clinic');

    const outbox = new NotificationOutboxRepository(pool);
    await expect(
      outbox.enqueue({
        clinicId: ids.clinicA,
        queueEntryId: ids.queueEntryB,
        logicalTargetKey: `queue-entry:${ids.queueEntryB}`,
        eventKey: 'queue_entry_created',
        intentVersion: 1,
        idempotencyKey: 'wu38-cross-clinic-intent',
        payload: { locale: 'fr' },
      }),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'notification_outbox_queue_entry_id_clinic_id_fkey',
    });

    await expect(
      pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM notification_outbox
          WHERE clinic_id=$1 AND idempotency_key=$2`,
        [ids.clinicA, 'wu38-cross-clinic-intent'],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const inbox = new InAppNotificationInboxRepository(pool);
    await expect(
      inbox.listForSubject({
        clinicId: ids.clinicA,
        subjectKind: 'visit_patient',
        subjectId: ids.patientA,
        limit: 20,
      }),
    ).resolves.toHaveLength(0);
    await expect(
      inbox.listForSubject({
        clinicId: ids.clinicB,
        subjectKind: 'visit_patient',
        subjectId: ids.patientB,
        limit: 20,
      }),
    ).resolves.toHaveLength(0);
  });
});
