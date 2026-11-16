import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { sweepExpiredPushBindings } from '../../src/modules/guest-push/expiry-sweep';
import { GuestPushSubscriptionStore } from '../../src/modules/guest-push/subscription-store';
import { PushSubscriptionSealer } from '../../src/modules/guest-push/subscription-seal';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const sealer = new PushSubscriptionSealer(
  'test-only-push-seal-secret-0123456789abcdef',
);
const store = new GuestPushSubscriptionStore(pool, sealer);
const ids = {
  clinic: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  entry: randomUUID(),
  entry2: randomUUID(),
  entry3: randomUUID(),
  patient: randomUUID(),
  patient2: randomUUID(),
};
const target = { clinicId: ids.clinic, queueEntryId: ids.entry };
const material = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/token-${n}`,
  keys: { p256dh: 'BPubKey_' + n, auth: 'authKey_' + n },
});

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE guest_push_subscriptions,notification_preferences,
    guest_exchange_ids,audit_events,queue_entries,patient_operational_records,
    consultation_sessions,doctor_clinics,doctor_profiles,clinic_memberships,clinics,users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'store-doc','Doctor')`,
    [ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'store-one','Store One')`,
    [ids.clinic],
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
  for (const [p, e, n] of [
    [ids.patient, ids.entry, 1],
    [ids.patient2, ids.entry2, 2],
    [ids.patient, ids.entry3, 3],
  ] as const) {
    await pool.query(
      `INSERT INTO patient_operational_records(id,clinic_id,private_display_name)
       VALUES($1,$2,'Guest') ON CONFLICT (id) DO NOTHING`,
      [p, ids.clinic],
    );
    await pool.query(
      `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
       VALUES($1,$2,$3,$4,'waiting','walk_in',$5,$6)`,
      [e, ids.clinic, ids.session, p, n, 'P-00' + n],
    );
  }
});
afterAll(async () => pool.end());

const T0 = new Date('2026-09-09T10:00:00Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const rowOf = async (id: string) =>
  (
    await pool.query(
      `SELECT revoked_at,revocation_reason,sealed_subscription
         FROM guest_push_subscriptions WHERE id=$1`,
      [id],
    )
  ).rows[0];
const consent = async (patient = ids.patient) =>
  (
    await pool.query(
      `SELECT consent_state FROM notification_preferences
        WHERE patient_id=$1 AND channel='push'`,
      [patient],
    )
  ).rows[0]?.consent_state;
const bind = async (entry = ids.entry, n = 1) =>
  (
    await store.subscribe(
      { clinicId: ids.clinic, queueEntryId: entry },
      material(n),
      'fr',
      T0,
    )
  ).subscriptionId;
const finishEntry = async (entry: string, at: Date, state = 'completed') => {
  const done = state === 'completed';
  await pool.query(
    `UPDATE queue_entries SET state=$2,
       in_consultation_started_at=CASE WHEN $4::boolean THEN $3::timestamptz - interval '5 minutes' END
      WHERE id=$1`,
    [entry, state, at, done],
  );
  await pool.query(
    `UPDATE queue_entries
        SET completed_at=CASE WHEN $3::boolean THEN $2::timestamptz END,
            updated_at=$2
      WHERE id=$1`,
    [entry, at, done],
  );
};

describe('sweepExpiredPushBindings', () => {
  it('keeps a live binding of an active entry (positive control)', async () => {
    const id = await bind();
    expect(await sweepExpiredPushBindings(pool, minutes(60))).toBe(0);
    expect((await rowOf(id)).revoked_at).toBeNull();
    expect((await rowOf(id)).sealed_subscription).not.toBeNull();
    expect(await consent()).toBe('granted');
  });

  it('expires and scrubs a binding past its 24h lifetime, revoking consent and auditing ids only', async () => {
    const id = await bind();
    expect(await sweepExpiredPushBindings(pool, minutes(24 * 60 - 1))).toBe(0);
    expect(await sweepExpiredPushBindings(pool, minutes(24 * 60 + 1))).toBe(1);
    expect(await rowOf(id)).toMatchObject({
      revocation_reason: 'expired',
      sealed_subscription: null,
    });
    expect(await consent()).toBe('revoked');
    const audit = await pool.query(
      `SELECT metadata::text AS m FROM audit_events WHERE action='guest_push_expired'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.parse(audit.rows[0].m)).toEqual({ subscriptionId: id });
    expect(audit.rows[0].m).not.toContain('token-1');
    expect(await sweepExpiredPushBindings(pool, minutes(24 * 60 + 2))).toBe(0);
  });

  it('keeps a terminal entry binding for the 15-minute grace, then expires it', async () => {
    const id = await bind();
    await finishEntry(ids.entry, minutes(30));
    expect(await sweepExpiredPushBindings(pool, minutes(44))).toBe(0);
    expect((await rowOf(id)).revoked_at).toBeNull();
    expect(await sweepExpiredPushBindings(pool, minutes(45))).toBe(1);
    expect((await rowOf(id)).revocation_reason).toBe('expired');
  });

  it('treats a cancelled entry like a terminal one', async () => {
    const id = await bind();
    await finishEntry(ids.entry, minutes(30), 'cancelled');
    expect(await sweepExpiredPushBindings(pool, minutes(46))).toBe(1);
    expect((await rowOf(id)).revocation_reason).toBe('expired');
  });

  it('treats a no_show entry like a terminal one', async () => {
    const id = await bind();
    await finishEntry(ids.entry, minutes(30), 'no_show');
    expect(await sweepExpiredPushBindings(pool, minutes(44))).toBe(0);
    expect(await sweepExpiredPushBindings(pool, minutes(46))).toBe(1);
    expect((await rowOf(id)).revocation_reason).toBe('expired');
  });

  it.each(['closed', 'cancelled'])(
    'expires bindings of a %s session after the grace, not before',
    async (status) => {
      const id = await bind();
      // The close guard forbids closing with active entries; the sweep must still
      // treat a closed session as terminal for any binding left behind, so bypass
      // the trigger for this fixture only.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL session_replication_role = 'replica'");
        await client.query(
          `UPDATE consultation_sessions SET status=$3, closed_at=$2, updated_at=$2 WHERE id=$1`,
          [ids.session, minutes(30), status],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(await sweepExpiredPushBindings(pool, minutes(44))).toBe(0);
      expect(await sweepExpiredPushBindings(pool, minutes(46))).toBe(1);
      expect((await rowOf(id)).sealed_subscription).toBeNull();
    },
  );

  it('keeps push consent while the patient has another active binding', async () => {
    const expiring = await bind(ids.entry, 1);
    const surviving = await bind(ids.entry3, 2);
    await finishEntry(ids.entry, minutes(30));
    expect(await sweepExpiredPushBindings(pool, minutes(60))).toBe(1);
    expect((await rowOf(expiring)).revocation_reason).toBe('expired');
    expect((await rowOf(surviving)).revoked_at).toBeNull();
    expect(await consent()).toBe('granted');
  });

  it('never touches another entry or an already revoked binding', async () => {
    const other = await bind(ids.entry2, 3);
    const gone = await bind(ids.entry, 4);
    await store.unsubscribe({ clinicId: ids.clinic, queueEntryId: ids.entry });
    await finishEntry(ids.entry, minutes(30));
    expect(await sweepExpiredPushBindings(pool, minutes(60))).toBe(0);
    expect((await rowOf(gone)).revocation_reason).toBe('unsubscribed');
    expect((await rowOf(other)).revoked_at).toBeNull();
  });

  it('does not revoke consent that a concurrent, uncommitted subscribe depends on', async () => {
    await bind(ids.entry, 1);
    await finishEntry(ids.entry, minutes(30));
    const subscriber = await pool.connect();
    try {
      await subscriber.query('BEGIN');
      // What subscribe does for the patient's other entry: binding first,
      // then the consent upsert (taking the preference row lock).
      await subscriber.query(
        `INSERT INTO guest_push_subscriptions
           (id,clinic_id,queue_entry_id,endpoint_hash,sealed_subscription,locale,created_at,expires_at)
         VALUES($1,$2,$3,$4,'sealed','fr',$5,$6)`,
        [
          randomUUID(),
          ids.clinic,
          ids.entry3,
          'a'.repeat(64),
          minutes(59),
          minutes(59 + 24 * 60),
        ],
      );
      await subscriber.query(
        `UPDATE notification_preferences SET revision=revision+1
          WHERE patient_id=$1 AND channel='push'`,
        [ids.patient],
      );
      const sweep = sweepExpiredPushBindings(pool, minutes(60));
      await new Promise((r) => setTimeout(r, 300));
      await subscriber.query('COMMIT');
      expect(await sweep).toBe(1);
    } finally {
      subscriber.release();
    }
    expect(await consent()).toBe('granted');
  });

  it('skips a row locked by a concurrent transaction instead of waiting, then sweeps it', async () => {
    const id = await bind();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM guest_push_subscriptions WHERE id=$1 FOR UPDATE',
        [id],
      );
      expect(await sweepExpiredPushBindings(pool, minutes(25 * 60))).toBe(0);
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    expect(await sweepExpiredPushBindings(pool, minutes(25 * 60))).toBe(1);
  });
});
