import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { STAFF_AUTH_RETENTION_MS } from '@/modules/identity/staff-auth-retention';
import { RATE_LIMIT_BUCKET_RETENTION_MS } from '@/modules/identity/rate-limit-retention';
import { VISIT_INBOX_RETENTION_MS } from '@/modules/notification-inbox/retention';
import { runRetentionSweep } from '@/modules/maintenance/retention-sweep';

// TAB-P0-15: the sweep runner really deletes stale rows and keeps live ones.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const NOW = new Date();
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const tag = randomUUID();

const addBucket = (key: string, startedAgo: number) =>
  pool.query(
    `INSERT INTO staff_sign_in_rate_limit_buckets
       (bucket_key, window_started_at, request_count, updated_at)
     VALUES ($1, $2, 1, $2)`,
    [key, new Date(NOW.getTime() - startedAgo)],
  );
const present = async (key: string) =>
  (
    await pool.query(
      'SELECT 1 FROM staff_sign_in_rate_limit_buckets WHERE bucket_key=$1',
      [key],
    )
  ).rowCount === 1;

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await pool.query('DELETE FROM users WHERE auth_subject=$1', [`sweep-${tag}`]);
  await pool.query(
    'DELETE FROM staff_sign_in_rate_limit_buckets WHERE bucket_key LIKE $1',
    [`sweep-${tag}-%`],
  );
  await pool.end();
});

describe('retention sweep runner', () => {
  it('deletes a stale bucket and an expired session, keeps live rows', async () => {
    const stale = `sweep-${tag}-stale`;
    const live = `sweep-${tag}-live`;
    await addBucket(stale, RATE_LIMIT_BUCKET_RETENTION_MS + HOUR);
    await addBucket(live, 60_000);
    const user = randomUUID();
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1,$2,'Sweep')`,
      [user, `sweep-${tag}`],
    );
    const addSession = (expiresAgo: number) => {
      const verifier = randomBytes(32);
      return pool
        .query(
          `INSERT INTO staff_sessions (verifier, user_id, issued_at, expires_at)
           VALUES ($1,$2,$3,$4)`,
          [
            verifier,
            user,
            new Date(NOW.getTime() - expiresAgo - 30 * DAY),
            new Date(NOW.getTime() - expiresAgo),
          ],
        )
        .then(() => verifier);
    };
    const oldSession = await addSession(STAFF_AUTH_RETENTION_MS + DAY);
    const liveSession = await addSession(-DAY);
    const result = await runRetentionSweep(pool, NOW);
    expect(result.failed).toEqual([]);
    expect(result.deleted.sign_in_rate_limit).toBeGreaterThanOrEqual(1);
    expect(await present(stale)).toBe(false);
    // Positive control: the live bucket survives the same sweep.
    expect(await present(live)).toBe(true);
    const sessionPresent = async (v: Buffer) =>
      (await pool.query('SELECT 1 FROM staff_sessions WHERE verifier=$1', [v]))
        .rowCount === 1;
    expect(await sessionPresent(oldSession)).toBe(false);
    expect(await sessionPresent(liveSession)).toBe(true);
  });

  it('deletes an old visit inbox row and keeps a recent one', async () => {
    const clinic = randomUUID();
    const patient = randomUUID();
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES ($1,$2,'Sweep Inbox')`,
      [clinic, `sweep-inbox-${tag}`],
    );
    await pool.query(
      `INSERT INTO patient_operational_records(id,clinic_id,private_display_name)
       VALUES ($1,$2,'Private')`,
      [patient, clinic],
    );
    const add = async (age: number) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO notification_inbox_items
           (id,clinic_id,subject_kind,patient_id,provider_idempotency_key,template_id,
            locale,direction,title,body,created_at)
         VALUES ($1,$2,'visit_patient',$3,$4,'t','fr','ltr','T','B',$5)`,
        [id, clinic, patient, `sweep-${id}`, new Date(NOW.getTime() - age)],
      );
      return id;
    };
    const old = await add(VISIT_INBOX_RETENTION_MS + DAY);
    const recent = await add(DAY);
    const result = await runRetentionSweep(pool, NOW);
    expect(result.failed).toEqual([]);
    expect(result.deleted.visit_inbox).toBeGreaterThanOrEqual(1);
    const has = async (id: string) =>
      (
        await pool.query('SELECT 1 FROM notification_inbox_items WHERE id=$1', [
          id,
        ])
      ).rowCount === 1;
    expect(await has(old)).toBe(false);
    expect(await has(recent)).toBe(true);
    await pool.query(
      'DELETE FROM notification_inbox_items WHERE clinic_id=$1',
      [clinic],
    );
    await pool.query(
      'DELETE FROM patient_operational_records WHERE clinic_id=$1',
      [clinic],
    );
    await pool.query('DELETE FROM clinics WHERE id=$1', [clinic]);
  });
});
