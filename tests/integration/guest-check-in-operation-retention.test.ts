import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  CHECK_IN_OPERATION_RETENTION_MS,
  purgeExpiredGuestCheckInOperations,
} from '@/modules/public-guest-booking-check-in/retention';
import { runRetentionSweep } from '@/modules/maintenance/retention-sweep';

// TAB-P0-15: check-in idempotency rows of a credential that has been dead (expired
// or revoked) past the grace are purged; rows of a live or recently dead one never.
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
const TRUNCATE = `TRUNCATE public_guest_check_in_operations,guest_credentials,
  queue_entries,patient_operational_records,consultation_sessions,doctor_clinics,
  doctor_profiles,clinics,users CASCADE`;

// A credential lives at most 24h, so issue it 2h before the earlier of its end
// points. expiresAgo / revokedAgo are ms before NOW (negative = in the future).
// A live credential is unique per queue entry and class, so each gets its own entry.
let entryCount = 1;
const addOperation = async (expiresAgo: number, revokedAgo: number | null) => {
  const credential = randomUUID();
  const entry = randomUUID();
  entryCount += 1;
  await pool.query(
    `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
     VALUES($1,$2,$3,$4,'waiting','walk_in',$5,$6)`,
    [
      entry,
      ids.clinic,
      ids.session,
      ids.patient,
      entryCount,
      `P-${entryCount}`,
    ],
  );
  const issued = ago(Math.max(expiresAgo, revokedAgo ?? expiresAgo) + 2 * HOUR);
  await pool.query(
    `INSERT INTO guest_credentials
       (id,clinic_id,session_id,queue_entry_id,bearer_verifier,issued_at,
        expires_at,revoked_at,credential_class)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'booking')`,
    [
      credential,
      ids.clinic,
      ids.session,
      entry,
      credential.replaceAll('-', '').padEnd(64, '0'),
      issued,
      ago(expiresAgo),
      revokedAgo === null ? null : ago(revokedAgo),
    ],
  );
  await pool.query(
    `INSERT INTO public_guest_check_in_operations (credential_id,operation_id)
     VALUES ($1,$2)`,
    [credential, `op-${credential}`],
  );
  return credential;
};
const remaining = async () =>
  (
    await pool.query<{ credential_id: string }>(
      'SELECT credential_id FROM public_guest_check_in_operations',
    )
  ).rows.map((r) => r.credential_id);

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  await pool.query(TRUNCATE);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'ci-ret','Doctor')`,
    [ids.user],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'ci-ret','Check-in Retention')`,
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
  await pool.query(TRUNCATE);
  await pool.end();
});

const RET = CHECK_IN_OPERATION_RETENTION_MS;

describe('guest check-in operation retention', () => {
  it('deletes rows of credentials dead past the grace and keeps the rest', async () => {
    const old = await addOperation(RET + HOUR, null);
    const atCutoff = await addOperation(RET, null);
    const recent = await addOperation(RET - HOUR, null);
    const live = await addOperation(-HOUR, null);
    expect(await purgeExpiredGuestCheckInOperations(pool, NOW)).toBe(2);
    expect((await remaining()).sort()).toEqual([recent, live].sort());
    expect(await remaining()).not.toContain(old);
    expect(await remaining()).not.toContain(atCutoff);
  });

  it('treats an old revocation as dead even when expiry is still inside the grace', async () => {
    const revoked = await addOperation(RET - HOUR, RET + HOUR);
    const revokedRecently = await addOperation(-HOUR, HOUR);
    expect(await purgeExpiredGuestCheckInOperations(pool, NOW)).toBe(1);
    expect(await remaining()).toEqual([revokedRecently]);
    expect(await remaining()).not.toContain(revoked);
  });

  it('never deletes the rows of a live credential however old the operation', async () => {
    const live = await addOperation(-HOUR, null);
    await pool.query(
      `UPDATE public_guest_check_in_operations SET completed_at=$1`,
      [ago(400 * 24 * HOUR)],
    );
    expect(await purgeExpiredGuestCheckInOperations(pool, NOW)).toBe(0);
    expect(await remaining()).toEqual([live]);
  });

  it('deletes at most one bounded batch per call', async () => {
    const credential = await addOperation(RET + HOUR, null);
    await pool.query(
      `INSERT INTO public_guest_check_in_operations (credential_id,operation_id)
       SELECT $1, 'bulk-' || g FROM generate_series(1, 502) g`,
      [credential],
    );
    expect(await purgeExpiredGuestCheckInOperations(pool, NOW)).toBe(500);
    expect(await purgeExpiredGuestCheckInOperations(pool, NOW)).toBe(3);
    expect(await remaining()).toEqual([]);
  });

  it('skips a row locked by a concurrent transaction instead of waiting', async () => {
    const locked = await addOperation(RET + HOUR, null);
    const free = await addOperation(RET + HOUR, null);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM public_guest_check_in_operations WHERE credential_id=$1 FOR UPDATE',
        [locked],
      );
      expect(await purgeExpiredGuestCheckInOperations(pool, NOW)).toBe(1);
      expect(await remaining()).toEqual([locked]);
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    expect(free).not.toBe(locked);
    expect(await purgeExpiredGuestCheckInOperations(pool, NOW)).toBe(1);
  });

  it('runs inside the retention sweep and reports the deleted count', async () => {
    await addOperation(RET + HOUR, null);
    const live = await addOperation(-HOUR, null);
    const result = await runRetentionSweep(pool, NOW);
    expect(result.failed).toEqual([]);
    expect(result.deleted.guest_check_in_operation).toBe(1);
    expect(await remaining()).toEqual([live]);
  });
});
