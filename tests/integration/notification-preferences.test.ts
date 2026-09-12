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
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'pref-doctor','Doctor');
     INSERT INTO clinics(id,tenant_key,name) VALUES
       ($2,'pref-a','Preference A'),($3,'pref-b','Preference B');
     INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($4,$1,'Doctor');
     INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($2,$4),($3,$4);
     INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status) VALUES
       ($5,$2,$4,'2026-09-12','2026-09-12T09:00Z','2026-09-12T12:00Z','open'),
       ($6,$3,$4,'2026-09-13','2026-09-13T09:00Z','2026-09-13T12:00Z','planned');
     INSERT INTO patient_operational_records(id,clinic_id,private_display_name) VALUES
       ($7,$2,'Private A'),($8,$3,'Private B');
     INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label) VALUES
       ($9,$2,$5,$7,'waiting','walk_in',1,'A-001'),
       ($10,$3,$6,$8,'waiting','walk_in',1,'B-001')`,
    [
      ids.doctorUser,
      ids.clinicA,
      ids.clinicB,
      ids.doctor,
      ids.sessionA,
      ids.sessionB,
      ids.patientA,
      ids.patientB,
      ids.entryA,
      ids.entryB,
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
