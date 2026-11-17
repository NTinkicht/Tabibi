import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  REVOKED_PUSH_BINDING_RETENTION_MS,
  purgeRevokedPushBindings,
} from '@/modules/guest-push/retention';
import { runRetentionSweep } from '@/modules/maintenance/retention-sweep';

// TAB-P0-15: revoked guest push bindings are purged after the grace; active
// bindings never are.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const NOW = new Date('2026-06-01T12:00:00Z');
const HOUR = 60 * 60 * 1_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ids = {
  clinic: randomUUID(),
  user: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  patient: randomUUID(),
  entry: randomUUID(),
};

// created_at is two days before the revocation so the row constraints hold for
// any revoked_at; an active row must expire within 24h of creation.
const addBinding = async (revokedAgo: number | null) => {
  const id = randomUUID();
  const revokedAt = revokedAgo === null ? null : ago(revokedAgo);
  const createdAt = new Date((revokedAt ?? ago(HOUR)).getTime() - 2 * HOUR);
  await pool.query(
    `INSERT INTO guest_push_subscriptions
       (id,clinic_id,queue_entry_id,endpoint_hash,sealed_subscription,locale,
        created_at,expires_at,revoked_at,revocation_reason)
     VALUES ($1,$2,$3,$4,$5,'fr',$6,$7,$8,$9)`,
    [
      id,
      ids.clinic,
      ids.entry,
      id.replaceAll('-', '').padEnd(64, '0'),
      revokedAt === null ? 'sealed' : null,
      createdAt,
      new Date(createdAt.getTime() + HOUR),
      revokedAt,
      revokedAt === null ? null : 'expired',
    ],
  );
  return id;
};
const remaining = async () =>
  (
    await pool.query<{ id: string }>('SELECT id FROM guest_push_subscriptions')
  ).rows.map((r) => r.id);

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE guest_push_subscriptions,queue_entries,
    patient_operational_records,consultation_sessions,doctor_clinics,
    doctor_profiles,clinics,users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'push-ret','Doctor')`,
    [ids.user],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'push-ret','Push Retention')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Doctor')`,
    [ids.doctor, ids.user],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,'2026-05-31','2026-05-31T09:00Z','2026-05-31T12:00Z','closed')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records(id,clinic_id,private_display_name)
     VALUES($1,$2,'Guest')`,
    [ids.patient, ids.clinic],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
     VALUES($1,$2,$3,$4,'waiting','walk_in',1,'P-001')`,
    [ids.entry, ids.clinic, ids.session, ids.patient],
  );
});
afterAll(async () => {
  await pool.query(`TRUNCATE guest_push_subscriptions,queue_entries,
    patient_operational_records,consultation_sessions,doctor_clinics,
    doctor_profiles,clinics,users CASCADE`);
  await pool.end();
});

describe('revoked guest push binding retention', () => {
  it('deletes revoked rows past the grace and keeps the rest', async () => {
    const old = await addBinding(REVOKED_PUSH_BINDING_RETENTION_MS + HOUR);
    const atCutoff = await addBinding(REVOKED_PUSH_BINDING_RETENTION_MS);
    const recent = await addBinding(REVOKED_PUSH_BINDING_RETENTION_MS - HOUR);
    const active = await addBinding(null);
    expect(await purgeRevokedPushBindings(pool, NOW)).toBe(2);
    expect((await remaining()).sort()).toEqual([recent, active].sort());
    expect(await remaining()).not.toContain(old);
    expect(await remaining()).not.toContain(atCutoff);
  });

  it('never deletes an active binding however old its creation time', async () => {
    const active = await addBinding(null);
    await pool.query(
      `UPDATE guest_push_subscriptions
          SET created_at=$2, expires_at=$3 WHERE id=$1`,
      [active, ago(400 * 24 * HOUR), ago(400 * 24 * HOUR - HOUR)],
    );
    expect(await purgeRevokedPushBindings(pool, NOW)).toBe(0);
    expect(await remaining()).toEqual([active]);
  });

  it('deletes at most one bounded batch per call', async () => {
    const old = REVOKED_PUSH_BINDING_RETENTION_MS + HOUR;
    for (let i = 0; i < 503; i += 1) await addBinding(old);
    expect(await purgeRevokedPushBindings(pool, NOW)).toBe(500);
    expect(await purgeRevokedPushBindings(pool, NOW)).toBe(3);
    expect(await remaining()).toEqual([]);
  });

  it('skips a row locked by a concurrent transaction instead of waiting', async () => {
    const locked = await addBinding(REVOKED_PUSH_BINDING_RETENTION_MS + HOUR);
    const free = await addBinding(REVOKED_PUSH_BINDING_RETENTION_MS + HOUR);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM guest_push_subscriptions WHERE id=$1 FOR UPDATE',
        [locked],
      );
      expect(await purgeRevokedPushBindings(pool, NOW)).toBe(1);
      expect(await remaining()).toEqual([locked]);
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    expect(free).not.toBe(locked);
    expect(await purgeRevokedPushBindings(pool, NOW)).toBe(1);
  });

  it('runs inside the retention sweep and reports the deleted count', async () => {
    await addBinding(REVOKED_PUSH_BINDING_RETENTION_MS + HOUR);
    const active = await addBinding(null);
    const result = await runRetentionSweep(pool, NOW);
    expect(result.failed).toEqual([]);
    expect(result.deleted.push_binding).toBe(1);
    expect(await remaining()).toEqual([active]);
  });
});
