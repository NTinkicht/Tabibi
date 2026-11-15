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

import { POST as subscribe } from '@/app/api/guest/push-subscription/route';
import { POST as renew } from '@/app/api/guest/push-subscription/renew/route';

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

function post(
  fn: typeof renew,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  withOrigin = true,
) {
  return fn(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        ...(withOrigin ? { origin: ORIGIN } : {}),
        'content-type': 'application/json',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}
const bind = (headers: Record<string, string>, body: unknown) =>
  post(subscribe, '/api/guest/push-subscription', headers, body);
const doRenew = (
  headers: Record<string, string>,
  body: unknown,
  withOrigin = true,
) =>
  post(renew, '/api/guest/push-subscription/renew', headers, body, withOrigin);
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

const renewBody = (oldN: number, newN: number, extra: object = {}) => ({
  oldEndpoint: sub(oldN).endpoint,
  subscription: { endpoint: sub(newN).endpoint, keys: sub(newN).keys },
  locale: 'fr',
  ...extra,
});
const history = async (entry: string) =>
  (
    await pool.query(
      `SELECT revoked_at, revocation_reason, sealed_subscription, expires_at
         FROM guest_push_subscriptions WHERE queue_entry_id=$1
        ORDER BY created_at, id`,
      [entry],
    )
  ).rows;

describe('POST /api/guest/push-subscription/renew', () => {
  it('replaces the entry binding, keeps its expiry, consent and issues no link', async () => {
    expect((await bind(cookie(), sub(1))).status).toBe(200);
    const [before] = await history(ids.entryA);
    const exchangesBefore = await exchanges();
    const response = await doRenew(cookie(), renewBody(1, 2));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ renewed: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const rows = await history(ids.entryA);
    expect(rows).toHaveLength(2);
    expect(rows[0].revocation_reason).toBe('rotated');
    expect(rows[0].sealed_subscription).toBeNull();
    expect(rows[1].revoked_at).toBeNull();
    expect(rows[1].sealed_subscription).not.toContain('route-token-2');
    expect(rows[1].expires_at).toEqual(before.expires_at);
    expect(await consent(ids.patientA)).toEqual(['granted']);
    expect(await exchanges()).toBe(exchangesBefore);
    const audit = await pool.query(
      `SELECT metadata FROM audit_events WHERE action='guest_push_renewed'
        AND entity_id=$1`,
      [ids.entryA],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0].metadata)).not.toContain('route-token');
  });

  it('refuses without a credential, with both classes, or without same origin, changing nothing', async () => {
    await bind(cookie(), sub(1));
    for (const response of [
      await doRenew({}, renewBody(1, 2)),
      await doRenew({ ...cookie(), ...bearer() }, renewBody(1, 2)),
      await doRenew({ cookie: '__Host-tabibi_guest=garbage' }, renewBody(1, 2)),
    ]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Guest access rejected' });
    }
    expect((await doRenew(cookie(), renewBody(1, 2), false)).status).toBe(403);
    expect(await history(ids.entryA)).toHaveLength(1);
    expect(await active(ids.entryA)).toHaveLength(1);
  });

  it("treats another entry's binding as no match and leaves it untouched", async () => {
    await bind(bearer(), sub(5));
    const response = await doRenew(cookie(), renewBody(5, 6));
    expect(response.status).toBe(401);
    expect(await history(ids.entryA)).toHaveLength(0);
    const rows = await history(ids.entryB);
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).toBeNull();
    expect(rows[0].sealed_subscription).not.toBeNull();
  });

  it('refuses an unknown old endpoint with the same shape and no side effect', async () => {
    await bind(cookie(), sub(1));
    const response = await doRenew(cookie(), renewBody(9, 2));
    expect(response.status).toBe(401);
    expect(await history(ids.entryA)).toHaveLength(1);
    expect((await active(ids.entryA))[0].sealed_subscription).not.toBeNull();
  });

  it('refuses a disallowed new endpoint before touching the old binding', async () => {
    await bind(cookie(), sub(1));
    const response = await doRenew(cookie(), {
      ...renewBody(1, 2),
      subscription: {
        endpoint: 'https://evil.example/push/x',
        keys: sub(2).keys,
      },
    });
    expect(response.status).toBe(400);
    const rows = await history(ids.entryA);
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).toBeNull();
  });

  it('rejects malformed bodies with 400 and does not renew', async () => {
    await bind(cookie(), sub(1));
    for (const body of [
      '{',
      '[]',
      { ...renewBody(1, 2), locale: 'en' },
      { ...renewBody(1, 2), oldEndpoint: 5 },
      { oldEndpoint: sub(1).endpoint, locale: 'fr' },
    ])
      expect((await doRenew(cookie(), body)).status).toBe(400);
    expect(await history(ids.entryA)).toHaveLength(1);
  });

  it('rebinds a new endpoint already bound elsewhere instead of duplicating it', async () => {
    await bind(cookie(), sub(1));
    await bind(bearer(), sub(7));
    expect((await doRenew(cookie(), renewBody(1, 7))).status).toBe(200);
    const rowsB = await history(ids.entryB);
    expect(rowsB[0].revocation_reason).toBe('rotated');
    expect(rowsB[0].sealed_subscription).toBeNull();
    expect(await active(ids.entryA)).toHaveLength(1);
    expect(await active(ids.entryB)).toHaveLength(0);
  });

  it('refuses an inactive entry', async () => {
    await bind(cookie(), sub(1));
    await pool.query(`UPDATE queue_entries SET state='cancelled' WHERE id=$1`, [
      ids.entryA,
    ]);
    try {
      expect((await doRenew(cookie(), renewBody(1, 2))).status).toBe(401);
    } finally {
      await pool.query(`UPDATE queue_entries SET state='waiting' WHERE id=$1`, [
        ids.entryA,
      ]);
    }
    expect(await history(ids.entryA)).toHaveLength(1);
  });

  it('rate limits per credential and for anonymous ingress', async () => {
    await bind(cookie(), sub(1));
    let limited = 0;
    for (let i = 0; i < 8; i++)
      if ((await doRenew(cookie(), renewBody(90 + i, 91 + i))).status === 429)
        limited++;
    expect(limited).toBe(2);
    let anonymous = 0;
    for (let i = 0; i < 8; i++)
      if ((await doRenew({}, renewBody(1, 2))).status === 429) anonymous++;
    expect(anonymous).toBe(2);
  });

  it('returns 503 when push sealing is not configured', async () => {
    await bind(cookie(), sub(1));
    delete process.env.GUEST_PUSH_SEAL_SECRET;
    expect((await doRenew(cookie(), renewBody(1, 2))).status).toBe(503);
  });
});
