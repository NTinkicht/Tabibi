import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GUEST_EXCHANGE_RETENTION_MS,
  purgeExpiredGuestExchangeArtifacts,
} from '@/modules/guest-access/retention';
import {
  GuestAccessRejectedError,
  GuestAccessService,
} from '@/modules/guest-access';
import { migrate } from '../../scripts/db/lib';

// TAB-P0-15: long-expired guest exchange IDs and terminal link intents are purged;
// live, recently expired and pending ones never are.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const NOW = new Date('2026-06-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1_000;
const MINUTE = 60 * 1_000;
const OLD = GUEST_EXCHANGE_RETENTION_MS + DAY;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ids = {
  clinic: randomUUID(),
  actor: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  entry: randomUUID(),
  patient: randomUUID(),
};
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const target = {
  clinicId: ids.clinic,
  sessionId: ids.session,
  queueEntryId: ids.entry,
};

// expiredAgo may be negative (still live). created_at keeps the 10 minute TTL checks.
const addExchange = (
  expiredAgo: number,
  consumed = false,
  seed: string = randomUUID(),
) =>
  pool.query(
    `INSERT INTO guest_exchange_ids
       (id,clinic_id,session_id,queue_entry_id,issued_by_user_id,exchange_verifier,
        contact_kind,created_at,expires_at,consumed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'phone',$7,$8,$9)`,
    [
      randomUUID(),
      ids.clinic,
      ids.session,
      ids.entry,
      ids.actor,
      sha(seed),
      ago(expiredAgo + 5 * MINUTE),
      ago(expiredAgo),
      consumed ? ago(expiredAgo + MINUTE) : null,
    ],
  );
const addIntent = (state: string, expiredAgo: number) =>
  pool.query(
    `INSERT INTO guest_link_intents
       (id,clinic_id,queue_entry_id,intent,state,envelope_ciphertext,created_at,expires_at,scrubbed_at)
     VALUES ($1,$2,$3,'initial',$4,$5,$6,$7,$8)`,
    [
      randomUUID(),
      ids.clinic,
      ids.entry,
      state,
      state === 'pending' ? 'ciphertext' : null,
      ago(expiredAgo + 5 * MINUTE),
      ago(expiredAgo),
      state === 'pending' ? null : ago(expiredAgo),
    ],
  );
const count = async (table: string) =>
  Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE guest_credentials,guest_exchange_ids,guest_link_intents,
    appointment_recovery_receipts,appointment_lifecycle_receipts,appointment_booking_receipts,
    appointments,audit_events,queue_command_receipts,queue_reorder_receipts,
    queue_registration_receipts,queue_entries,patient_operational_records,
    session_command_receipts,consultation_sessions,schedule_templates,doctor_clinics,
    doctor_profiles,clinic_memberships,clinics,users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
     ($1,'gx-actor','Reception'),($2,'gx-doctor','Doctor')`,
    [ids.actor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES ($1,'gx-one','Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
     VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.actor],
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
     VALUES($1,$2,$3,'2026-06-01','2026-06-01T09:00Z','2026-06-01T15:00Z','open')`,
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
     VALUES($1,$2,$3,$4,'waiting','walk_in',1,'G-001')`,
    [ids.entry, ids.clinic, ids.session, ids.patient],
  );
});
afterAll(async () => {
  await pool.end();
});

describe('purgeExpiredGuestExchangeArtifacts', () => {
  it('deletes long-expired exchange IDs and terminal intents, keeping live, recent and pending ones', async () => {
    await addExchange(OLD); // expired long ago: purged
    await addExchange(OLD, true); // consumed and expired long ago: purged
    await addExchange(-MINUTE); // live: kept
    await addExchange(2 * DAY); // expired recently: kept
    await addIntent('delivered', OLD); // purged
    await addIntent('dead_letter', OLD); // purged
    await addIntent('expired', OLD); // purged
    await addIntent('delivered', 2 * DAY); // recent: kept
    await addIntent('pending', -MINUTE); // live pending: kept
    await addIntent('pending', OLD); // stale pending: left to the scrub worker
    expect(await purgeExpiredGuestExchangeArtifacts(pool, NOW)).toEqual({
      exchangeIds: 2,
      linkIntents: 3,
    });
    expect(await count('guest_exchange_ids')).toBe(2);
    expect(await count('guest_link_intents')).toBe(3);
    expect(await purgeExpiredGuestExchangeArtifacts(pool, NOW)).toEqual({
      exchangeIds: 0,
      linkIntents: 0,
    });
  });

  it('deletes only the due rows, keeping the grace boundary row', async () => {
    await addExchange(GUEST_EXCHANGE_RETENTION_MS); // exactly at cutoff: due
    await addExchange(GUEST_EXCHANGE_RETENTION_MS - 1_000); // just inside grace: kept
    expect(
      (await purgeExpiredGuestExchangeArtifacts(pool, NOW)).exchangeIds,
    ).toBe(1);
    expect(await count('guest_exchange_ids')).toBe(1);
  });

  it('bounds one run to a batch and finishes over repeated runs', async () => {
    await pool.query(
      `INSERT INTO guest_exchange_ids
         (id,clinic_id,session_id,queue_entry_id,issued_by_user_id,exchange_verifier,
          contact_kind,created_at,expires_at)
       SELECT gen_random_uuid(),$1,$2,$3,$4,encode(sha256(convert_to(n::text,'UTF8')),'hex'),
              'phone',$5,$6 FROM generate_series(1,520) AS n`,
      [
        ids.clinic,
        ids.session,
        ids.entry,
        ids.actor,
        ago(OLD + 5 * MINUTE),
        ago(OLD),
      ],
    );
    expect(
      (await purgeExpiredGuestExchangeArtifacts(pool, NOW)).exchangeIds,
    ).toBe(500);
    expect(
      (await purgeExpiredGuestExchangeArtifacts(pool, NOW)).exchangeIds,
    ).toBe(20);
    expect(await count('guest_exchange_ids')).toBe(0);
  });

  it('skips a row locked by a concurrent transaction instead of blocking', async () => {
    await addExchange(OLD, false, 'locked');
    await addExchange(OLD, false, 'free');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM guest_exchange_ids WHERE exchange_verifier=$1 FOR UPDATE',
        [sha('locked')],
      );
      expect(
        (await purgeExpiredGuestExchangeArtifacts(pool, NOW)).exchangeIds,
      ).toBe(1);
      expect(await count('guest_exchange_ids')).toBe(1);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('redeeming a purged exchange is rejected like any expired one', async () => {
    const service = new GuestAccessService(pool);
    const issued = await service.issue(target, ids.actor, ago(OLD));
    expect(
      (await purgeExpiredGuestExchangeArtifacts(pool, NOW)).exchangeIds,
    ).toBe(1);
    await expect(
      service.consume(issued.exchangeId, target, NOW),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);
  });
});
