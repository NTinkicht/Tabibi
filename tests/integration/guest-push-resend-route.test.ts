import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import {
  authenticatedGuestCredentialId,
  GuestAccessService,
  type GuestTarget,
} from '@/modules/guest-access';
import { authenticateGuestPush } from '@/modules/guest-push/credential';
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

  it('limits an unknown endpoint per hash without blocking another guest', async () => {
    await bind(ids.entryA, 1);
    // Junk endpoint hammered well past 3 per hour: still 202, no intents.
    for (let i = 0; i < 10; i += 1)
      expect((await post({ endpoint: sub(77).endpoint })).status).toBe(202);
    const bucketKey = (k: string) =>
      createHash('sha256').update(k).digest('hex');
    const hash = guestPushSealer().endpointHash(sub(77).endpoint);
    const row = await pool.query(
      'SELECT request_count FROM guest_push_rate_limit_buckets WHERE bucket_key=$1',
      [bucketKey(`guest-push-resend:endpoint:${hash}`)],
    );
    // Counter stops at the limit: refused calls do not keep counting.
    expect(Number(row.rows[0].request_count)).toBe(3);
    // Positive control: a different, bound endpoint still gets its link.
    expect((await post({ endpoint: sub(1).endpoint })).status).toBe(202);
    expect(await intents()).toHaveLength(1);
  });

  it('applies the per-endpoint limit before the binding lookup', async () => {
    await bind(ids.entryA, 1);
    const hash = guestPushSealer().endpointHash(sub(1).endpoint);
    await pool.query(
      `INSERT INTO guest_push_rate_limit_buckets
         (bucket_key,window_started_at,request_count,updated_at)
       VALUES ($1,now(),3,now())`,
      [
        createHash('sha256')
          .update(`guest-push-resend:endpoint:${hash}`)
          .digest('hex'),
      ],
    );
    expect((await post({ endpoint: sub(1).endpoint })).status).toBe(202);
    expect(await intents()).toHaveLength(0);
    // The binding bucket was never touched: refusal came from the endpoint bucket.
    const binding = await pool.query(
      `SELECT id FROM guest_push_subscriptions WHERE queue_entry_id=$1`,
      [ids.entryA],
    );
    const rows = await pool.query(
      'SELECT 1 FROM guest_push_rate_limit_buckets WHERE bucket_key=$1',
      [
        createHash('sha256')
          .update(`guest-push-resend:binding:${binding.rows[0].id}`)
          .digest('hex'),
      ],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('rate limits the ingress bucket at 300 per minute', async () => {
    const key = createHash('sha256')
      .update('guest-push-resend:ingress')
      .digest('hex');
    await pool.query(
      `INSERT INTO guest_push_rate_limit_buckets
         (bucket_key,window_started_at,request_count,updated_at)
       VALUES ($1,now(),299,now())`,
      [key],
    );
    // Positive control: the 300th request is still served.
    expect((await post({ endpoint: sub(50).endpoint })).status).toBe(202);
    const blocked = await post({ endpoint: sub(50).endpoint });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
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

  const seedBookedEntry = async (order: number) => {
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
       VALUES($1,$2,$3,$4,'waiting','walk_in',$5,$6)`,
      [entry, ids.clinic, ids.session, patient, order, `R-0${order}`],
    );
    const bookingBearer = await credentialFor(entry);
    const credential = (
      await pool.query<{ id: string }>(
        'SELECT id FROM guest_credentials WHERE queue_entry_id=$1',
        [entry],
      )
    ).rows[0]!.id;
    // Mirror public-guest-booking: the booking credential is class 'booking'
    // and referenced by the completed receipt.
    await pool.query(
      `UPDATE guest_credentials SET credential_class='booking' WHERE id=$1`,
      [credential],
    );
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
       VALUES($1,$2,repeat('a',64),$3,$4,$5,$6,'ct',now())`,
      [ids.clinic, `rot-bk-${order}`, patient, entry, appointment, credential],
    );
    return { entry, bookingBearer, credential };
  };

  it('gives a booked guest a status credential on push consume without touching the booking bearer', async () => {
    const { entry, bookingBearer, credential } = await seedBookedEntry(10);
    const service = new GuestAccessService(pool);
    const { subscriptionId } = await bind(entry, 31);

    const first = await service.consume(
      await issuePush(subscriptionId, entry),
      targetOf(entry),
    );
    await expect(service.authorize(first.bearer)).resolves.toBeDefined();
    await expect(service.authorize(bookingBearer)).resolves.toBeDefined();

    // A second push consume rotates the first status credential only.
    const second = await service.consume(
      await issuePush(subscriptionId, entry),
      targetOf(entry),
    );
    await expect(service.authorize(first.bearer)).rejects.toThrow();
    await expect(service.authorize(second.bearer)).resolves.toBeDefined();
    await expect(service.authorize(bookingBearer)).resolves.toBeDefined();

    const rows = (
      await pool.query(
        `SELECT id=$2 AS is_booking, credential_class, revocation_reason,
                revoked_at IS NOT NULL AS revoked
           FROM guest_credentials WHERE queue_entry_id=$1
          ORDER BY issued_at, credential_class`,
        [entry, credential],
      )
    ).rows;
    expect(rows).toEqual([
      {
        is_booking: true,
        credential_class: 'booking',
        revocation_reason: null,
        revoked: false,
      },
      {
        is_booking: false,
        credential_class: 'status',
        revocation_reason: 'rotated',
        revoked: true,
      },
      {
        is_booking: false,
        credential_class: 'status',
        revocation_reason: null,
        revoked: false,
      },
    ]);
  });

  it('refuses a staff exchange only while a live status credential exists', async () => {
    const { entry, bookingBearer } = await seedBookedEntry(11);
    const service = new GuestAccessService(pool);

    // Booked guest without a status credential: staff exchange succeeds.
    const status = await service.consume(
      (await service.issue(targetOf(entry), ids.actor)).exchangeId,
      targetOf(entry),
    );
    await expect(service.authorize(status.bearer)).resolves.toBeDefined();
    await expect(service.authorize(bookingBearer)).resolves.toBeDefined();

    // Now a live status credential exists: the next staff exchange is refused.
    const staff = await service.issue(targetOf(entry), ids.actor);
    await expect(
      service.consume(staff.exchangeId, targetOf(entry)),
    ).rejects.toThrow();
    await expect(service.authorize(status.bearer)).resolves.toBeDefined();
  });

  it('migration 0061 backfills booking rows only and enforces one live credential per class', async () => {
    const { entry, credential } = await seedBookedEntry(14);
    const service = new GuestAccessService(pool);
    const status = await service.consume(
      (await service.issue(targetOf(entry), ids.actor)).exchangeId,
      targetOf(entry),
    );
    const statusId = authenticatedGuestCredentialId(status.bearer)!;
    // Reset both rows to the pre-migration default, then re-run the backfill.
    await pool.query(
      `UPDATE guest_credentials SET revoked_at=now() WHERE id=$1`,
      [statusId],
    );
    await pool.query(
      `UPDATE guest_credentials SET credential_class='status' WHERE queue_entry_id=$1`,
      [entry],
    );
    const sql = await readFile(
      resolve('db/migrations/0061_guest_credential_class.sql'),
      'utf8',
    );
    const backfill = /UPDATE guest_credentials credential[\s\S]*?;/.exec(
      sql,
    )![0];
    await pool.query(backfill);
    const rows = (
      await pool.query<{ id: string; credential_class: string }>(
        'SELECT id, credential_class FROM guest_credentials WHERE queue_entry_id=$1',
        [entry],
      )
    ).rows;
    expect(rows.find((r) => r.id === credential)?.credential_class).toBe(
      'booking',
    );
    expect(rows.find((r) => r.id === statusId)?.credential_class).toBe(
      'status',
    );
    await pool.query(
      `UPDATE guest_credentials SET revoked_at=NULL WHERE id=$1`,
      [statusId],
    );
    // Unknown class refused; a second live credential of one class refused.
    await expect(
      pool.query(
        `UPDATE guest_credentials SET credential_class='other' WHERE id=$1`,
        [statusId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `UPDATE guest_credentials SET credential_class='status' WHERE id=$1`,
        [credential],
      ),
    ).rejects.toMatchObject({
      constraint: 'guest_credentials_one_live_per_entry_class_uq',
    });
  });

  it('authenticates push subscriptions by credential_class and rejects a column/receipt mismatch', async () => {
    const { entry, bookingBearer, credential } = await seedBookedEntry(12);
    const service = new GuestAccessService(pool);
    const status = await service.consume(
      (await service.issue(targetOf(entry), ids.actor)).exchangeId,
      targetOf(entry),
    );
    const asBearer = (b: string) =>
      new Request('https://x.test/', {
        headers: { authorization: `Bearer ${b}` },
      });
    const asCookie = (b: string) =>
      new Request('https://x.test/', {
        headers: { cookie: `__Host-tabibi_guest=${b}` },
      });
    await expect(
      authenticateGuestPush(pool, asBearer(bookingBearer)),
    ).resolves.toMatchObject({ credentialClass: 'booking_bearer' });
    await expect(
      authenticateGuestPush(pool, asCookie(status.bearer)),
    ).resolves.toMatchObject({ credentialClass: 'status_cookie' });
    // Neither class is accepted as the other.
    await expect(
      authenticateGuestPush(pool, asCookie(bookingBearer)),
    ).rejects.toThrow();
    await expect(
      authenticateGuestPush(pool, asBearer(status.bearer)),
    ).rejects.toThrow();
    // A booking-referenced credential whose column disagrees fails closed.
    await pool.query(
      `UPDATE guest_credentials SET revoked_at=now() WHERE id<>$1 AND queue_entry_id=$2`,
      [credential, entry],
    );
    await pool.query(
      `UPDATE guest_credentials SET credential_class='status' WHERE id=$1`,
      [credential],
    );
    await expect(
      authenticateGuestPush(pool, asBearer(bookingBearer)),
    ).rejects.toThrow();
  });
});
