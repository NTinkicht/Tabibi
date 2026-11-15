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
import { migrate } from '../../scripts/db/lib';

// docs/design/pwa-push.md section 3 (#885): POST/DELETE
// /api/guest/push-subscription against a real database. The two credential
// classes are the exchange-origin status cookie and the booking-origin
// Authorization bearer; they are never interchangeable and never combined.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
vi.mock('@/platform/database/pool', () => ({ getPool: () => pool }));

import { DELETE, POST } from '@/app/api/guest/push-subscription/route';

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

function call(
  method: 'POST' | 'DELETE',
  headers: Record<string, string>,
  body?: unknown,
  withOrigin = true,
) {
  const init: RequestInit = {
    method,
    headers: {
      ...(withOrigin ? { origin: ORIGIN } : {}),
      'content-type': 'application/json',
      ...headers,
    },
  };
  if (body !== undefined)
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const request = new Request(URL_, init);
  return method === 'POST' ? POST(request) : DELETE(request);
}
const cookie = () => ({ cookie: `__Host-tabibi_guest=${cookieCredential}` });
const bearer = () => ({ authorization: `Bearer ${bookingCredential}` });
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

const initialIntents = async (entry: string) =>
  (
    await pool.query(
      `SELECT intent, state FROM guest_link_intents WHERE queue_entry_id=$1`,
      [entry],
    )
  ).rows;
const pushExchanges = async (entry: string) =>
  (
    await pool.query(
      `SELECT issued_by_user_id FROM guest_exchange_ids
        WHERE queue_entry_id=$1 AND contact_kind='push'`,
      [entry],
    )
  ).rows;

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

