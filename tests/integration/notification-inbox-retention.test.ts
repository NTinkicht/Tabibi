import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  VISIT_INBOX_RETENTION_MS,
  purgeExpiredVisitInboxItems,
} from '@/modules/notification-inbox/retention';
import { migrate } from '../../scripts/db/lib';

// TAB-P0-15: old visit-patient inbox rows are purged; recent visit rows and all
// account-scoped rows are not.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const NOW = new Date('2026-06-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1_000;
const OLD = VISIT_INBOX_RETENTION_MS + DAY;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ids = { clinic: randomUUID(), patient: randomUUID(), user: randomUUID() };

const addVisit = async (age: number, read = false): Promise<string> => {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO notification_inbox_items
       (id,clinic_id,subject_kind,patient_id,provider_idempotency_key,template_id,
        locale,direction,title,body,created_at,read_at)
     VALUES ($1,$2,'visit_patient',$3,$4,'turn_approaching.v1','fr','ltr','T','B',$5,$6)`,
    [id, ids.clinic, ids.patient, `k-${id}`, ago(age), read ? ago(age) : null],
  );
  return id;
};
const addAccount = async (age: number): Promise<string> => {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO notification_inbox_items
       (id,clinic_id,subject_kind,account_user_id,provider_idempotency_key,template_id,
        locale,direction,title,body,created_at)
     VALUES ($1,$2,'account',$3,$4,'turn_approaching.v1','fr','ltr','T','B',$5)`,
    [id, ids.clinic, ids.user, `k-${id}`, ago(age)],
  );
  return id;
};
const present = async (id: string) =>
  (await pool.query('SELECT 1 FROM notification_inbox_items WHERE id=$1', [id]))
    .rowCount === 1;

beforeAll(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE notification_inbox_items, clinics, users CASCADE');
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES ($1,'inbox-ret','Inbox Ret')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO patient_operational_records(id,clinic_id,private_display_name)
     VALUES ($1,$2,'Private')`,
    [ids.patient, ids.clinic],
  );
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES ($1,$2,'Acct')`,
    [ids.user, `inbox-ret-${ids.user}`],
  );
});
afterAll(() => pool.end());

describe('purgeExpiredVisitInboxItems', () => {
  it('deletes old read and unread visit rows, keeps recent visit rows and account rows', async () => {
    const oldUnread = await addVisit(OLD);
    const oldRead = await addVisit(OLD, true);
    const recent = await addVisit(VISIT_INBOX_RETENTION_MS - DAY);
    const oldAccount = await addAccount(OLD);
    expect(await purgeExpiredVisitInboxItems(pool, NOW)).toBe(2);
    expect(await present(oldUnread)).toBe(false);
    expect(await present(oldRead)).toBe(false);
    // Positive controls: the same sweep leaves these rows in place.
    expect(await present(recent)).toBe(true);
    expect(await present(oldAccount)).toBe(true);
  });

  it('is idempotent and bounded to one batch per call', async () => {
    const values = Array.from(
      { length: 501 },
      (_, i) =>
        `(gen_random_uuid(),$1,'visit_patient',$2,'bulk-${i}','t','fr','ltr','T','B',$3)`,
    ).join(',');
    await pool.query(
      `INSERT INTO notification_inbox_items
         (id,clinic_id,subject_kind,patient_id,provider_idempotency_key,template_id,
          locale,direction,title,body,created_at) VALUES ${values}`,
      [ids.clinic, ids.patient, ago(OLD)],
    );
    expect(await purgeExpiredVisitInboxItems(pool, NOW)).toBe(500);
    expect(await purgeExpiredVisitInboxItems(pool, NOW)).toBe(1);
    expect(await purgeExpiredVisitInboxItems(pool, NOW)).toBe(0);
  });

  it('keeps a row exactly inside the grace and deletes one at the boundary', async () => {
    const inside = await addVisit(VISIT_INBOX_RETENTION_MS - 1_000);
    const boundary = await addVisit(VISIT_INBOX_RETENTION_MS);
    expect(await purgeExpiredVisitInboxItems(pool, NOW)).toBe(1);
    expect(await present(inside)).toBe(true);
    expect(await present(boundary)).toBe(false);
  });
});
