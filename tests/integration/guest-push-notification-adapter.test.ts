import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueNotificationProducer } from '../../src/modules/notification-domain';
import { NotificationOutboxRepository } from '../../src/modules/notification-outbox';
import {
  createQueueNotificationDispatchService,
  loadPushRuntimeDeps,
} from '../../src/modules/guest-push/dispatch-runtime';
import {
  WebPushTransport,
  pushTopic,
  type PushFetch,
} from '../../src/modules/guest-push/push-transport';
import { PushNotificationProviderAdapter } from '../../src/modules/guest-push/push-notification-adapter';
import { PushSubscriptionSealer } from '../../src/modules/guest-push/subscription-seal';
import { GuestPushSubscriptionStore } from '../../src/modules/guest-push/subscription-store';
import { NotificationPreferenceRepository } from '../../src/modules/notification-preferences';
import {
  checkVapid,
  decryptAes128gcm,
  newSubscriber,
} from '../fixtures/fake-push-service';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const sealer = new PushSubscriptionSealer(
  'test-only-push-seal-secret-0123456789abcdef',
);
const T0 = new Date();
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
const target = { clinicId: ids.clinic, queueEntryId: ids.entry };
let event = 0;

function pushService(status: number) {
  const seen: { url: string; headers: Record<string, string>; body: Buffer }[] =
    [];
  const fetchImpl: PushFetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    return { status, headers: { get: () => null } };
  };
  const service = createQueueNotificationDispatchService(pool, {
    sealer,
    transport: new WebPushTransport(vapid, fetchImpl),
  });
  return { seen, service };
}

