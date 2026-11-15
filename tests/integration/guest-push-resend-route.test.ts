import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { GuestAccessService, type GuestTarget } from '@/modules/guest-access';
import { GuestPushSubscriptionStore } from '@/modules/guest-push/subscription-store';
import { guestPushSealer } from '@/modules/guest-push/config';
import { migrate } from '../../scripts/db/lib';

// docs/design/pwa-push.md section 3 (#894): GET key and POST resend against a
// real database. Resend is possession-based and must answer identically
// whether or not the endpoint is bound.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
vi.mock('@/platform/database/pool', () => ({ getPool: () => pool }));

import { GET as getKey } from '@/app/api/guest/push-subscription/key/route';
import { POST as resend } from '@/app/api/guest/push-subscription/resend/route';

const ids = {
  clinic: randomUUID(),
  actor: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  patientA: randomUUID(),
  patientB: randomUUID(),
  entryA: randomUUID(),
  entryB: randomUUID(),
};
const targetOf = (queueEntryId: string): GuestTarget => ({
  clinicId: ids.clinic,
  sessionId: ids.session,
  queueEntryId,
});
const ORIGIN = 'https://tabibi.test';
const URL_ = `${ORIGIN}/api/guest/push-subscription`;
const sub = (n: number, extra: object = {}) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/route-token-${n}`,
  keys: { p256dh: `BRoutePub_${n}`, auth: `routeAuth_${n}` },
  locale: 'fr',
  ...extra,
});
let cookieCredential = '';
let bookingCredential = '';

const active = async (entry: string) =>
  (
    await pool.query(
      `SELECT sealed_subscription FROM guest_push_subscriptions
        WHERE queue_entry_id=$1 AND revoked_at IS NULL`,
      [entry],
    )
  ).rows;
const consent = async (patient: string) =>
  (
    await pool.query(
      `SELECT consent_state FROM notification_preferences
        WHERE patient_id=$1 AND channel='push'`,
      [patient],
    )
  ).rows.map((r) => r.consent_state);
const exchanges = async () =>
  Number(
    (await pool.query('SELECT count(*) AS n FROM guest_exchange_ids')).rows[0]
      .n,
  );

async function credentialFor(entry: string): Promise<string> {
  const service = new GuestAccessService(pool);
  const issued = await service.issue(targetOf(entry), ids.actor);
  return (await service.consume(issued.exchangeId, targetOf(entry))).bearer;
}

beforeAll(async () => {
  await migrate();
  process.env.GUEST_PUSH_SEAL_SECRET =
    'route-test-only-push-seal-secret-0123456789abcdef';
  await pool.query(`TRUNCATE guest_push_subscriptions,notification_preferences,
    guest_exchange_ids,guest_credentials,public_guest_booking_receipts,
    guest_push_rate_limit_buckets,audit_events,queue_entries,
    patient_operational_records,consultation_sessions,doctor_clinics,
    doctor_profiles,clinic_memberships,clinics,users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'route-rec','Rec'),($2,'route-doc','Doc')`,
    [ids.actor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'route-one','Route One')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.actor],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Doc')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
     (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,'2026-09-10','2026-09-10T09:00Z','2026-09-10T12:00Z','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  for (const [p, e, n] of [
    [ids.patientA, ids.entryA, 1],
    [ids.patientB, ids.entryB, 2],
  ] as const) {
    await pool.query(
      `INSERT INTO patient_operational_records(id,clinic_id,private_display_name,contact_phone)
       VALUES($1,$2,'Guest','0555000000')`,
      [p, ids.clinic],
    );
    await pool.query(
      `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
       VALUES($1,$2,$3,$4,'waiting','walk_in',$5,$6)`,
      [e, ids.clinic, ids.session, p, n, 'R-00' + n],
    );
  }
  cookieCredential = await credentialFor(ids.entryA);
  bookingCredential = await credentialFor(ids.entryB);
  // Make entry B's credential booking-origin: a completed booking receipt
  // points at it. Foreign keys are bypassed for this fixture row only.
  const client = await pool.connect();
  try {
    await client.query('SET session_replication_role = replica');
    await client.query(
      `INSERT INTO public_guest_booking_receipts
         (clinic_id,idempotency_key,request_fingerprint,patient_id,queue_entry_id,
          appointment_id,credential_id,access_ciphertext,completed_at)
       SELECT $1,'route-key',repeat('a',64),$2,$3,$4,id,'x',now()
         FROM guest_credentials WHERE queue_entry_id=$3`,
      [ids.clinic, ids.patientB, ids.entryB, randomUUID()],
    );
  } finally {
    await client.query('SET session_replication_role = DEFAULT');
    client.release();
  }
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE guest_push_subscriptions,guest_push_rate_limit_buckets',
  );
  await pool.query('DELETE FROM notification_preferences');
  process.env.GUEST_PUSH_SEAL_SECRET =
    'route-test-only-push-seal-secret-0123456789abcdef';
});
afterAll(async () => pool.end());

const RESEND = `${ORIGIN}/api/guest/push-subscription/resend`;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  resend(
    new Request(RESEND, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
const bind = async (entry: string, n: number) =>
  new GuestPushSubscriptionStore(pool, guestPushSealer()).subscribe(
    { clinicId: ids.clinic, queueEntryId: entry },
    {
      endpoint: sub(n).endpoint,
      keys: { p256dh: sub(n).keys.p256dh, auth: sub(n).keys.auth },
    },
    'fr',
  );
const pushExchanges = async () =>
  (
    await pool.query(
      `SELECT queue_entry_id, issued_by_user_id, contact_kind, consumed_at
         FROM guest_exchange_ids WHERE contact_kind='push'`,
    )
  ).rows;
const intents = async () =>
  (
    await pool.query(
      `SELECT queue_entry_id, intent, state, envelope_ciphertext
         FROM guest_link_intents`,
    )
  ).rows;

describe('GET /api/guest/push-subscription/key', () => {
  const KEY = 'B'.repeat(86);
  it('serves the configured VAPID public key with no-store', async () => {
    process.env.VAPID_PUBLIC_KEY = KEY;
    const response = await getKey();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ publicKey: KEY });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('answers 503 when unset or malformed, never an empty key', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    expect((await getKey()).status).toBe(503);
    process.env.VAPID_PUBLIC_KEY = 'not-a-p256-point';
    const response = await getKey();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'push_unavailable' });
    delete process.env.VAPID_PUBLIC_KEY;
  });
});

describe('POST /api/guest/push-subscription/resend', () => {
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE guest_link_intents,guest_exchange_ids,guest_push_rate_limit_buckets',
    );
    await pool.query(`UPDATE queue_entries SET state='waiting'`);
    // Rows created by credentialFor were truncated; credentials stay valid.
  });

  it('issues a system push exchange and a resend intent for a bound endpoint', async () => {
    await bind(ids.entryA, 1);
    const response = await post({ endpoint: sub(1).endpoint });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const exchanges_ = await pushExchanges();
    expect(exchanges_).toHaveLength(1);
    expect(exchanges_[0]).toMatchObject({
      queue_entry_id: ids.entryA,
      issued_by_user_id: null,
      contact_kind: 'push',
      consumed_at: null,
    });
    const rows = await intents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      queue_entry_id: ids.entryA,
      intent: 'resend',
      state: 'pending',
    });
    expect(rows[0].envelope_ciphertext).toEqual(expect.any(String));
    const audit = await pool.query(
      `SELECT metadata FROM audit_events WHERE action='guest_push_link_resend_requested'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(Object.keys(audit.rows[0].metadata)).toEqual(['subscriptionId']);
  });

  it('answers the same 202 body for an unknown endpoint and creates nothing', async () => {
    await bind(ids.entryA, 1);
    const known = await post({ endpoint: sub(1).endpoint });
    await pool.query('TRUNCATE guest_link_intents,guest_exchange_ids');
    const unknown = await post({ endpoint: sub(99).endpoint });
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual({ accepted: true });
    expect([...unknown.headers.entries()].sort()).toEqual(
      [...known.headers.entries()].sort(),
    );
    expect(await pushExchanges()).toHaveLength(0);
    expect(await intents()).toHaveLength(0);
  });

  it('limits to 3 links per binding per hour while still answering 202', async () => {
    await bind(ids.entryA, 1);
    for (let i = 0; i < 4; i += 1)
      expect((await post({ endpoint: sub(1).endpoint })).status).toBe(202);
    expect(await intents()).toHaveLength(3);
    expect(await pushExchanges()).toHaveLength(3);
    // The 3-per-hour bucket must survive a later short-window call (the
    // ingress bucket is purged on a different horizon).
    await post({ endpoint: sub(98).endpoint });
    await post({ endpoint: sub(1).endpoint });
    expect(await intents()).toHaveLength(3);
  });

  it('does not count another binding against this binding', async () => {
    await bind(ids.entryA, 1);
    await bind(ids.entryB, 2);
    for (let i = 0; i < 3; i += 1) await post({ endpoint: sub(1).endpoint });
    await post({ endpoint: sub(2).endpoint });
    const rows = await intents();
    expect(rows.filter((r) => r.queue_entry_id === ids.entryB)).toHaveLength(1);
  });

  it('issues nothing for a revoked binding or an inactive entry', async () => {
    await bind(ids.entryA, 1);
    await new GuestPushSubscriptionStore(pool, guestPushSealer()).unsubscribe({
      clinicId: ids.clinic,
      queueEntryId: ids.entryA,
    });
    expect((await post({ endpoint: sub(1).endpoint })).status).toBe(202);
    expect(await intents()).toHaveLength(0);

    await bind(ids.entryB, 2);
    await pool.query(`UPDATE queue_entries SET state='cancelled' WHERE id=$1`, [
      ids.entryB,
    ]);
    const response = await post({ endpoint: sub(2).endpoint });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(await pushExchanges()).toHaveLength(0);
    expect(await intents()).toHaveLength(0);
  });

  it('refuses system issuance for a binding of a different entry', async () => {
    const { subscriptionId } = await bind(ids.entryA, 1);
    const client = await pool.connect();
    try {
      await expect(
        new GuestAccessService(pool).issueSystemPushInTransaction(client, {
          clinicId: ids.clinic,
          queueEntryId: ids.entryB,
          subscriptionId,
        }),
      ).rejects.toThrow('Guest access exchange rejected');
      // Positive control: the same call for the owning entry succeeds.
      await expect(
        new GuestAccessService(pool).issueSystemPushInTransaction(client, {
          clinicId: ids.clinic,
          queueEntryId: ids.entryA,
          subscriptionId,
        }),
      ).resolves.toMatchObject({ exchangeId: expect.any(String) });
    } finally {
      client.release();
    }
  });

  it('rejects a non-allow-listed host, a bad body, a foreign origin and missing seal config', async () => {
    expect(
      (await post({ endpoint: 'https://evil.example/push/1' })).status,
    ).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post('[]')).status).toBe(400);
    const foreign = await post(
      { endpoint: sub(1).endpoint },
      { origin: 'https://evil.example' },
    );
    expect(foreign.status).toBe(403);
    delete process.env.GUEST_PUSH_SEAL_SECRET;
    expect((await post({ endpoint: sub(1).endpoint })).status).toBe(503);
    expect(await intents()).toHaveLength(0);
  });

  it('keeps the hourly counter when other guest routes purge their shared table', async () => {
    await bind(ids.entryA, 1);
    for (let i = 0; i < 3; i += 1) await post({ endpoint: sub(1).endpoint });
    // What status/inbox/stream routes do: purge every old bucket of THEIR
    // table with a 60-second window. Age the push bucket first.
    await pool.query(
      `UPDATE guest_push_rate_limit_buckets SET window_started_at=now()-interval '10 minutes'`,
    );
    await pool.query(
      `UPDATE guest_status_rate_limit_buckets SET window_started_at=now()-interval '10 minutes'`,
    );
    await pool.query(
      `DELETE FROM guest_status_rate_limit_buckets
        WHERE window_started_at < now() - interval '60 seconds'`,
    );
    await post({ endpoint: sub(1).endpoint });
    expect(await intents()).toHaveLength(3);
  });

  it('rate limits the ingress bucket', async () => {
    let last = 202;
    for (let i = 0; i < 31; i += 1)
      last = (await post({ endpoint: sub(50).endpoint })).status;
    expect(last).toBe(429);
  });
});

