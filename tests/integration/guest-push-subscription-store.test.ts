import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  GuestPushBindingRejectedError,
  GuestPushSubscriptionCapError,
  GuestPushSubscriptionStore,
} from '../../src/modules/guest-push/subscription-store';
import {
  PushSubscriptionSealError,
  PushSubscriptionSealer,
} from '../../src/modules/guest-push/subscription-seal';

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
  patient: randomUUID(),
  patient2: randomUUID(),
};
const target = { clinicId: ids.clinic, queueEntryId: ids.entry };
const material = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/token-${n}`,
  keys: { p256dh: 'BPubKey_' + n, auth: 'authKey_' + n },
});

const prefs = async (patient = ids.patient) =>
  (
    await pool.query(
      `SELECT preference_state,consent_state,revision FROM notification_preferences
        WHERE patient_id=$1 AND channel='push'`,
      [patient],
    )
  ).rows;
const active = async (entry = ids.entry) =>
  (
    await pool.query(
      `SELECT id,sealed_subscription FROM guest_push_subscriptions
        WHERE queue_entry_id=$1 AND revoked_at IS NULL`,
      [entry],
    )
  ).rows;

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
  ] as const) {
    await pool.query(
      `INSERT INTO patient_operational_records(id,clinic_id,private_display_name)
       VALUES($1,$2,'Guest')`,
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

describe('GuestPushSubscriptionStore', () => {
  it('binds sealed, grants push consent and audits ids only', async () => {
    const { subscriptionId } = await store.subscribe(target, material(1), 'fr');
    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0].sealed_subscription).not.toContain('token-1');
    expect(
      sealer.open(
        { ...target, id: subscriptionId },
        rows[0].sealed_subscription,
      ),
    ).toEqual(material(1));
    expect(await prefs()).toEqual([
      { preference_state: 'enabled', consent_state: 'granted', revision: '1' },
    ]);
    const audit = await pool.query(
      `SELECT actor_user_id,action,metadata FROM audit_events WHERE action='guest_push_subscribed'`,
    );
    expect(audit.rows).toEqual([
      {
        actor_user_id: null,
        action: 'guest_push_subscribed',
        metadata: { subscriptionId, locale: 'fr' },
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain('fcm.googleapis.com');
  });

  it('re-binds the same endpoint instead of duplicating, even from another entry', async () => {
    const first = await store.subscribe(target, material(1), 'fr');
    const second = await store.subscribe(target, material(1), 'ar');
    expect(second.subscriptionId).not.toBe(first.subscriptionId);
    expect(await active()).toHaveLength(1);
    await store.subscribe(
      { clinicId: ids.clinic, queueEntryId: ids.entry2 },
      material(1),
      'fr',
    );
    expect(await active()).toHaveLength(0);
    expect(await active(ids.entry2)).toHaveLength(1);
    const old = await pool.query(
      `SELECT sealed_subscription,revocation_reason FROM guest_push_subscriptions WHERE id=$1`,
      [first.subscriptionId],
    );
    expect(old.rows[0]).toEqual({
      sealed_subscription: null,
      revocation_reason: 'rotated',
    });
  });

  it('serializes concurrent rebinding of one endpoint across entries', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        store.subscribe(
          {
            clinicId: ids.clinic,
            queueEntryId: i % 2 === 0 ? ids.entry : ids.entry2,
          },
          material(7),
          'fr',
        ),
      ),
    );
    expect(new Set(results.map((r) => r.subscriptionId)).size).toBe(6);
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM guest_push_subscriptions
        WHERE revoked_at IS NULL`,
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('caps active subscriptions at 3 per entry', async () => {
    for (const n of [1, 2, 3]) await store.subscribe(target, material(n), 'fr');
    await expect(
      store.subscribe(target, material(4), 'fr'),
    ).rejects.toBeInstanceOf(GuestPushSubscriptionCapError);
    expect(await active()).toHaveLength(3);
    await store.subscribe(target, material(2), 'fr'); // re-bind still allowed
    expect(await active()).toHaveLength(3);
  });

  it('refuses SSRF endpoints before touching the database', async () => {
    for (const endpoint of [
      'https://169.254.169.254/latest',
      'https://fcm.googleapis.com:8443/x',
      'https://user@fcm.googleapis.com/x',
      'https://evil.example/x',
    ]) {
      await expect(
        store.subscribe(target, { ...material(1), endpoint }, 'fr'),
      ).rejects.toBeInstanceOf(PushSubscriptionSealError);
    }
    expect(await active()).toHaveLength(0);
    expect(await prefs()).toHaveLength(0);
  });

  it('refuses a terminal entry and an unknown entry with the same error', async () => {
    await pool.query(`UPDATE queue_entries SET state='cancelled' WHERE id=$1`, [
      ids.entry,
    ]);
    await expect(
      store.subscribe(target, material(1), 'fr'),
    ).rejects.toBeInstanceOf(GuestPushBindingRejectedError);
    await expect(
      store.subscribe(
        { clinicId: ids.clinic, queueEntryId: randomUUID() },
        material(1),
        'fr',
      ),
    ).rejects.toBeInstanceOf(GuestPushBindingRejectedError);
    expect(await active()).toHaveLength(0);
  });

  it('unsubscribe scrubs the binding and revokes consent only when none remain', async () => {
    await store.subscribe(target, material(1), 'fr');
    await store.subscribe(target, material(2), 'fr');
    expect(await store.unsubscribe(target, material(1).endpoint)).toEqual({
      revoked: 1,
    });
    expect((await prefs())[0].consent_state).toBe('granted');
    expect(await store.unsubscribe(target)).toEqual({ revoked: 1 });
    expect((await prefs())[0].consent_state).toBe('revoked');
    expect(await active()).toHaveLength(0);
    const scrubbed = await pool.query(
      `SELECT count(*) FROM guest_push_subscriptions WHERE sealed_subscription IS NOT NULL`,
    );
    expect(scrubbed.rows[0].count).toBe('0');
    await store.subscribe(target, material(3), 'fr');
    expect((await prefs())[0].consent_state).toBe('granted');
  });

  it('does not unsubscribe another entry that shares an endpoint hash lookup', async () => {
    await store.subscribe(target, material(1), 'fr');
    expect(
      await store.unsubscribe(
        { clinicId: ids.clinic, queueEntryId: ids.entry2 },
        material(1).endpoint,
      ),
    ).toEqual({ revoked: 0 });
    expect(await active()).toHaveLength(1);
  });
});

describe('guest_exchange_ids push issuance', () => {
  const insert = async (kind: string, issuer: string | null) => {
    try {
      await pool.query(
        `INSERT INTO guest_exchange_ids
         (id,clinic_id,session_id,queue_entry_id,issued_by_user_id,exchange_verifier,contact_kind,created_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,now(),now()+interval '5 minutes')`,
        [
          randomUUID(),
          ids.clinic,
          ids.session,
          ids.entry,
          issuer,
          randomUUID().replace(/-/g, '').repeat(2),
          kind,
        ],
      );
      return null;
    } catch (e) {
      return (e as { constraint?: string }).constraint ?? 'other';
    }
  };
  it('allows a system issuer only for push', async () => {
    expect(await insert('push', null)).toBeNull();
    expect(await insert('phone', null)).toBe(
      'guest_exchange_ids_issuer_required',
    );
    expect(await insert('email', null)).toBe(
      'guest_exchange_ids_issuer_required',
    );
    expect(await insert('phone', ids.doctorUser)).toBeNull();
    expect(await insert('sms', ids.doctorUser)).toBe(
      'guest_exchange_ids_contact_kind_check',
    );
  });
});
