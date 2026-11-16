import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GuestLinkEnvelope } from '../../src/modules/guest-access/link-envelope';
import { GuestLinkIntentStore } from '../../src/modules/guest-access/link-intents';
import { createPushGuestLinkSender } from '../../src/modules/guest-push/push-link-sender';
import {
  WebPushTransport,
  pushTopic,
  type PushFetch,
} from '../../src/modules/guest-push/push-transport';
import { pushLinkMaterial } from '../../src/modules/guest-push/push-link-material';
import { PushSubscriptionSealer } from '../../src/modules/guest-push/subscription-seal';
import { GuestPushSubscriptionStore } from '../../src/modules/guest-push/subscription-store';
import {
  checkVapid,
  decryptAes128gcm,
  newSubscriber,
} from '../fixtures/fake-push-service';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const sealer = new PushSubscriptionSealer(
  'test-only-push-seal-secret-0123456789abcdef',
);
const T0 = new Date('2026-09-09T10:00:00Z');
let now = T0;
const clock = () => now;
const intents = new GuestLinkIntentStore(
  pool,
  new GuestLinkEnvelope('y'.repeat(48), clock),
  clock,
);
const bindings = new GuestPushSubscriptionStore(pool, sealer);
const vapidKeys = webpush.generateVAPIDKeys();
const vapid = { ...vapidKeys, subject: 'mailto:ops@example.org' };
const ids = {
  clinic: randomUUID(),
  user: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  entry: randomUUID(),
  patient: randomUUID(),
};
const EXCHANGE = randomBytes(32).toString('base64url');
const target = { clinicId: ids.clinic, queueEntryId: ids.entry };

function pushService(status: number) {
  const seen: { url: string; headers: Record<string, string>; body: Buffer }[] =
    [];
  const fetchImpl: PushFetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    return { status, headers: { get: () => null } };
  };
  const sender = createPushGuestLinkSender({
    pool,
    sealer,
    transport: new WebPushTransport(vapid, fetchImpl),
    clock,
  });
  return { seen, sender };
}
const create = (deadlineMs = 10 * 60_000, material = EXCHANGE) =>
  intents.create({
    clinicId: ids.clinic,
    queueEntryId: ids.entry,
    intent: 'resend',
    material,
    exchangeExpiresAt: new Date(T0.getTime() + deadlineMs),
  });
const stateOf = async (id: string) =>
  (
    await pool.query(
      'SELECT state, envelope_ciphertext FROM guest_link_intents WHERE id=$1',
      [id],
    )
  ).rows[0];
const binding = async () =>
  (
    await pool.query(
      `SELECT revocation_reason, sealed_subscription FROM guest_push_subscriptions
        WHERE queue_entry_id=$1`,
      [ids.entry],
    )
  ).rows[0];

