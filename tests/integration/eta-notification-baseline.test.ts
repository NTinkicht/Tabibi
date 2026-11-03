import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { PgEtaNotificationBaselineStore } from '@/modules/notification-domain/eta-notification-baseline';
import { EtaNotificationCoordinator } from '@/modules/notification-domain/eta-notification-coordinator';
import {
  EtaNotificationGate,
  type EtaNotificationSnapshot,
} from '@/modules/notification-domain/eta-notification-gate';
import { QueueNotificationProducer } from '@/modules/notification-domain/queue-notification-producer';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const clinicId = randomUUID();
const otherClinicId = randomUUID();
const doctorUser = randomUUID();
const doctorId = randomUUID();
const sessionId = randomUUID();
const entryId = randomUUID();
const store = new PgEtaNotificationBaselineStore(pool);
const coordinator = () =>
  new EtaNotificationCoordinator(
    new EtaNotificationGate(
      new QueueNotificationProducer(new NotificationOutboxRepository(pool)),
    ),
    store,
  );
const cur = { sessionEpoch: 3, priorEpoch: 1 };
const snap = (
  o: Partial<EtaNotificationSnapshot>,
): EtaNotificationSnapshot => ({
  queueEntryId: entryId,
  revision: 1,
  estimatorVersion: 'eta/v1',
  sessionEpoch: 3,
  priorEpoch: 1,
  minWaitMinutes: 20,
  maxWaitMinutes: 40,
  queuePosition: 5,
  ...o,
});
const material = (revision: number) =>
  snap({ revision, minWaitMinutes: 40, maxWaitMinutes: 60 });
const outboxCount = async () =>
  Number(
    (
      await pool.query(
        'SELECT count(*) FROM notification_outbox WHERE clinic_id=$1',
        [clinicId],
      )
    ).rows[0].count,
  );

beforeAll(async () => migrate());
afterAll(async () => pool.end());
beforeEach(async () => {
  await pool.query(`TRUNCATE eta_notification_baselines, notification_outbox,
    queue_entries, patient_operational_records, consultation_sessions,
    doctor_clinics, doctor_profiles, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'enb-doc','Doc')`,
    [doctorUser],
  );
  for (const [id, key] of [
    [clinicId, 'enb-a'],
    [otherClinicId, 'enb-b'],
  ] as const) {
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES($1,$2,$2)`,
      [id, key],
    );
  }
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr')`,
    [doctorId, doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [clinicId, doctorId],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,now()::date,now()-interval '1 hour',now()+interval '2 hours','open')`,
    [sessionId, clinicId, doctorId],
  );
  const patientId = randomUUID();
  await pool.query(
    `INSERT INTO patient_operational_records
       (id,clinic_id,private_display_name,preferred_locale)
     VALUES($1,$2,'Guest','ar')`,
    [patientId, clinicId],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,
        registration_order,public_display_label)
     VALUES($1,$2,$3,$4,'waiting','walk_in',1,'ENB-1')`,
    [entryId, clinicId, sessionId, patientId],
  );
});

describe('ETA notification baseline, real PostgreSQL (#751)', () => {
  it('survives restart: a new coordinator instance continues from the stored baseline', async () => {
    expect(
      await coordinator().process({
        clinicId,
        latest: snap({}),
        currentEpochs: cur,
      }),
    ).toEqual({ status: 'baseline_recorded' });
    const r = await coordinator().process({
      clinicId,
      latest: material(2),
      currentEpochs: cur,
    });
    expect(r).toEqual({ status: 'enqueued', baselineAdvanced: true });
    expect((await store.load(clinicId, entryId))?.revision).toBe(2);
    expect(await outboxCount()).toBe(1);
  });

  it('concurrent identical submits produce exactly one outbox intent', async () => {
    await coordinator().process({
      clinicId,
      latest: snap({}),
      currentEpochs: cur,
    });
    await Promise.all(
      Array.from({ length: 6 }, () =>
        coordinator().process({
          clinicId,
          latest: material(2),
          currentEpochs: cur,
        }),
      ),
    );
    expect(await outboxCount()).toBe(1);
    expect((await store.load(clinicId, entryId))?.revision).toBe(2);
  });

  it('concurrent first submits with different revisions lose no material change', async () => {
    await Promise.all([
      coordinator().process({ clinicId, latest: snap({}), currentEpochs: cur }),
      coordinator().process({
        clinicId,
        latest: material(2),
        currentEpochs: cur,
      }),
    ]);
    // Whichever order won, revision 2 must end as baseline; revision 1 first
    // means revision 2 was gated against it and notified exactly once.
    expect((await store.load(clinicId, entryId))?.revision).toBe(2);
    expect(await outboxCount()).toBeLessThanOrEqual(1);
  });

  it('replays safely when the process crashed after enqueue but before advancing', async () => {
    await coordinator().process({
      clinicId,
      latest: snap({}),
      currentEpochs: cur,
    });
    await new EtaNotificationGate(
      new QueueNotificationProducer(new NotificationOutboxRepository(pool)),
    ).submit({
      clinicId,
      lastDelivered: snap({}),
      latest: material(2),
      currentEpochs: cur,
    });
    expect((await store.load(clinicId, entryId))?.revision).toBe(1);
    const r = await coordinator().process({
      clinicId,
      latest: material(2),
      currentEpochs: cur,
    });
    expect(r).toEqual({ status: 'enqueued', baselineAdvanced: true });
    expect(await outboxCount()).toBe(1);
  });

  it('never regresses the baseline: stale advance is a no-op and the trigger rejects direct rollback', async () => {
    await store.recordInitial(clinicId, snap({ revision: 5 }));
    expect(await store.advance(clinicId, snap({ revision: 4 }))).toBe(false);
    expect(await store.advance(clinicId, snap({ revision: 5 }))).toBe(false);
    await expect(
      pool.query(
        'UPDATE eta_notification_baselines SET revision=3 WHERE queue_entry_id=$1',
        [entryId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await store.load(clinicId, entryId))?.revision).toBe(5);
  });

  it('isolates clinics: another clinic cannot read or advance the baseline', async () => {
    await store.recordInitial(clinicId, snap({}));
    expect(await store.load(otherClinicId, entryId)).toBeNull();
    expect(await store.advance(otherClinicId, snap({ revision: 9 }))).toBe(
      false,
    );
    expect((await store.load(clinicId, entryId))?.revision).toBe(1);
  });

  it('rejects a baseline for an entry that belongs to a different clinic', async () => {
    await expect(
      store.recordInitial(otherClinicId, snap({})),
    ).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('stores only numeric/contract columns (no identity or contact data)', async () => {
    await store.recordInitial(clinicId, snap({}));
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='eta_notification_baselines' ORDER BY column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      'clinic_id',
      'estimator_version',
      'max_wait_minutes',
      'min_wait_minutes',
      'prior_epoch',
      'queue_entry_id',
      'queue_position',
      'revision',
      'session_epoch',
      'updated_at',
    ]);
  });
});
