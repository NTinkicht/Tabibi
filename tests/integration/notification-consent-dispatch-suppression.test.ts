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
  NotificationPreferenceDeliveryContextResolver,
  type NotificationProviderAdapter,
} from '@/modules/notification-domain';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import { NotificationDispatchEligibilityRepository } from '@/modules/notification-outbox/dispatch-eligibility';
import { NotificationPreferenceRepository } from '@/modules/notification-preferences';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinic: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  patient: randomUUID(),
  entry: randomUUID(),
};

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(
    'TRUNCATE notification_outbox, notification_preference_receipts, notification_preferences, clinics, users CASCADE',
  );
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name)
     VALUES($1,'suppression-doctor','Doctor')`,
    [ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name)
     VALUES($1,'suppression-clinic','Suppression Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name)
     VALUES($1,$2,'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,'2026-09-12','2026-09-12T09:00Z','2026-09-12T12:00Z','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records(id,clinic_id,private_display_name)
     VALUES($1,$2,'Private Patient')`,
    [ids.patient, ids.clinic],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
     VALUES($1,$2,$3,$4,'waiting','walk_in',1,'A-001')`,
    [ids.entry, ids.clinic, ids.session, ids.patient],
  );
});
afterAll(async () => pool.end());

function enqueueInput(key: string) {
  return {
    clinicId: ids.clinic,
    queueEntryId: ids.entry,
    logicalTargetKey: `queue-entry:${key}`,
    eventKey: 'turn_approaching',
    intentVersion: 1,
    idempotencyKey: `suppression:${key}`,
    payload: { locale: 'fr', places: 1 },
  };
}

function context(preferences: NotificationPreferenceRepository) {
  return new NotificationPreferenceDeliveryContextResolver(
    {
      resolveTarget: async () => ({
        subjectKind: 'visit_patient' as const,
        subjectId: ids.patient,
        channel: 'sms' as const,
      }),
    },
    preferences,
  );
}

describe('notification consent-aware dispatch suppression', () => {
  it('persists missing authorization as terminal suppression and never calls provider', async () => {
    const outbox = new NotificationOutboxRepository(pool);
    const preferences = new NotificationPreferenceRepository(pool);
    const scanner = new NotificationDispatchEligibilityRepository(pool);
    const queued = await outbox.enqueue(enqueueInput('missing'));
    const dispatch = vi.fn<NotificationProviderAdapter['dispatch']>(
      async () => ({
        kind: 'delivered',
      }),
    );
    const service = new NotificationDispatchService(
      outbox,
      { dispatch },
      context(preferences),
    );

    await expect(
      service.dispatchOne({ clinicId: ids.clinic, intentId: queued.id }),
    ).resolves.toMatchObject({
      status: 'suppressed',
      suppressionReason: 'preference_missing',
    });
    expect(dispatch).not.toHaveBeenCalled();

    const persisted = await pool.query<{
      state: string;
      dispatch_outcome_code: string | null;
      next_attempt_at: Date | null;
      dispatch_claim_token: string | null;
    }>(
      `SELECT state, dispatch_outcome_code, next_attempt_at, dispatch_claim_token
         FROM notification_outbox WHERE id=$1`,
      [queued.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      state: 'suppressed',
      dispatch_outcome_code: 'preference_missing',
      next_attempt_at: null,
      dispatch_claim_token: null,
    });
    await expect(
      scanner.listEligible({ clinicId: ids.clinic, limit: 10 }),
    ).resolves.toEqual([]);
    await expect(
      outbox.claimPendingIntent({
        clinicId: ids.clinic,
        intentId: queued.id,
        leaseMs: 60_000,
      }),
    ).resolves.toBeNull();
  });

  it('delivers when granted and suppresses a later intent after revocation', async () => {
    const outbox = new NotificationOutboxRepository(pool);
    const preferences = new NotificationPreferenceRepository(pool);
    const granted = await preferences.change({
      clinicId: ids.clinic,
      subjectKind: 'visit_patient',
      subjectId: ids.patient,
      channel: 'sms',
      preferenceState: 'enabled',
      consentState: 'granted',
      idempotencyKey: 'grant-sms',
    });
    const dispatch = vi.fn<NotificationProviderAdapter['dispatch']>(
      async () => ({
        kind: 'delivered',
        code: 'accepted',
      }),
    );
    const service = new NotificationDispatchService(
      outbox,
      { dispatch },
      context(preferences),
    );

    const authorized = await outbox.enqueue(enqueueInput('authorized'));
    await expect(
      service.dispatchOne({ clinicId: ids.clinic, intentId: authorized.id }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(dispatch).toHaveBeenCalledTimes(1);

    await preferences.change({
      clinicId: ids.clinic,
      subjectKind: 'visit_patient',
      subjectId: ids.patient,
      channel: 'sms',
      preferenceState: 'disabled',
      consentState: 'revoked',
      expectedRevision: granted.revision,
      idempotencyKey: 'revoke-sms',
    });

    const revoked = await outbox.enqueue(enqueueInput('revoked'));
    await expect(
      service.dispatchOne({ clinicId: ids.clinic, intentId: revoked.id }),
    ).resolves.toMatchObject({
      status: 'suppressed',
      suppressionReason: 'preference_disabled',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('fails closed when target identity cannot resolve to a matching clinic preference', async () => {
    const outbox = new NotificationOutboxRepository(pool);
    const preferences = new NotificationPreferenceRepository(pool);
    const queued = await outbox.enqueue(enqueueInput('mismatch'));
    const dispatch = vi.fn<NotificationProviderAdapter['dispatch']>(
      async () => ({
        kind: 'delivered',
      }),
    );
    const mismatchedContext = new NotificationPreferenceDeliveryContextResolver(
      {
        resolveTarget: async () => ({
          subjectKind: 'visit_patient' as const,
          subjectId: randomUUID(),
          channel: 'sms' as const,
        }),
      },
      preferences,
    );
    const service = new NotificationDispatchService(
      outbox,
      { dispatch },
      mismatchedContext,
    );

    await expect(
      service.dispatchOne({ clinicId: ids.clinic, intentId: queued.id }),
    ).resolves.toMatchObject({ status: 'suppressed' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