async function produce(
  eventKey: 'queue_entry_created' | 'patient_called' | 'queue_entry_cancelled',
) {
  event += 1;
  return new QueueNotificationProducer(
    new NotificationOutboxRepository(pool),
  ).produce({
    clinicId: ids.clinic,
    queueEntryId: ids.entry,
    sourceEventId: `push-notif-${event}`,
    sourceVersion: event,
    notification: { eventKey, locale: 'fr' },
  });
}
const stateOf = async (id: string) =>
  (
    await pool.query(
      'SELECT state, dispatch_outcome_code FROM notification_outbox WHERE id=$1',
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
  await pool.query(`TRUNCATE notification_outbox,notification_preference_receipts,
    guest_link_intents,guest_push_subscriptions,
    notification_preferences,guest_exchange_ids,audit_events,queue_entries,
    patient_operational_records,consultation_sessions,doctor_clinics,
    doctor_profiles,clinic_memberships,clinics,users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'push-notif','Doctor')`,
    [ids.user],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'push-notif','Push Notif')`,
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

describe('push notification adapter through queue dispatch, real PostgreSQL (#902)', () => {
  it('delivers the exact status payload with per-template TTL and urgency, and consent comes from the binding', async () => {
    const sub = newSubscriber('https://fcm.googleapis.com/fcm/send/status-1');
    await bindings.subscribe(target, sub.subscription, 'fr', T0);
    const { seen, service } = pushService(201);

    const created = await produce('queue_entry_created');
    const r1 = await service.dispatchOne({
      clinicId: ids.clinic,
      intentId: created.id,
    });
    expect(r1).toMatchObject({
      status: 'completed',
      providerResult: { kind: 'delivered', code: 'push_delivered' },
    });
    expect(Number(seen[0]!.headers.TTL)).toBe(600);
    expect(seen[0]!.headers.Urgency).toBe('normal');
    expect(
      checkVapid(seen[0]!.headers.Authorization!, vapid.publicKey).sub,
    ).toBe(vapid.subject);
    expect(seen[0]!.headers.Topic).toBe(
      pushTopic(
        (r1 as { providerIdempotencyKey: string }).providerIdempotencyKey,
      ),
    );
    const payload = decryptAes128gcm(seen[0]!.body, sub) as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).sort()).toEqual([
      'body',
      'kind',
      'tag',
      'title',
      'url',
      'v',
    ]);
    expect(payload).toMatchObject({
      v: 1,
      kind: 'status',
      title: 'Tabibi',
      url: '/guest/status',
      tag: 'queue_entry_created.v1',
    });

    const called = await produce('patient_called');
    await service.dispatchOne({ clinicId: ids.clinic, intentId: called.id });
    expect(seen[1]!.headers.Urgency).toBe('high');
    expect(Number(seen[1]!.headers.TTL)).toBe(600);

    const cancelled = await produce('queue_entry_cancelled');
    await service.dispatchOne({ clinicId: ids.clinic, intentId: cancelled.id });
    expect(Number(seen[2]!.headers.TTL)).toBe(1800);
    expect(seen[2]!.headers.Urgency).toBe('normal');
  });

  it('a 410 dead-letters the intent and revokes and scrubs the binding', async () => {
    await bindings.subscribe(
      target,
      newSubscriber('https://fcm.googleapis.com/fcm/send/status-2')
        .subscription,
      'fr',
      T0,
    );
    const { service } = pushService(410);
    const intent = await produce('queue_entry_created');
    const result = await service.dispatchOne({
      clinicId: ids.clinic,
      intentId: intent.id,
    });
    expect(result).toMatchObject({
      providerResult: {
        kind: 'terminal_failure',
        code: 'push_subscription_gone',
      },
    });
    expect(await binding()).toEqual({
      revocation_reason: 'gone',
      sealed_subscription: null,
    });
  });

  it('maps 403 to a terminal rejection and 503 to a retryable failure without revoking', async () => {
    await bindings.subscribe(
      target,
      newSubscriber('https://fcm.googleapis.com/fcm/send/status-3')
        .subscription,
      'fr',
      T0,
    );
    const rejected = await pushService(403).service.dispatchOne({
      clinicId: ids.clinic,
      intentId: (await produce('queue_entry_created')).id,
    });
    expect(rejected).toMatchObject({
      providerResult: { kind: 'terminal_failure', code: 'push_rejected' },
    });
    const unavailable = await pushService(503).service.dispatchOne({
      clinicId: ids.clinic,
      intentId: (await produce('queue_entry_created')).id,
    });
    expect(unavailable).toMatchObject({
      providerResult: { kind: 'retryable_failure', code: 'push_unavailable' },
    });
    expect((await binding()).revocation_reason).toBeNull();
  });

  it('honours the push service Retry-After by lengthening the outbox back-off', async () => {
    await bindings.subscribe(
      target,
      newSubscriber('https://fcm.googleapis.com/fcm/send/retry-after')
        .subscription,
      'fr',
      T0,
    );
    const dispatchWith = async (retryAfter: string | null) => {
      const service = createQueueNotificationDispatchService(pool, {
        sealer,
        transport: new WebPushTransport(vapid, async () => ({
          status: 429,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'retry-after' ? retryAfter : null,
          },
        })),
      });
      const execution = await service.dispatchOne({
        clinicId: ids.clinic,
        intentId: (await produce('queue_entry_created')).id,
      });
      expect(execution.status).toBe('completed');
      const done = execution as Extract<
        typeof execution,
        { status: 'completed' }
      >;
      expect(done.providerResult).toMatchObject({
        kind: 'retryable_failure',
        code: 'push_unavailable',
      });
      return (
        new Date(done.intent.nextAttemptAt!).getTime() -
        new Date(done.intent.dispatchOutcomeAt!).getTime()
      );
    };
    expect(await dispatchWith('900')).toBe(900_000);
    expect(await dispatchWith('5')).toBe(60_000);
    expect(await dispatchWith(null)).toBe(60_000);
    expect(await dispatchWith('999999999')).toBe(4 * 3_600_000);
    expect((await binding()).revocation_reason).toBeNull();
  });

  it('keeps in-app routing and never contacts the push service without an active binding', async () => {
    await new NotificationPreferenceRepository(pool).change({
      clinicId: ids.clinic,
      subjectKind: 'visit_patient',
      subjectId: ids.patient,
      channel: 'in_app',
      preferenceState: 'enabled',
      consentState: 'not_required',
      idempotencyKey: 'push-notif-inapp',
    });
    const { seen, service } = pushService(201);
    const result = await service.dispatchOne({
      clinicId: ids.clinic,
      intentId: (await produce('queue_entry_created')).id,
    });
    expect(result).toMatchObject({
      providerResult: { kind: 'delivered', code: 'in_app_persisted' },
    });
    expect(seen).toHaveLength(0);
  });

  it('never pushes after the patient of the entry changes (consent is evaluated for the resolved patient)', async () => {
    const sub = newSubscriber('https://fcm.googleapis.com/fcm/send/status-4');
    await bindings.subscribe(target, sub.subscription, 'fr', T0);
    const other = randomUUID();
    await pool.query(
      `INSERT INTO patient_operational_records(id,clinic_id,private_display_name)
       VALUES($1,$2,'Other')`,
      [other, ids.clinic],
    );
    await pool.query(`UPDATE queue_entries SET patient_id=$1 WHERE id=$2`, [
      other,
      ids.entry,
    ]);
    const { seen, service } = pushService(201);
    const result = await service.dispatchOne({
      clinicId: ids.clinic,
      intentId: (await produce('queue_entry_created')).id,
    });
    // Resolved subject is the new patient: the old patient's consent does
    // not apply, so the dispatch is suppressed or stays in-app, never pushed.
    expect(seen).toHaveLength(0);
    expect(result.status).not.toBe('not_claimed');
  });

  it('does not log, audit or expose endpoint, keys or the sealed value in the outcome', async () => {
    const sub = newSubscriber(
      'https://fcm.googleapis.com/fcm/send/secret-endpoint-5',
    );
    await bindings.subscribe(target, sub.subscription, 'fr', T0);
    const { service } = pushService(201);
    const intent = await produce('queue_entry_created');
    const result = await service.dispatchOne({
      clinicId: ids.clinic,
      intentId: intent.id,
    });
    const haystack = JSON.stringify([
      result,
      (await pool.query('SELECT * FROM notification_outbox')).rows,
      (await pool.query('SELECT * FROM audit_events')).rows,
    ]);
    expect(haystack).not.toContain('secret-endpoint-5');
    expect(haystack).not.toContain(sub.subscription.keys.p256dh);
    expect(haystack).not.toContain(sub.subscription.keys.auth);
    expect(await stateOf(intent.id)).toMatchObject({ state: 'delivered' });
  });

  it('sends only the generic template title as the body, never the queue position', async () => {
    const sub = newSubscriber('https://fcm.googleapis.com/fcm/send/status-6');
    await bindings.subscribe(target, sub.subscription, 'fr', T0);
    const { seen, service } = pushService(201);
    event += 1;
    const intent = await new QueueNotificationProducer(
      new NotificationOutboxRepository(pool),
    ).produce({
      clinicId: ids.clinic,
      queueEntryId: ids.entry,
      sourceEventId: `push-notif-${event}`,
      sourceVersion: event,
      notification: { eventKey: 'turn_approaching', locale: 'fr', position: 7 },
    });
    await service.dispatchOne({ clinicId: ids.clinic, intentId: intent.id });
    const payload = decryptAes128gcm(seen[0]!.body, sub) as { body: string };
    expect(payload.body).toBe('Votre tour approche');
    expect(payload.body).not.toMatch(/\d/);
    expect(seen[0]!.headers.Urgency).toBe('high');
  });

  it('keeps the intent retryable when revoking a gone binding fails', async () => {
    await bindings.subscribe(
      target,
      newSubscriber('https://fcm.googleapis.com/fcm/send/status-7')
        .subscription,
      'fr',
      T0,
    );
    const failingPool = {
      query: (sql: string, params?: unknown[]) =>
        /^\s*UPDATE guest_push_subscriptions/.test(sql)
          ? Promise.reject(new Error('db down'))
          : pool.query(sql, params),
    } as unknown as Pool;
    const adapter = new PushNotificationProviderAdapter({
      pool: failingPool,
      sealer,
      transport: new WebPushTransport(vapid, async () => ({
        status: 410,
        headers: { get: () => null },
      })),
    });
    const result = await adapter.dispatch(
      {
        channel: 'push',
        locale: 'fr',
        direction: 'ltr',
        templateId: 'queue_entry_created.v1',
        title: 'Ajout à la file d’attente',
        body: 'x',
        providerIdempotencyKey: 'k',
      },
      {
        clinicId: ids.clinic,
        queueEntryId: ids.entry,
        deliveryContext: {
          target: {
            subjectKind: 'visit_patient',
            subjectId: ids.patient,
            channel: 'push',
          },
          preference: null,
        },
      },
    );
    expect(result).toEqual({
      kind: 'retryable_failure',
      code: 'push_revocation_failure',
    });
    expect((await binding()).revocation_reason).toBeNull();
  });

  describe('adapter error paths', () => {
    const request = {
      channel: 'push' as const,
      locale: 'fr' as const,
      direction: 'ltr' as const,
      templateId: 'queue_entry_created.v1' as const,
      title: 'Ajout à la file d’attente',
      body: 'x',
      providerIdempotencyKey: 'k',
    };
    const dispatchContext = () => ({
      clinicId: ids.clinic,
      queueEntryId: ids.entry,
      deliveryContext: {
        target: {
          subjectKind: 'visit_patient' as const,
          subjectId: ids.patient,
          channel: 'push' as const,
        },
        preference: null,
      },
    });
    const okTransport = new WebPushTransport(vapid, async () => ({
      status: 201,
      headers: { get: () => null },
    }));

    it.each([
      [400, 'terminal_failure', 'push_rejected', false],
      [403, 'terminal_failure', 'push_rejected', false],
      [413, 'terminal_failure', 'push_rejected', false],
      [404, 'terminal_failure', 'push_subscription_gone', true],
      [410, 'terminal_failure', 'push_subscription_gone', true],
      [429, 'retryable_failure', 'push_unavailable', false],
      [500, 'retryable_failure', 'push_unavailable', false],
      [503, 'retryable_failure', 'push_unavailable', false],
      [302, 'terminal_failure', 'push_rejected', false],
      [202, 'delivered', 'push_delivered', false],
    ] as const)(
      'maps push service status %i to %s %s (binding revoked: %s)',
      async (status, kind, code, revoked) => {
        await bindings.subscribe(
          target,
          newSubscriber(`https://fcm.googleapis.com/fcm/send/map-${status}`)
            .subscription,
          'fr',
          T0,
        );
        const adapter = new PushNotificationProviderAdapter({
          pool,
          sealer,
          transport: new WebPushTransport(vapid, async () => ({
            status,
            headers: { get: () => null },
          })),
        });
        expect(await adapter.dispatch(request, dispatchContext())).toEqual({
          kind,
          code,
        });
        expect((await binding()).revocation_reason).toBe(
          revoked ? 'gone' : null,
        );
      },
    );

    it('returns a retryable failure when the binding lookup fails', async () => {
      const adapter = new PushNotificationProviderAdapter({
        pool: {
          query: () => Promise.reject(new Error('db down')),
        } as unknown as Pool,
        sealer,
        transport: okTransport,
      });
      expect(await adapter.dispatch(request, dispatchContext())).toEqual({
        kind: 'retryable_failure',
        code: 'push_binding_lookup_failure',
      });
    });

    it('dead-letters as no_channel when the sealed binding cannot be opened, without sending', async () => {
      await bindings.subscribe(
        target,
        newSubscriber('https://fcm.googleapis.com/fcm/send/status-8')
          .subscription,
        'fr',
        T0,
      );
      let sent = 0;
      const adapter = new PushNotificationProviderAdapter({
        pool,
        sealer: new PushSubscriptionSealer(
          'a-different-seal-secret-0123456789abcdef',
        ),
        transport: {
          send: async () => {
            sent += 1;
            return { kind: 'delivered' as const };
          },
        },
      });
      expect(await adapter.dispatch(request, dispatchContext())).toEqual({
        kind: 'terminal_failure',
        code: 'push_no_channel',
      });
      expect(sent).toBe(0);
      // Positive control: the right sealer opens the same binding and sends.
      const control = new PushNotificationProviderAdapter({
        pool,
        sealer,
        transport: okTransport,
      });
      expect(await control.dispatch(request, dispatchContext())).toMatchObject({
        kind: 'delivered',
      });
    });

    it('reports unknown on a network failure or timeout and keeps the binding', async () => {
      await bindings.subscribe(
        target,
        newSubscriber('https://fcm.googleapis.com/fcm/send/status-9')
          .subscription,
        'fr',
        T0,
      );
      const adapter = new PushNotificationProviderAdapter({
        pool,
        sealer,
        transport: new WebPushTransport(vapid, async () => {
          throw new Error('ETIMEDOUT');
        }),
      });
      expect(await adapter.dispatch(request, dispatchContext())).toEqual({
        kind: 'unknown',
        code: 'push_unknown',
      });
      expect((await binding()).revocation_reason).toBeNull();
    });
  });

  it('registers push only when VAPID and the seal secret are both configured', () => {
    expect(loadPushRuntimeDeps(null, sealer)).toBeUndefined();
    expect(loadPushRuntimeDeps(vapid, null)).toBeUndefined();
    expect(loadPushRuntimeDeps(vapid, sealer)).toBeDefined();
  });
});