describe('POST/DELETE /api/guest/push-subscription', () => {
  it('binds with the status cookie, grants consent and issues no link', async () => {
    const before = await exchanges();
    const response = await call('POST', cookie(), sub(1));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subscribed: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const rows = await active(ids.entryA);
    expect(rows).toHaveLength(1);
    expect(rows[0].sealed_subscription).not.toContain('route-token-1');
    expect(await consent(ids.patientA)).toEqual(['granted']);
    expect(await exchanges()).toBe(before);
  });

  it('binds with the booking-origin Authorization bearer', async () => {
    const response = await call('POST', bearer(), sub(2));
    expect(response.status).toBe(200);
    expect(await active(ids.entryB)).toHaveLength(1);
    expect(await active(ids.entryA)).toHaveLength(0);
  });

  it('issues exactly one initial link only for the booking-origin bearer', async () => {
    const cookieIntents = (await initialIntents(ids.entryA)).length;
    const cookieExchanges = (await pushExchanges(ids.entryA)).length;
    await call('POST', cookie(), sub(20));
    expect(await initialIntents(ids.entryA)).toHaveLength(cookieIntents);
    expect(await pushExchanges(ids.entryA)).toHaveLength(cookieExchanges);

    const before = (await initialIntents(ids.entryB)).length;
    const beforeEx = (await pushExchanges(ids.entryB)).length;
    expect((await call('POST', bearer(), sub(21))).status).toBe(200);
    const intents = await initialIntents(ids.entryB);
    expect(intents).toHaveLength(before + 1);
    expect(intents.at(-1)).toMatchObject({ intent: 'initial' });
    const exchangesB = await pushExchanges(ids.entryB);
    expect(exchangesB).toHaveLength(beforeEx + 1);
    expect(exchangesB.at(-1)!.issued_by_user_id).toBeNull();
  });

  it('rolls the binding back when the initial link cannot be issued', async () => {
    const savedSecret = process.env.GUEST_BEARER_SIGNING_SECRET;
    const bindingsBefore = (await active(ids.entryB)).length;
    const exchangesBefore = await exchanges();
    delete process.env.GUEST_BEARER_SIGNING_SECRET;
    try {
      const response = await call('POST', bearer(), sub(22));
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      process.env.GUEST_BEARER_SIGNING_SECRET = savedSecret;
    }
    expect(await active(ids.entryB)).toHaveLength(bindingsBefore);
    expect(await exchanges()).toBe(exchangesBefore);
  });

  it('never converts one credential class into the other', async () => {
    // Positive controls above: each class works on its own transport.
    const asBearer = await call(
      'POST',
      {
        authorization: `Bearer ${cookieCredential}`,
      },
      sub(3),
    );
    const asCookie = await call(
      'POST',
      {
        cookie: `__Host-tabibi_guest=${bookingCredential}`,
      },
      sub(3),
    );
    expect(asBearer.status).toBe(401);
    expect(asCookie.status).toBe(401);
    expect(await active(ids.entryA)).toHaveLength(0);
    expect(await active(ids.entryB)).toHaveLength(0);
  });

  it('refuses both credentials at once, none, and a forged one', async () => {
    const both = await call('POST', { ...cookie(), ...bearer() }, sub(4));
    const none = await call('POST', {}, sub(4));
    const forged = await call(
      'POST',
      { cookie: '__Host-tabibi_guest=a.b.c' },
      sub(4),
    );
    expect([both.status, none.status, forged.status]).toEqual([401, 401, 401]);
    expect(
      await pool.query('SELECT 1 FROM guest_push_subscriptions'),
    ).toHaveProperty('rowCount', 0);
  });

  it('requires a same-origin request', async () => {
    const noOrigin = await call('POST', cookie(), sub(5), false);
    const foreign = await call(
      'POST',
      { ...cookie(), origin: 'https://evil.test' },
      sub(5),
    );
    expect([noOrigin.status, foreign.status]).toEqual([403, 403]);
    expect(await active(ids.entryA)).toHaveLength(0);
  });

  it('rejects non-allow-listed endpoints and malformed bodies with 400', async () => {
    const bad = [
      sub(6, { endpoint: 'https://evil.example/push/x' }),
      sub(6, { endpoint: 'https://127.0.0.1/push/x' }),
      sub(6, { endpoint: 'https://fcm.googleapis.com:8443/fcm/send/x' }),
      sub(6, { endpoint: 'https://user@fcm.googleapis.com/fcm/send/x' }),
      sub(6, { locale: 'en' }),
      sub(6, { keys: { p256dh: 'not base64!', auth: 'a' } }),
      { endpoint: 'https://fcm.googleapis.com/fcm/send/x' },
      '[1]',
      '{not json',
      JSON.stringify({ ...sub(6), pad: 'x'.repeat(5000) }),
    ];
    for (const body of bad) {
      await pool.query('TRUNCATE guest_push_rate_limit_buckets');
      expect((await call('POST', cookie(), body)).status).toBe(400);
    }
    expect(await active(ids.entryA)).toHaveLength(0);
    await pool.query('TRUNCATE guest_push_rate_limit_buckets');
    expect((await call('POST', cookie(), sub(6))).status).toBe(200);
  });

  it('caps at 3 active subscriptions and rebinds the same endpoint', async () => {
    for (const n of [10, 11, 12])
      expect((await call('POST', cookie(), sub(n))).status).toBe(200);
    expect((await call('POST', cookie(), sub(13))).status).toBe(409);
    expect((await call('POST', cookie(), sub(10))).status).toBe(200);
    expect(await active(ids.entryA)).toHaveLength(3);
  });

  it('unsubscribes one endpoint, then all, revoking consent only at the end', async () => {
    await call('POST', cookie(), sub(20));
    await call('POST', cookie(), sub(21));
    const one = await call('DELETE', cookie(), { endpoint: sub(20).endpoint });
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ subscribed: false });
    expect(await active(ids.entryA)).toHaveLength(1);
    expect(await consent(ids.patientA)).toEqual(['granted']);
    expect((await call('DELETE', cookie())).status).toBe(200);
    expect(await active(ids.entryA)).toHaveLength(0);
    expect(await consent(ids.patientA)).toEqual(['revoked']);
    const scrubbed = await pool.query(
      'SELECT count(*) AS n FROM guest_push_subscriptions WHERE sealed_subscription IS NOT NULL',
    );
    expect(scrubbed.rows[0].n).toBe('0');
  });

  it("cannot unsubscribe another entry's binding", async () => {
    await call('POST', bearer(), sub(30));
    const response = await call('DELETE', cookie(), {
      endpoint: sub(30).endpoint,
    });
    expect(response.status).toBe(200);
    expect(await active(ids.entryB)).toHaveLength(1);
    expect(await consent(ids.patientB)).toEqual(['granted']);
  });

  it('fails closed with 503 when the seal secret is not configured', async () => {
    delete process.env.GUEST_PUSH_SEAL_SECRET;
    expect((await call('POST', cookie(), sub(40))).status).toBe(503);
    expect(await active(ids.entryA)).toHaveLength(0);
  });

  it('rate-limits per credential and for unauthenticated ingress', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1)
      statuses.push((await call('POST', cookie(), sub(50 + (i % 3)))).status);
    expect(statuses.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(statuses[6]).toBe(429);
    // The other credential has its own bucket (positive control).
    expect((await call('POST', bearer(), sub(60))).status).toBe(200);
    const ingress: number[] = [];
    for (let i = 0; i < 7; i += 1)
      ingress.push((await call('POST', {}, sub(1))).status);
    expect(ingress).toEqual([401, 401, 401, 401, 401, 401, 429]);
  });
});
