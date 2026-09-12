import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NotificationPreferenceConflictError,
  NotificationPreferenceRepository,
  NotificationPreferenceValidationError,
} from '@/modules/notification-preferences';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  sessionA: randomUUID(),
  sessionB: randomUUID(),
  patientA: randomUUID(),
  patientB: randomUUID(),
  entryA: randomUUID(),
  entryB: randomUUID(),
};

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(
    'TRUNCATE notification_preference_receipts, notification_preferences, clinics, users CASCADE',
  );
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name)
     VALUES($1,'pref-doctor','Doctor')`,
    [ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
       ($1,'pref-a','Preference A'),($2,'pref-b','Preference B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name)
     VALUES($1,$2,'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id)
     VALUES($1,$3),($2,$3)`,
    [ids.clinicA, ids.clinicB, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status) VALUES
       ($1,$3,$5,'2026-09-12','2026-09-12T09:00Z','2026-09-12T12:00Z','open'),
       ($2,$4,$5,'2026-09-13','2026-09-13T09:00Z','2026-09-13T12:00Z','planned')`,
    [ids.sessionA, ids.sessionB, ids.clinicA, ids.clinicB, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records(id,clinic_id,private_display_name) VALUES
       ($1,$3,'Private A'),($2,$4,'Private B')`,
    [ids.patientA, ids.patientB, ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label) VALUES
       ($1,$3,$5,$7,'waiting','walk_in',1,'A-001'),
       ($2,$4,$6,$8,'waiting','walk_in',1,'B-001')`,
    [
      ids.entryA,
      ids.entryB,
      ids.clinicA,
      ids.clinicB,
      ids.sessionA,
      ids.sessionB,
      ids.patientA,
      ids.patientB,
    ],
  );
});
afterAll(() => pool.end());

function change(overrides: Record<string, unknown> = {}) {
  return {
    clinicId: ids.clinicA,
    subjectKind: 'visit_patient' as const,
    subjectId: ids.patientA,
    channel: 'sms' as const,
    preferenceState: 'enabled' as const,
    consentState: 'granted' as const,
    idempotencyKey: 'grant-sms',
    ...overrides,
  };
}

describe('notification preference repository', () => {
  it('creates and reads a privacy-minimal clinic-scoped preference', async () => {
    const repository = new NotificationPreferenceRepository(pool);
    const created = await repository.change(change());
    expect(
      await repository.get(ids.clinicA, 'visit_patient', ids.patientA, 'sms'),
    ).toEqual(created);
    expect(
      await repository.get(ids.clinicB, 'visit_patient', ids.patientA, 'sms'),
    ).toBeNull();
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('notification_preferences','notification_preference_receipts')`,
    );
    expect(columns.rows.map((row) => row.column_name).join(' ')).not.toMatch(
      /phone|email_address|contact_value|payload|token|credential|clinical|exception|secret|bearer|exchange/,
    );
  });

  it('makes exact retries idempotent and rejects conflicting key reuse', async () => {
    const repository = new NotificationPreferenceRepository(pool);
    const first = await repository.change(change());
    expect(await repository.change(change())).toEqual(first);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int count FROM notification_preferences',
        )
      ).rows[0]?.count,
    ).toBe(1);
    await expect(
      repository.change(change({ preferenceState: 'disabled' })),
    ).rejects.toBeInstanceOf(NotificationPreferenceConflictError);
  });

  it('enforces revisions and explicit consent transitions', async () => {
    const repository = new NotificationPreferenceRepository(pool);
    const first = await repository.change(change());
    const revoked = await repository.change(
      change({
        consentState: 'revoked',
        preferenceState: 'disabled',
        expectedRevision: first.revision,
        idempotencyKey: 'revoke-sms',
      }),
    );
    expect(revoked.revision).toBe(2);
    await expect(
      repository.change(
        change({
          consentState: 'denied',
          preferenceState: 'disabled',
          expectedRevision: revoked.revision,
          idempotencyKey: 'invalid-transition',
        }),
      ),
    ).rejects.toBeInstanceOf(NotificationPreferenceValidationError);
    await expect(
      repository.change(
        change({ expectedRevision: 1, idempotencyKey: 'stale' }),
      ),
    ).rejects.toBeInstanceOf(NotificationPreferenceConflictError);
    await expect(
      repository.change(
        change({
          consentState: 'revoked',
          preferenceState: 'disabled',
          idempotencyKey: 'same-state',
        }),
      ),
    ).resolves.toEqual(revoked);
    await expect(
      repository.change(change({ idempotencyKey: 'blind-change' })),
    ).rejects.toBeInstanceOf(NotificationPreferenceConflictError);
    await expect(
      repository.change(
        change({
          consentState: 'granted',
          preferenceState: 'enabled',
          expectedRevision: revoked.revision,
          idempotencyKey: 'restore-grant',
        }),
      ),
    ).resolves.toMatchObject({ revision: 3, consentState: 'granted' });
  });

  it('rejects unknown channels, invalid consent combinations and cross-clinic writes', async () => {
    const repository = new NotificationPreferenceRepository(pool);
    await expect(
      repository.change(change({ channel: 'fax' })),
    ).rejects.toBeInstanceOf(NotificationPreferenceValidationError);
    await expect(
      repository.change(change({ consentState: 'not_required' })),
    ).rejects.toBeInstanceOf(NotificationPreferenceValidationError);
    await expect(
      repository.change(
        change({
          clinicId: ids.clinicB,
          idempotencyKey: 'cross-clinic',
        }),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    expect(
      await repository.get(ids.clinicA, 'visit_patient', ids.patientA, 'sms'),
    ).toBeNull();
  });

  it('serializes competing first writes without duplicate preferences', async () => {
    const repository = new NotificationPreferenceRepository(pool);
    const results = await Promise.all([
      repository.change(change({ idempotencyKey: 'race-a' })),
      repository.change(change({ idempotencyKey: 'race-b' })),
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(results[0]?.revision).toBe(1);
    expect(results[1]?.revision).toBe(1);
  });
});