describe('push exchange credential rotation', () => {
  // Fresh entry so the shared fixtures' credentials stay valid.
  const rotationEntry = randomUUID();
  const rotationPatient = randomUUID();
  const issuePush = async (subscriptionId: string, entry = rotationEntry) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const issued = await new GuestAccessService(
        pool,
      ).issueSystemPushInTransaction(client, {
        clinicId: ids.clinic,
        queueEntryId: entry,
        subscriptionId,
      });
      await client.query('COMMIT');
      return issued.exchangeId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  it('rotates a live credential on push consume, but not on staff consume', async () => {
    await pool.query(
      `INSERT INTO patient_operational_records(id,clinic_id,private_display_name,contact_phone)
       VALUES($1,$2,'Rot','0555000001')`,
      [rotationPatient, ids.clinic],
    );
    await pool.query(
      `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
       VALUES($1,$2,$3,$4,'waiting','walk_in',9,'R-009')`,
      [rotationEntry, ids.clinic, ids.session, rotationPatient],
    );
    const service = new GuestAccessService(pool);
    const oldBearer = await credentialFor(rotationEntry);
    const { subscriptionId } = await bind(rotationEntry, 30);

    // Control: a staff-issued exchange is still refused while a credential is live.
    const staff = await service.issue(targetOf(rotationEntry), ids.actor);
    await expect(
      service.consume(staff.exchangeId, targetOf(rotationEntry)),
    ).rejects.toThrow();
    await expect(service.authorize(oldBearer)).resolves.toBeDefined();

    // A push exchange succeeds, revoking the old credential as rotated.
    const fresh = await service.consume(
      await issuePush(subscriptionId),
      targetOf(rotationEntry),
    );
    await expect(service.authorize(oldBearer)).rejects.toThrow();
    await expect(service.authorize(fresh.bearer)).resolves.toBeDefined();
    const rows = (
      await pool.query(
        `SELECT revoked_at IS NOT NULL AS revoked, revocation_reason
           FROM guest_credentials WHERE queue_entry_id=$1 ORDER BY issued_at`,
        [rotationEntry],
      )
    ).rows;
    expect(rows).toEqual([
      { revoked: true, revocation_reason: 'rotated' },
      { revoked: false, revocation_reason: null },
    ]);
    const audit = await pool.query(
      `SELECT metadata FROM audit_events
        WHERE entity_id=$1 AND action='guest_credential_rotated'`,
      [rotationEntry],
    );
    expect(audit.rows.map((r) => r.metadata)).toEqual([
      { exchangeKind: 'push' },
    ]);
  });

  it('does not rotate a booking-origin credential on push consume', async () => {
    const entry = randomUUID();
    const patient = randomUUID();
    await pool.query(
      `INSERT INTO patient_operational_records(id,clinic_id,private_display_name,contact_phone)
       VALUES($1,$2,'Bk','0555000002')`,
      [patient, ids.clinic],
    );
    await pool.query(
      `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
       VALUES($1,$2,$3,$4,'waiting','walk_in',10,'R-010')`,
      [entry, ids.clinic, ids.session, patient],
    );
    const service = new GuestAccessService(pool);
    const bookingBearer = await credentialFor(entry);
    const credential = (
      await pool.query<{ id: string }>(
        'SELECT id FROM guest_credentials WHERE queue_entry_id=$1',
        [entry],
      )
    ).rows[0]!.id;
    const appointment = randomUUID();
    await pool.query(
      `INSERT INTO appointments
         (id,clinic_id,doctor_id,session_id,patient_id,queue_entry_id,status,
          scheduled_start_at,scheduled_end_at,preferred_locale,source)
       VALUES($1,$2,$3,$4,$5,$6,'confirmed','2026-09-08 10:00Z','2026-09-08 10:20Z','ar','public')`,
      [appointment, ids.clinic, ids.doctor, ids.session, patient, entry],
    );
    await pool.query(
      `INSERT INTO public_guest_booking_receipts
         (clinic_id,idempotency_key,request_fingerprint,patient_id,queue_entry_id,
          appointment_id,credential_id,access_ciphertext,completed_at)
       VALUES($1,'rot-bk',repeat('a',64),$2,$3,$4,$5,'ct',now())`,
      [ids.clinic, patient, entry, appointment, credential],
    );
    const { subscriptionId } = await bind(entry, 31);
    await expect(
      service.consume(await issuePush(subscriptionId, entry), targetOf(entry)),
    ).rejects.toThrow();
    await expect(service.authorize(bookingBearer)).resolves.toBeDefined();
    const rows = (
      await pool.query(
        `SELECT revoked_at IS NOT NULL AS revoked, revocation_reason
           FROM guest_credentials WHERE queue_entry_id=$1`,
        [entry],
      )
    ).rows;
    expect(rows).toEqual([{ revoked: false, revocation_reason: null }]);
  });
});
