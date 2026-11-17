import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GuestLinkEnvelope } from '../../src/modules/guest-access/link-envelope';
import { GuestLinkIntentStore } from '../../src/modules/guest-access/link-intents';
import { composeWorkerChannels } from '../../src/modules/guest-push/worker-composition';
import { runDispatchTick } from '../../src/modules/notification-domain/dispatch-worker';
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
// Real time: the composed sender uses the system clock.
const T0 = new Date();
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

function channels(configured: boolean) {
  const seen: { url: string; body: Buffer }[] = [];
  const fetchImpl: PushFetch = async (url, init) => {
    seen.push({ url, body: init.body });
    return { status: 201, headers: { get: () => null } };
  };
  const built = composeWorkerChannels(
    pool,
    configured
      ? { sealer, transport: new WebPushTransport(vapid, fetchImpl) }
      : undefined,
  );
  return { seen, ...built };
}
const tick = (linkSender: ReturnType<typeof channels>['linkSender']) =>
  runDispatchTick({
    pool,
    outboxRunner: {
      run: async () => ({
        claimed: 0,
        delivered: 0,
        retried: 0,
        deadLettered: 0,
        suppressed: 0,
        errors: 0,
      }),
    },
    linkStore: intents,
    linkSender,
  });
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

describe('notification worker channel registry, real PostgreSQL (#947)', () => {
  it('registers a link sender only when push is configured', () => {
    expect(channels(false).linkSender).toBeUndefined();
    expect(channels(true).linkSender).toBeTypeOf('function');
    expect(channels(false).dispatchService).toBeDefined();
  });

  it('delivers a pending guest-link intent over push through a worker tick', async () => {
    const sub = newSubscriber('https://fcm.googleapis.com/fcm/send/worker-1');
    await bindings.subscribe(target, sub.subscription, 'fr', T0);
    const { seen, linkSender } = channels(true);
    const id = await create();
    const counts = await tick(linkSender);
    expect(counts.delivered).toBe(1);
    expect(seen).toHaveLength(1);
    expect(decryptAes128gcm(seen[0]!.body, sub)).toMatchObject({
      kind: 'link',
      url: `/api/guest/exchange/${EXCHANGE}`,
    });
    expect(await stateOf(id)).toEqual({
      state: 'delivered',
      envelope_ciphertext: null,
    });
  });

  it('positive control: without push configuration the intent stays pending and nothing is sent', async () => {
    const sub = newSubscriber('https://fcm.googleapis.com/fcm/send/worker-2');
    await bindings.subscribe(target, sub.subscription, 'fr', T0);
    const { seen, linkSender } = channels(false);
    const id = await create();
    const counts = await tick(linkSender);
    expect(counts.delivered).toBe(0);
    expect(counts.claimed).toBe(0);
    expect(seen).toHaveLength(0);
    expect((await stateOf(id)).state).toBe('pending');
  });
});
