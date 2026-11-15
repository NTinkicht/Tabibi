import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  entry: randomUUID(),
  patient: randomUUID(),
};
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

async function insert(
  over: Record<string, unknown> = {},
): Promise<string | null> {
  const row = {
    id: randomUUID(),
    clinic_id: ids.clinic,
    queue_entry_id: ids.entry,
    endpoint_hash: HASH,
    sealed_subscription: 'gps1.x.y.z',
    locale: 'fr',
    created_at: '2026-09-09T09:00:00Z',
    expires_at: '2026-09-09T20:00:00Z',
    revoked_at: null,
    revocation_reason: null,
    ...over,
  };
  const cols = Object.keys(row);
  try {
    await pool.query(
      `INSERT INTO guest_push_subscriptions(${cols.join(',')})
       VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row),
    );
    return null;
  } catch (error) {
    return (error as { constraint?: string }).constraint ?? 'other';
  }
}

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE guest_push_subscriptions,audit_events,
    queue_command_receipts,queue_reorder_receipts,queue_registration_receipts,queue_entries,
    patient_operational_records,session_command_receipts,consultation_sessions,schedule_templates,
    doctor_clinics,doctor_profiles,clinic_memberships,clinics,users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'push-doctor','Doctor')`,
    [ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
     ($1,'push-one','Push One'),($2,'push-two','Push Two')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
     (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,'2026-09-09','2026-09-09T09:00Z','2026-09-09T12:00Z','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
     (id,clinic_id,private_display_name,contact_phone) VALUES($1,$2,'Guest','0555000000')`,
    [ids.patient, ids.clinic],
  );
  await pool.query(
    `INSERT INTO queue_entries
     (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
     VALUES($1,$2,$3,$4,'waiting','walk_in',1,'P-001')`,
    [ids.entry, ids.clinic, ids.session, ids.patient],
  );
});
afterAll(async () => pool.end());

describe('guest_push_subscriptions constraints', () => {
  it('accepts an active sealed binding (positive control)', async () => {
    expect(await insert()).toBeNull();
  });

  it('keeps one active row per endpoint hash but allows reuse after revocation', async () => {
    expect(await insert()).toBeNull();
    expect(await insert()).toBe('guest_push_subscriptions_active_endpoint_uq');
    expect(await insert({ endpoint_hash: HASH2 })).toBeNull();
    expect(
      await insert({
        revoked_at: '2026-09-09T10:00:00Z',
        revocation_reason: 'gone',
        sealed_subscription: null,
      }),
    ).toBeNull();
  });

  it('refuses a revoked row that still holds sealed material', async () => {
    expect(
      await insert({
        revoked_at: '2026-09-09T10:00:00Z',
        revocation_reason: 'expired',
      }),
    ).toBe('guest_push_subscriptions_state');
  });

  it('refuses an active row without sealed material and a revoked row without a reason', async () => {
    expect(await insert({ sealed_subscription: null })).toBe(
      'guest_push_subscriptions_state',
    );
    expect(
      await insert({
        revoked_at: '2026-09-09T10:00:00Z',
        sealed_subscription: null,
      }),
    ).toBe('guest_push_subscriptions_state');
    expect(await insert({ revocation_reason: 'gone' })).toBe(
      'guest_push_subscriptions_state',
    );
  });

  it('refuses unknown reasons, bad hashes, bad locales and over-long lifetimes', async () => {
    expect(
      await insert({
        revoked_at: '2026-09-09T10:00:00Z',
        revocation_reason: 'other',
        sealed_subscription: null,
      }),
    ).toBe('guest_push_subscriptions_revocation_reason_check');
    expect(await insert({ endpoint_hash: 'A'.repeat(64) })).toBe(
      'guest_push_subscriptions_endpoint_hash_check',
    );
    expect(await insert({ locale: 'en' })).toBe(
      'guest_push_subscriptions_locale_check',
    );
    expect(await insert({ expires_at: '2026-09-10T09:00:01Z' })).toBe(
      'guest_push_subscriptions_expiry_max',
    );
    expect(await insert({ expires_at: '2026-09-09T09:00:00Z' })).toBe(
      'guest_push_subscriptions_expiry_order',
    );
  });

  it('binds a subscription to an entry of the same clinic', async () => {
    expect(await insert({ clinic_id: ids.otherClinic })).toBe(
      'guest_push_subscriptions_queue_entry_id_clinic_id_fkey',
    );
    expect(await insert({ queue_entry_id: randomUUID() })).toBe(
      'guest_push_subscriptions_queue_entry_id_clinic_id_fkey',
    );
  });
});