beforeAll(async () => migrate());
afterAll(async () => pool.end());
beforeEach(async () => {
  now = T0;
  await pool.query(`TRUNCATE guest_link_intents,guest_push_subscriptions,
    notification_preferences,guest_exchange_ids,audit_events,queue_entries,
    patient_operational_records,consultation_sessions,doctor_clinics,
    doctor_profiles,clinic_memberships,clinics,users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'push-send','Doctor')`,
    [ids.user],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'push-send','Push Send')`,
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
     VALUES($1,$2,$3,'2026-09-09','2026-09-09T09:00Z','2026-09-09T12:00Z','open')`,
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

describe('push guest-link sender, real PostgreSQL (#886)', () => {
  it('delivers an encrypted link payload to the bound subscription and scrubs the intent', async () => {
    const sub = newSubscriber('https://fcm.googleapis.com/fcm/send/dev-1');
    await bindings.subscribe(target, sub.subscription, 'fr', T0);
    const { seen, sender } = pushService(201);
    const id = await create();
    expect(await intents.dispatchNext(sender)).toBe('delivered');
    expect(seen).toHaveLength(1);
    const { headers, body } = seen[0]!;
    expect(checkVapid(headers.Authorization!, vapid.publicKey).sub).toBe(
      vapid.subject,
    );
    expect(headers.Topic).toBe(pushTopic(id));
    expect(headers.Topic).not.toContain(id);
    expect(Number(headers.TTL)).toBe(600);
    expect(decryptAes128gcm(body, sub)).toEqual({
      v: 1,
      kind: 'link',
      title: 'Tabibi',
      body: 'Touchez pour ouvrir votre suivi.',
      url: `/api/guest/exchange/${EXCHANGE}`,
      tag: 'link',
    });
    expect(body.toString('utf8')).not.toContain(EXCHANGE);
    expect(await stateOf(id)).toEqual({
      state: 'delivered',
      envelope_ciphertext: null,
    });
  });

  it('never lets the TTL outlive the exchange and refuses under 60 seconds', async () => {
    const sub = newSubscriber('https://fcm.googleapis.com/fcm/send/dev-2');
    await bindings.subscribe(target, sub.subscription, 'fr', T0);
    const short = pushService(201);
    await create(150_000);
    expect(await intents.dispatchNext(short.sender)).toBe('delivered');
    expect(Number(short.seen[0]!.headers.TTL)).toBe(150);

    const tooLate = pushService(201);
    const id = await create(50_000);
    expect(await intents.dispatchNext(tooLate.sender)).toBe('dead_letter');
    expect(tooLate.seen).toHaveLength(0);
    expect((await stateOf(id)).envelope_ciphertext).toBeNull();
  });

  it('dead-letters at once as no_channel when the entry has no active binding', async () => {
    const { seen, sender } = pushService(201);
    const id = await create();
    expect(await intents.dispatchNext(sender)).toBe('dead_letter');
    expect(seen).toHaveLength(0);
    expect(await stateOf(id)).toEqual({
      state: 'dead_letter',
      envelope_ciphertext: null,
    });
  });

  it('a 410 dead-letters the intent and revokes and scrubs the binding as gone', async () => {
    const sub = newSubscriber('https://fcm.googleapis.com/fcm/send/dev-3');
    await bindings.subscribe(target, sub.subscription, 'fr', T0);
    const { sender } = pushService(410);
    const id = await create();
    expect(await intents.dispatchNext(sender)).toBe('dead_letter');
    expect((await stateOf(id)).state).toBe('dead_letter');
    expect(await binding()).toEqual({
      revocation_reason: 'gone',
      sealed_subscription: null,
    });
  });

  it('a 403 dead-letters without revoking the binding', async () => {
    const sub = newSubscriber('https://fcm.googleapis.com/fcm/send/dev-4');
    await bindings.subscribe(target, sub.subscription, 'fr', T0);
    const { sender } = pushService(403);
    const id = await create();
    expect(await intents.dispatchNext(sender)).toBe('dead_letter');
    expect((await stateOf(id)).state).toBe('dead_letter');
    expect((await binding()).revocation_reason).toBeNull();
  });

  it('a 503 stays retryable with the same idempotency key, then delivers', async () => {
    const sub = newSubscriber('https://fcm.googleapis.com/fcm/send/dev-5');
    await bindings.subscribe(target, sub.subscription, 'fr', T0);
    const down = pushService(503);
    const id = await create();
    expect(await intents.dispatchNext(down.sender, { backoffMs: 1000 })).toBe(
      'retry_scheduled',
    );
    expect((await stateOf(id)).state).toBe('pending');
    now = new Date(T0.getTime() + 5_000);
    const up = pushService(201);
    expect(await intents.dispatchNext(up.sender)).toBe('delivered');
    expect(up.seen[0]!.headers.Topic).toBe(down.seen[0]!.headers.Topic);
  });

  it('leaks no endpoint, key or exchange id into the intent row or errors', async () => {
    const sub = newSubscriber('https://fcm.googleapis.com/fcm/send/dev-6');
    await bindings.subscribe(target, sub.subscription, 'fr', T0);
    const { sender } = pushService(410);
    const id = await create();
    await intents.dispatchNext(sender);
    const dump = JSON.stringify([
      (await pool.query('SELECT * FROM guest_link_intents WHERE id=$1', [id]))
        .rows,
      (await pool.query('SELECT * FROM audit_events')).rows,
    ]);
    for (const secret of [EXCHANGE, 'dev-6', sub.subscription.keys.p256dh]) {
      expect(dump).not.toContain(secret);
    }
  });

  it('delivers a resend only to the binding that asked, never the newest one', async () => {
    const older = newSubscriber('https://fcm.googleapis.com/fcm/send/older');
    const newer = newSubscriber('https://fcm.googleapis.com/fcm/send/newer');
    const a = await bindings.subscribe(target, older.subscription, 'fr', T0);
    await bindings.subscribe(
      target,
      newer.subscription,
      'fr',
      new Date(T0.getTime() + 1000),
    );
    const { seen, sender } = pushService(201);
    await create(10 * 60_000, pushLinkMaterial(EXCHANGE, a.subscriptionId));
    expect(await intents.dispatchNext(sender)).toBe('delivered');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(older.subscription.endpoint);
    expect(decryptAes128gcm(seen[0]!.body, older)).toMatchObject({
      url: `/api/guest/exchange/${EXCHANGE}`,
    });
  });

  it('never falls back to another device when the requesting binding is gone', async () => {
    const older = newSubscriber('https://fcm.googleapis.com/fcm/send/older2');
    const newer = newSubscriber('https://fcm.googleapis.com/fcm/send/newer2');
    const a = await bindings.subscribe(target, older.subscription, 'fr', T0);
    await bindings.subscribe(
      target,
      newer.subscription,
      'fr',
      new Date(T0.getTime() + 1000),
    );
    await bindings.unsubscribe(target, older.subscription.endpoint, T0);
    const { seen, sender } = pushService(201);
    await create(10 * 60_000, pushLinkMaterial(EXCHANGE, a.subscriptionId));
    expect(await intents.dispatchNext(sender)).toBe('dead_letter');
    expect(seen).toHaveLength(0);
  });

  it('without a pinned binding (transfer) uses the most recent one', async () => {
    const older = newSubscriber('https://fcm.googleapis.com/fcm/send/older3');
    const newer = newSubscriber('https://fcm.googleapis.com/fcm/send/newer3');
    await bindings.subscribe(target, older.subscription, 'fr', T0);
    await bindings.subscribe(
      target,
      newer.subscription,
      'fr',
      new Date(T0.getTime() + 1000),
    );
    const { seen, sender } = pushService(201);
    await create();
    expect(await intents.dispatchNext(sender)).toBe('delivered');
    expect(seen[0]!.url).toBe(newer.subscription.endpoint);
  });
});
